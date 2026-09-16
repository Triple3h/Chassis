import type { ActionResult, CommandDecl, ResultItem } from '@launcher/plugin-manifest'

export type Disposer = () => void

export type KernelEvent =
  | 'registry/changed'
  | 'plugin/state'
  | 'plugin/reloaded'
  | 'session/closed'
  | 'history/changed'
  | 'pinned/changed'
  | 'search/query'
  | 'search/results'
  | 'ui/searchContent'
  | 'ui/footer'
  | 'ui/hide'
  | 'shell/visibility'

/** 会话为什么被关掉：`reload` 时 UI 应当在插件重载完成后重开该页面 */
export type SessionCloseReason = 'close' | 'ui' | 'reload' | 'disable' | 'uninstall' | 'shutdown'

export interface Session {
  sid: string
  pluginId: string
  command: string
  token: string
  port: number
  origin: string
  createdAt: number
  /** 最近一次搜索广播的 token（searchResult.set 的新鲜度校验） */
  lastSearchToken: number
  /** 当前会话的 footer / 搜索框内容快照 */
  searchContent: string
  footer: unknown
}

export interface SearchSlot {
  token: number
  query: string
  /** pluginId → 结果项 */
  results: Map<string, ResultItem[]>
  /** 已经回过的插件 */
  settled: Set<string>
  closed: boolean
}

export interface ExecContext {
  /** 全局命令 id = `${pluginId}:${command}` */
  id: string
  pluginId: string
  command: string
  mode: CommandDecl['mode']
  args?: unknown
  /** 触发该项的会话（若来自插件页） */
  session?: Session
  /** 调用来源 */
  source: 'ui' | 'plugin' | 'host'
  meta: Record<string, unknown>
}

export type Middleware = (ctx: ExecContext, next: () => Promise<ActionResult>) => Promise<ActionResult>

export type MiddlewareStage = 'pre-execute' | 'execute' | 'post-execute'

export interface Quicklink {
  id: string
  name: string
  url: string
  icon?: string
}
