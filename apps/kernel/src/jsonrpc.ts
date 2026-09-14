import { LauncherError } from '@launcher/plugin-manifest'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: NodeJS.Timeout
}

type RequestHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * 壳 ↔ 内核：stdio + newline-delimited JSON-RPC 2.0（requirements §4.1）。
 * 约定：协议只走 stdout/stdin，日志一律走 stderr。
 */
export class ShellLink {
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, RequestHandler>()
  private buffer = ''
  private nextId = 1
  private started = false
  private connectedFlag = false

  get connected(): boolean {
    return this.connectedFlag
  }

  /** 由壳在握手时调用（内核也可主动探测） */
  markConnected(): void {
    this.connectedFlag = true
  }

  start(streams?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): void {
    if (this.started) return
    this.started = true
    const input = streams?.input ?? process.stdin
    const output = streams?.output ?? process.stdout
    this.output = output

    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.onData(chunk))
    input.on('end', () => this.onClose())
    input.on('error', () => this.onClose())
  }

  private output: NodeJS.WritableStream = process.stdout

  handle(method: string, fn: RequestHandler): () => void {
    this.handlers.set(method, fn)
    return () => this.handlers.delete(method)
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
    if (!this.connectedFlag) {
      throw new LauncherError('NOT_FOUND', `壳未连接，无法调用 ${method}`)
    }
    const id = this.nextId++
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LauncherError('TIMEOUT', `壳调用超时：${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.write(payload)
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.connectedFlag) return
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  private write(payload: unknown): void {
    try {
      this.output.write(`${JSON.stringify(payload)}\n`)
    } catch {
      /* stdout 关闭（壳退出）时静默 */
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.dispatch(line)
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > 1_000_000) this.buffer = ''
  }

  private dispatch(line: string): void {
    let msg: JsonRpcRequest & JsonRpcResponse
    try {
      msg = JSON.parse(line) as JsonRpcRequest & JsonRpcResponse
    } catch {
      return
    }
    if (!msg || msg.jsonrpc !== '2.0') return

    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      // 应答
      const pending = this.pending.get(Number(msg.id))
      if (!pending) return
      this.pending.delete(Number(msg.id))
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new LauncherError('INTERNAL', msg.error.message))
      else pending.resolve(msg.result)
      return
    }

    if (msg.method) {
      const handler = this.handlers.get(msg.method)
      const id = msg.id
      if (!handler) {
        if (id !== undefined && id !== null) {
          this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `方法未实现：${msg.method}` } })
        }
        return
      }
      Promise.resolve()
        .then(() => handler(msg.params ?? {}))
        .then((result) => {
          if (id !== undefined && id !== null) this.write({ jsonrpc: '2.0', id, result: result ?? null })
        })
        .catch((err: unknown) => {
          if (id !== undefined && id !== null) {
            this.write({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            })
          }
        })
    }
  }

  private onClose(): void {
    this.connectedFlag = false
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new LauncherError('NOT_FOUND', '壳连接已断开'))
      this.pending.delete(id)
    }
  }
}
