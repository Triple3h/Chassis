import type { ActionResult, AuditRecord, CommandDecl, HostInfo, ResultItem } from '@launcher/plugin-manifest'
import type { Disposer, KernelEvent, Middleware, MiddlewareStage, Quicklink } from '../types'

export interface StorageService {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  all(): Promise<Record<string, unknown>>
  clear(): Promise<void>
}

export interface CommandRegistryService {
  register(decl: CommandDecl): Disposer
  update(name: string, patch: Partial<CommandDecl>): void
  list(): CommandDecl[]
  invoke(name: string, args?: unknown): Promise<ActionResult>
}

export interface SearchResultService {
  set(items: ResultItem[], token?: number): void
  append(items: ResultItem[], token?: number): void
  clear(token?: number): void
}

export type FooterButton =
  | { type: 'button'; id: string; label: string; icon?: string; keys?: string[] }
  | {
      type: 'action-panel'
      id: string
      label: string
      icon?: string
      keys?: string[]
      title?: string
      items: Array<{ id: string; name: string; icon?: string }>
    }

export interface HostUiService {
  getSearchContent(): Promise<string>
  setSearchContent(value: string): Promise<boolean>
  clearSearchContent(): Promise<boolean>
  setFooter(buttons: FooterButton[]): Promise<boolean>
  hide(): Promise<void>
}

export interface ClipboardService {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export interface ShellService {
  openUrl(url: string): Promise<void>
  openPath(target: string): Promise<void>
  reveal(target: string): Promise<void>
}

export interface ExecService {
  run(opts: { command: string; args?: unknown; timeoutMs?: number }): Promise<unknown>
}

export interface NotifyService {
  show(opts: { title: string; body?: string; silent?: boolean }): Promise<boolean>
}

export interface ScreenshotService {
  start(): Promise<boolean>
}

export interface QuicklinkService {
  all(): Promise<Quicklink[]>
  add(link: Omit<Quicklink, 'id'>): Promise<Quicklink>
  edit(id: string, patch: Partial<Omit<Quicklink, 'id'>>): Promise<void>
  remove(id: string): Promise<void>
}

export interface AuditService {
  record(entry: { method: string; ok: boolean; capability?: string; args?: unknown; error?: unknown }): void
  query(q?: { limit?: number }): AuditRecord[]
}

export interface HostService {
  info(): HostInfo
}

export interface PipelineService {
  use(stage: MiddlewareStage, fn: Middleware, label?: string): Disposer
}

export interface KernelServices {
  storage: StorageService
  commands: CommandRegistryService
  searchResult: SearchResultService
  hostUi: HostUiService
  clipboard: ClipboardService
  shell: ShellService
  exec: ExecService
  notify: NotifyService
  screenshot: ScreenshotService
  quicklink: QuicklinkService
  audit: AuditService
  pipeline: PipelineService
  host: HostService
}

export type ServiceKey = keyof KernelServices

/**
 * 插件可见的 Context（requirements §7.1）。
 * 无能力要求的服务恒在；需要能力的服务在装配期裁剪——未授权时
 * 属性为 undefined 且不出现在 Object.keys（P5：方法不存在）。
 */
export interface PluginContext {
  readonly id: string
  readonly capabilities: ReadonlySet<string>

  readonly storage: StorageService
  readonly commands: CommandRegistryService
  readonly searchResult: SearchResultService
  readonly audit: AuditService
  readonly host: HostService
  readonly pipeline: PipelineService

  readonly hostUi?: HostUiService
  readonly clipboard?: ClipboardService
  readonly shell?: ShellService
  readonly exec?: ExecService
  readonly notify?: NotifyService
  readonly screenshot?: ScreenshotService
  readonly quicklink?: QuicklinkService

  inject(names: ServiceKey[], fn: (ctx: PluginContext) => void | Disposer): Disposer
  effect<T>(fn: () => T | Disposer, label: string): T
  on(event: KernelEvent, fn: (payload: unknown) => void): Disposer
}
