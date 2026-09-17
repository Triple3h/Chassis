import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { LauncherError, scriptEntryCandidates } from '@launcher/plugin-manifest'
import type { ResultItem } from '@launcher/plugin-manifest'
import { pathExists } from '../util/fsx'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 5 * 60_000
const MAX_CONCURRENT_PER_PLUGIN = 4
const SEARCH_IDLE_MS = 5 * 60_000

export interface ScriptRuntimeOptions {
  resolvePluginDir: (pluginId: string) => string | undefined
  dataPathFor: (pluginId: string) => string
  dataRoot: string
  /** 插件生效设置（清单声明 + 用户值），worker 启动时注入 `ctx().settings` */
  settingsFor: (pluginId: string) => Record<string, string | boolean>
  log: (level: 'info' | 'debug' | 'warn' | 'error', message: string, data?: unknown) => void
  /** 连续失败计数回调（连续 3 次 → degraded） */
  onFailure: (pluginId: string, command: string) => void
  /** 脚本侧 RPC（`@launcher/api-node` 的 storage 等） */
  handleRpc?: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<unknown>
}

interface Waiting {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

interface RpcMessage {
  type: 'rpc'
  id?: number
  method?: string
  params?: Record<string, unknown>
}

interface SearchWorker {
  worker: Worker
  pluginId: string
  command: string
  pending: Map<number, Waiting>
  idleTimer: NodeJS.Timeout | null
}

/** 脚本命令运行时（worker_threads），见 requirements §4.1 / §7.3 / plugin-spec §4.2 */
export class ScriptRuntime {
  private searchWorkers = new Map<string, SearchWorker>()
  private active = new Map<string, number>()
  private queue = new Map<string, Array<() => void>>()
  private closed = false

  constructor(private readonly opts: ScriptRuntimeOptions) {}

  /** 产物查找顺序：`<name>.mjs` → `<name>.js` → `workers/<name>.mjs` → `workers/<name>.js` */
  async resolveEntry(pluginId: string, command: string): Promise<string | null> {
    const dir = this.opts.resolvePluginDir(pluginId)
    if (!dir) return null
    for (const candidate of scriptEntryCandidates(command)) {
      const abs = path.join(dir, candidate)
      if (await pathExists(abs)) return abs
    }
    return null
  }

  /** 一次性执行 no-view / script 命令 */
  async run(pluginId: string, command: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    const entry = await this.resolveEntry(pluginId, command)
    if (!entry) throw new LauncherError('ENTRY_MISSING', `未找到脚本产物：${command}.mjs`)

    const release = await this.acquire(pluginId)
    try {
      return await this.runWorker(entry, pluginId, command, args, normalizeTimeout(timeoutMs))
    } finally {
      release()
    }
  }

  /** 贡献型搜索：常驻 worker 复用（搜索每 80ms 触发一次，不能每次冷启动） */
  async querySearchSource(
    pluginId: string,
    command: string,
    query: string,
    timeoutMs: number,
    token: number,
  ): Promise<ResultItem[] | null> {
    const key = `${pluginId}:${command}`
    let entry: SearchWorker | null
    try {
      entry = await this.ensureSearchWorker(key, pluginId, command)
    } catch (err) {
      this.opts.log('warn', `搜索 worker 启动失败：${key}`, err)
      return null
    }
    if (!entry) return null

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }

