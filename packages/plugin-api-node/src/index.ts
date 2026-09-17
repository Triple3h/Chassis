/**
 * @launcher/api-node —— script / no-view 产物的运行时 SDK（plugin-spec §8.7）。
 *
 * 消息协议（脚本 → 宿主）：`{type:'log'|'progress'|'result'|'done'}`；
 * `storage` / `onQuery` / `rpc` 是底座的扩展面。
 */
import { parentPort, workerData } from 'node:worker_threads'

export interface NodeContext {
  command: string
  args: unknown
  /** 只读安装目录（N2：不得写入） */
  pluginPath: string
  /** 唯一可写目录（N2） */
  dataPath: string
  dataRoot: string
  pluginId: string
  mode: 'run' | 'search'
  /**
   * 生效的插件设置（清单 `settings` 声明 ∪ 用户值，见 plugin-spec §3.4）。
   *
   * 在 worker 启动时快照一次：用户在设置页改完会重载插件，新值随新 worker 生效 ——
   * 不要在这里面缓存中间态，每次读 `ctx()` 拿的都是本 worker 生命周期内的固定值。
   */
  settings: Record<string, string | boolean>
}

export type LogLevel = 'info' | 'debug' | 'warn' | 'error'

interface HostMessage {
  type?: string
  id?: number
  token?: number
  query?: string
  ok?: boolean
  data?: unknown
  error?: { code?: string; message?: string }
  level?: LogLevel
  message?: string
}

function port(): typeof parentPort {
  return parentPort
}

function send(payload: Record<string, unknown>): void {
  try {
    port()?.postMessage(payload)
  } catch {
    /* 宿主已退出 */
  }
}

/** 运行上下文：全部字段由宿主经 `workerData` 注入（见 apps/kernel/src/services/exec.ts） */
export function ctx(): NodeContext {
  const wd = (workerData ?? {}) as Partial<NodeContext>
  return {
    command: wd.command ?? '',
    args: wd.args,
    pluginPath: wd.pluginPath ?? '',
    dataPath: wd.dataPath ?? '',
    dataRoot: wd.dataRoot ?? '',
    pluginId: wd.pluginId ?? '',
    mode: wd.mode === 'search' ? 'search' : 'run',
    settings: wd.settings && typeof wd.settings === 'object' ? wd.settings : {},
  }
}

export function log(message: string, data?: unknown, level: LogLevel = 'info'): void {
  send({ type: 'log', level, message, data })
}

export function progress(p: number, data?: unknown): void {
  send({ type: 'progress', p: Math.min(1, Math.max(0, Number(p) || 0)), data })
}

/** 正常结束：返回值交给调用方的 `ctx.exec.run` */
export function done(result?: unknown): void {
  send({ type: 'result', data: result })
  send({ type: 'done' })
}

/** 异常结束 */
export function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  send({ type: 'result', data: { __error: message } })
  send({ type: 'done' })
}

/** 先注册，兜住未处理异常（必须在其它逻辑之前调用） */
export function onError(): void {
  process.on('uncaughtException', (err) => fail(err))
  process.on('unhandledRejection', (err) => fail(err))
}

// ── RPC（宿主侧服务）──────────────────────────────────────────
let rpcSeq = 1
const rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function rpc(method: string, params?: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = rpcSeq++
    const timer = setTimeout(() => {
      rpcPending.delete(id)
      reject(new Error(`宿主调用超时：${method}`))
    }, timeoutMs)
    timer.unref?.()
    rpcPending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      },
    })
    send({ type: 'rpc', id, method, params: params ?? {} })
  })
}

port()?.on('message', (msg: HostMessage) => {
  if (!msg || msg.type !== 'rpc-result' || typeof msg.id !== 'number') return
  const entry = rpcPending.get(msg.id)
  if (!entry) return
  rpcPending.delete(msg.id)
  if (msg.ok === false) entry.reject(new Error(msg.error?.message ?? '宿主调用失败'))
  else entry.resolve(msg.data)
})

/** 插件私有 KV（落 `<dataRoot>/plugins/<id>/storage.json`，与 UI 侧同一份数据） */
export const storage = {
  get: <T = unknown>(key: string): Promise<T | undefined> => rpc('storage.get', { key }) as Promise<T | undefined>,
  set: (key: string, value: unknown): Promise<void> => rpc('storage.set', { key, value }) as Promise<void>,
  remove: (key: string): Promise<void> => rpc('storage.remove', { key }) as Promise<void>,
  all: <T = Record<string, unknown>>(): Promise<T> => rpc('storage.all') as Promise<T>,
  clear: (): Promise<void> => rpc('storage.clear') as Promise<void>,
}

/**
 * 贡献型搜索：命令在清单里声明 `contributes: true` 时，宿主会常驻该 worker，
 * 每次输入下发 `{type:'query', query, token}`，脚本返回结果项。
 */
export function onQuery(
  handler: (payload: { query: string; token: number }) => unknown[] | Promise<unknown[]> | void,
): void {
  port()?.on('message', (msg: HostMessage) => {
    if (!msg || msg.type !== 'query') return
    const token = msg.token ?? 0
    try {
      const result = handler({ query: msg.query ?? '', token })
      if (result && typeof (result as Promise<unknown[]>).then === 'function') {
        void (result as Promise<unknown[]>).then((items) => {
          send({ type: 'result', token, data: items })
        })
      } else if (result) {
        send({ type: 'result', token, data: result })
      }
    } catch (err) {
      log(`onQuery 处理失败：${err instanceof Error ? err.message : String(err)}`, undefined, 'error')
    }
  })
}

export default { ctx, log, progress, done, fail, onError, storage, onQuery }