    const worker = entry.worker
    const result = await new Promise<ResultItem[] | null>((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(token)
        resolve(null)
      }, Math.max(50, timeoutMs))
      timer.unref?.()
      entry.pending.set(token, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(Array.isArray(value) ? (value as ResultItem[]) : null)
        },
        reject: () => {
          clearTimeout(timer)
          resolve(null)
        },
      })
      try {
        worker.postMessage({ type: 'query', token, query })
      } catch {
        clearTimeout(timer)
        entry.pending.delete(token)
        resolve(null)
      }
    })

    this.touchIdle(key, entry)
    return result
  }

  /** 脚本侧 RPC（storage 等），统一走宿主服务（P6：可审计） */
  private async handleRpcMessage(worker: Worker, pluginId: string, msg: RpcMessage): Promise<void> {
    const id = Number(msg.id ?? 0)
    const method = String(msg.method ?? '')
    const params = (msg.params ?? {}) as Record<string, unknown>
    const reply = (ok: boolean, payload: { data?: unknown; error?: { code?: string; message?: string } }): void => {
      try {
        worker.postMessage({ type: 'rpc-result', id, ok, ...payload })
      } catch {
        /* worker 已退出 */
      }
    }
    const handler = this.opts.handleRpc
    if (!handler) {
      reply(false, { error: { code: 'NOT_FOUND', message: '宿主未提供脚本 RPC' } })
      return
    }
    try {
      reply(true, { data: await handler(pluginId, method, params) })
    } catch (err) {
      reply(false, { error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } })
    }
  }

  /**
   * 预热贡献型搜索 worker（插件激活后调用）：
   * 让用户的第一次输入就有结果，而不是先吃一次冷启动超时。
   */
  async prewarm(pluginId: string, command: string): Promise<void> {
    const key = `${pluginId}:${command}`
    if (this.searchWorkers.has(key) || this.closed) return
    try {
      await this.ensureSearchWorker(key, pluginId, command)
    } catch (err) {
      this.opts.log('warn', `搜索 worker 预热失败：${key}`, err)
    }
  }

  /** 插件停用 / 卸载时回收其全部 worker */
  releasePlugin(pluginId: string): void {
    for (const [key, entry] of [...this.searchWorkers]) {
      if (entry.pluginId !== pluginId) continue
      void this.destroySearchWorker(key, entry)
    }
    this.queue.delete(pluginId)
  }

  async shutdown(): Promise<void> {
    this.closed = true
    const all = [...this.searchWorkers.entries()]
    this.searchWorkers.clear()
    await Promise.all(all.map(([key, entry]) => this.destroySearchWorker(key, entry)))
  }

  private async ensureSearchWorker(key: string, pluginId: string, command: string): Promise<SearchWorker | null> {
    const existing = this.searchWorkers.get(key)
    if (existing) return existing
    const entryPath = await this.resolveEntry(pluginId, command)
    if (!entryPath) return null

    const worker = new Worker(pathToFileURL(entryPath), {
      workerData: this.workerData(pluginId, command, undefined, 'search'),
      stdout: true,
      stderr: true,
    })
    const entry: SearchWorker = {
      worker,
      pluginId,
      command,
      pending: new Map(),
      idleTimer: null,
    }
    this.searchWorkers.set(key, entry)
    this.pipeOutput(worker, pluginId, command)

    worker.on('message', (msg: { type?: string; token?: number; data?: unknown }) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'result') {
        const waiting = msg.token !== undefined ? entry.pending.get(msg.token) : undefined
        if (waiting) {
          entry.pending.delete(msg.token!)
          waiting.resolve(msg.data)
        } else if (msg.token === undefined) {
          // 无 token 的异步补位（append 语义）——按最近一次查询归属
          const last = [...entry.pending.entries()].pop()
          if (last) {
            entry.pending.delete(last[0])
            last[1].resolve(msg.data)
          }
        }
        return
      }
      if (msg.type === 'rpc') {
        void this.handleRpcMessage(worker, pluginId, msg as RpcMessage)
        return
      }
      if (msg.type === 'log') {
        this.opts.log('debug', `[${pluginId}:${command}] ${String((msg as { message?: unknown }).message ?? '')}`)
      }
    })
    worker.on('error', (err) => {
      this.opts.log('error', `搜索 worker 异常：${key}`, err)
      this.opts.onFailure(pluginId, command)
      for (const [, waiting] of entry.pending) waiting.reject(err)
      entry.pending.clear()
      void this.destroySearchWorker(key, entry)
    })
    worker.on('exit', () => {
      if (this.searchWorkers.get(key) === entry) this.searchWorkers.delete(key)
    })
    return entry
  }

  private touchIdle(key: string, entry: SearchWorker): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    const timer = setTimeout(() => {
      void this.destroySearchWorker(key, entry)
    }, SEARCH_IDLE_MS)
    timer.unref?.()
    entry.idleTimer = timer
  }

  private async destroySearchWorker(key: string, entry: SearchWorker): Promise<void> {
    if (this.searchWorkers.get(key) === entry) this.searchWorkers.delete(key)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    for (const [, waiting] of entry.pending) waiting.reject(new LauncherError('NOT_FOUND', 'worker 已回收'))
    entry.pending.clear()
    try {
      await entry.worker.terminate()
    } catch {
      /* ignore */
    }
  }

  private workerData(pluginId: string, command: string, args: unknown, mode: 'run' | 'search') {
    const pluginPath = this.opts.resolvePluginDir(pluginId) ?? ''
    return {
      command,
      args,
      pluginPath,
      pluginId,
      dataPath: this.opts.dataPathFor(pluginId),
      dataRoot: this.opts.dataRoot,
      mode,
      host: 'launcher',
      // 设置值在 worker 启动时快照一次：用户在设置里改完会重载插件，新值随新 worker 生效
      settings: this.opts.settingsFor(pluginId),
    }
  }

  /** 一次性 worker（搜索路径不在这里，见 `ensureSearchWorker`） */
  private runWorker(
    entryPath: string,
    pluginId: string,
    command: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(pathToFileURL(entryPath), {
        workerData: this.workerData(pluginId, command, args, 'run'),
        stdout: true,
        stderr: true,
      })
      this.pipeOutput(worker, pluginId, command)

      let settled = false
      let resultValue: unknown
      let hasResult = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void worker.terminate()
        this.opts.onFailure(pluginId, command)
        reject(new LauncherError('TIMEOUT', `脚本超时（${timeoutMs}ms）：${command}`))
      }, timeoutMs)
      timer.unref?.()

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        fn()
      }

      worker.on('message', (msg: { type?: string; data?: unknown; level?: string; message?: string }) => {
        if (!msg || typeof msg !== 'object') return
        switch (msg.type) {
          case 'rpc':
            void this.handleRpcMessage(worker, pluginId, msg as RpcMessage)
            break
          case 'result':
            hasResult = true
            resultValue = msg.data
            break
          case 'done':
            finish(() => {
              if (isFailurePayload(resultValue)) {
                this.opts.onFailure(pluginId, command)
                reject(new LauncherError('SCRIPT_ERROR', errorText(resultValue)))
              } else {
                resolve(hasResult ? resultValue : undefined)
              }
            })
            break
          case 'log':
            this.opts.log(
              (msg.level === 'warn' || msg.level === 'error' || msg.level === 'debug' ? msg.level : 'info') as
                | 'info'
                | 'debug'
                | 'warn'
                | 'error',
              `[${pluginId}:${command}] ${msg.message ?? ''}`,
            )
            break
          case 'progress':
            this.opts.log('debug', `[${pluginId}:${command}] progress ${String(msg.data ?? '')}`)
            break
          default:
            break
        }
      })

      worker.on('error', (err) => {
        this.opts.onFailure(pluginId, command)
        finish(() => reject(new LauncherError('SCRIPT_ERROR', err?.message || String(err))))
      })

      worker.on('exit', (code) => {
        if (settled) return
        finish(() => {
          if (code === 0 && hasResult) resolve(resultValue)
          else if (code === 0) resolve(undefined)
          else {
            this.opts.onFailure(pluginId, command)
            reject(new LauncherError('SCRIPT_ERROR', `脚本退出码 ${code}`))
          }
        })
      })
    })
  }

  /** worker 的 stdout/stderr 必须转发到 **stderr**：stdout 是壳的 JSON-RPC 通道 */
  private pipeOutput(worker: Worker, pluginId: string, command: string): void {
    worker.stdout?.on('data', (chunk: Buffer) => {
      this.opts.log('info', `[${pluginId}:${command}] ${chunk.toString().trimEnd()}`)
    })
    worker.stderr?.on('data', (chunk: Buffer) => {
      this.opts.log('warn', `[${pluginId}:${command}] ${chunk.toString().trimEnd()}`)
    })
  }

  private async acquire(pluginId: string): Promise<() => void> {
    const current = this.active.get(pluginId) ?? 0
    if (current < MAX_CONCURRENT_PER_PLUGIN) {
      this.active.set(pluginId, current + 1)
      return () => this.release(pluginId)
    }
    await new Promise<void>((resolve) => {
      const list = this.queue.get(pluginId) ?? []
      list.push(resolve)
      this.queue.set(pluginId, list)
    })
    return () => this.release(pluginId)
  }

  private release(pluginId: string): void {
    const waiting = this.queue.get(pluginId)
    if (waiting && waiting.length > 0) {
      const next = waiting.shift()
      if (waiting.length === 0) this.queue.delete(pluginId)
      next?.()
      return
    }
    const current = this.active.get(pluginId) ?? 1
    this.active.set(pluginId, Math.max(0, current - 1))
  }
}

function normalizeTimeout(timeoutMs?: number): number {
  const value = Number(timeoutMs)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(50, Math.round(value)))
}

function isFailurePayload(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && '__error' in (value as Record<string, unknown>))
}

function errorText(value: unknown): string {
  const raw = (value as { __error?: unknown })?.__error
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return '脚本执行失败'
  }
}
