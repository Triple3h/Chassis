/**
 * @launcher/api —— 插件页侧 SDK（plugin-spec §7）。
 * 所有方法返回 Promise、永不抛原生异常；失败抛 LauncherError { code, message }。
 * 未授权的服务在初始化时被移除（属性不存在，P5）。
 */

export type LauncherErrorCode =
  | 'CAPABILITY_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'BAD_ARGS'
  | 'BUSY'
  | 'INTERNAL'
  | 'SCRIPT_ERROR'
  | 'SESSION_INVALID'
  | 'CONTRACT_VIOLATION'
  | 'FORBIDDEN'

export class LauncherError extends Error {
  readonly code: LauncherErrorCode
  constructor(code: LauncherErrorCode, message: string) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
  }
}

export interface HostInfo {
  version: string
  platform: string
  dataRoot: string
  pluginId: string
  command: string
  sid: string
  capabilities?: string[]
  deniedCapabilities?: string[]
}

export interface ActionResult {
  ok: boolean
  kind: 'view' | 'script' | 'open' | 'copy' | 'host'
  data?: unknown
  error?: { code: string; message: string }
  hideLauncher?: boolean
}

export type ActionDecl =
  | { type: 'command'; command: string; args?: unknown }
  | { type: 'invoke'; pluginId: string; command: string; args?: unknown }
  | { type: 'open'; target: string; targetKind?: 'url' | 'path' | 'app' }
  | { type: 'copy'; text: string }
  | { type: 'host'; method: 'hostUi.setSearchContent' | 'hostUi.hide' }

export interface ResultItem {
  id: string
  title: string
  subtitle?: string
  icon?: string
  score?: number
  action: ActionDecl
  actions?: ActionDecl[]
  detail?: string
}

export type FooterButton =
  | { type: 'button'; label: string; id?: string; icon?: string; keys?: string[]; onClick?: () => void }
  | {
      type: 'action-panel'
      label: string
      id?: string
      icon?: string
      keys?: string[]
      title?: string
      items: Array<{ name: string; id?: string; icon?: string; onSelect?: () => void }>
    }

interface CallOptions {
  timeoutMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: LauncherError) => void
  timer: number
}

const DEFAULT_TIMEOUT = 1200
const pending = new Map<number, Pending>()
const cleanups: Array<() => void> = []
const searchHandlers: Array<(payload: { query: string; token: number }) => ResultItem[] | Promise<ResultItem[]> | void> = []
const footerHandlers = new Map<string, () => void>()

let nextId = 1
let sessionParams: URLSearchParams | null = null
let infoCache: HostInfo | null = null
let readyPromise: Promise<HostInfo> | null = null
let inLauncherCache: boolean | null = null

function params(): URLSearchParams {
  if (!sessionParams) sessionParams = new URLSearchParams(location.search)
  return sessionParams
}

export function isInLauncher(): boolean {
  if (inLauncherCache !== null) return inLauncherCache
  inLauncherCache = window.parent !== window && params().has('sid')
  return inLauncherCache
}

function post(method: string, payload?: Record<string, unknown>, options?: CallOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!isInLauncher()) {
      reject(new LauncherError('NOT_FOUND', '当前不在启动台中运行'))
      return
    }
    const id = nextId++
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new LauncherError('TIMEOUT', `宿主调用超时：${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    const message = {
      __launcher: 1,
      id,
      method,
      token: params().get('token') ?? '',
      params: payload ?? {},
    }
    window.parent.postMessage(message, '*')
  })
}

function handleMessage(event: MessageEvent): void {
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return

  if (data.__launcher === 1 && typeof data.id === 'number') {
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    window.clearTimeout(entry.timer)
    if (data.ok) entry.resolve(data.result)
    else {
      const error = (data.error ?? {}) as { code?: string; message?: string }
      entry.reject(new LauncherError((error.code as LauncherErrorCode) ?? 'INTERNAL', error.message ?? '宿主调用失败'))
    }
    return
  }

  // 事件推送
  const eventName = data.event as string | undefined
  if (!eventName) return
  const payload = (data.payload ?? {}) as { query?: string; token?: number; sid?: string; id?: string }
  if (eventName === 'search/query') {
    for (const handler of searchHandlers) {
      try {
        const result = handler({ query: payload.query ?? '', token: payload.token ?? 0 })
        if (result && typeof (result as Promise<ResultItem[]>).then === 'function') {
          void (result as Promise<ResultItem[]>).then((items) => {
            if (items) void searchResult.set(items, payload.token)
          })
        } else if (result) {
          void searchResult.set(result as ResultItem[], payload.token)
        }
      } catch {
        /* 单个 handler 异常不影响其它 */
      }
    }
    return
  }
  if (eventName === 'footer/click') {
    const handler = footerHandlers.get(String(payload.id ?? ''))
    handler?.()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', handleMessage, false)
}

// ── 命名空间 ───────────────────────────────────────────────────
export const host = {
  isLauncher: (): boolean => isInLauncher(),
  info: async (options?: CallOptions): Promise<HostInfo> => {
    if (infoCache) return infoCache
    if (!readyPromise) {
      readyPromise = (post('ctx.host.info', undefined, options) as Promise<HostInfo>).then((result) => {
        infoCache = result
        applyCapabilityMask(result)
        return result
      })
    }
    return readyPromise
  },
  log: async (level: 'info' | 'debug' | 'warn' | 'error', message: string, data?: unknown): Promise<void> => {
    await post('ctx.log', { level, message, data }).catch(() => undefined)
  },
  /** 当前会话实际被授予的能力（未授权的能力在 SDK 上不存在） */
  capabilities: (): string[] => infoCache?.capabilities ?? [],
}

export const commands = {
  invoke: (payload: { command: string; args?: unknown }, options?: CallOptions): Promise<ActionResult> =>
    post('ctx.commands.invoke', payload as Record<string, unknown>, options) as Promise<ActionResult>,
  close: (options?: CallOptions): Promise<void> => post('ctx.commands.close', undefined, options) as Promise<void>,
  registerAction: (_id: string, _handler: () => void): (() => void) => {
    const off = (): void => undefined
    cleanups.push(off)
    return off
  },
}

export const searchResult = {
  set: (items: ResultItem[], token?: number): Promise<void> =>
    post('ctx.searchResult.set', { items, token }, { timeoutMs: 400 }) as Promise<void>,
  append: (items: ResultItem[], token?: number): Promise<void> =>
    post('ctx.searchResult.append', { items, token }, { timeoutMs: 400 }) as Promise<void>,
  clear: (token?: number): Promise<void> => post('ctx.searchResult.clear', { token }, { timeoutMs: 400 }) as Promise<void>,
}

export const storage = {
  get: <T = unknown>(key: string, options?: CallOptions): Promise<T | undefined> =>
    post('ctx.storage.get', { key }, options) as Promise<T | undefined>,
  set: (key: string, value: unknown, options?: CallOptions): Promise<void> =>
    post('ctx.storage.set', { key, value }, options) as Promise<void>,
  remove: (key: string, options?: CallOptions): Promise<void> =>
    post('ctx.storage.remove', { key }, options) as Promise<void>,
  all: <T = Record<string, unknown>>(options?: CallOptions): Promise<T> => post('ctx.storage.all', undefined, options) as Promise<T>,
  clear: (options?: CallOptions): Promise<void> => post('ctx.storage.clear', undefined, options) as Promise<void>,
}

const searchContentListeners = new Set<(value: string) => void>()

export const hostUi = {
  getSearchContent: (options?: CallOptions): Promise<string> =>
    post('ctx.hostUi.getSearchContent', undefined, options) as Promise<string>,
  setSearchContent: (value: string, options?: CallOptions): Promise<boolean> =>
    post('ctx.hostUi.setSearchContent', { value }, options) as Promise<boolean>,
  clearSearchContent: (options?: CallOptions): Promise<boolean> =>
    post('ctx.hostUi.clearSearchContent', undefined, options) as Promise<boolean>,
  setFooter: async (buttons: FooterButton[], options?: CallOptions): Promise<boolean> => {
    const serialized = buttons.map((button, index) => {
      const id = button.id ?? `${button.type}:${index}`
      if (button.type === 'button') {
        if (button.onClick) footerHandlers.set(id, button.onClick)
        return { type: 'button' as const, id, label: button.label, icon: button.icon, keys: button.keys }
      }
      const items = button.items.map((item, itemIndex) => {
        const itemId = item.id ?? `${id}:${itemIndex}`
        if (item.onSelect) footerHandlers.set(itemId, item.onSelect)
        return { id: itemId, name: item.name, icon: item.icon }
      })
      return {
        type: 'action-panel' as const,
        id,
        label: button.label,
        icon: button.icon,
        keys: button.keys,
        title: button.title,
        items,
      }
    })
    return post('ctx.hostUi.setFooter', { buttons: serialized }, options) as Promise<boolean>
  },
  hide: (options?: CallOptions): Promise<void> => post('ctx.hostUi.hide', undefined, options) as Promise<void>,
  /** 监听宿主搜索框内容变化（入口型搜索） */
  watchSearchContent: (fn: (value: string) => void): (() => void) => {
    searchContentListeners.add(fn)
    const off = (): void => {
      searchContentListeners.delete(fn)
    }
    cleanups.push(off)
    return off
  },
}

export const clipboard = {
  readText: (options?: CallOptions): Promise<string> => post('ctx.clipboard.readText', undefined, options) as Promise<string>,
  writeText: (text: string, options?: CallOptions): Promise<void> =>
    post('ctx.clipboard.writeText', { text }, options) as Promise<void>,
}

export const shell = {
  openUrl: (url: string, options?: CallOptions): Promise<void> => post('ctx.shell.openUrl', { url }, options) as Promise<void>,
  openPath: (path: string, options?: CallOptions): Promise<void> =>
    post('ctx.shell.openPath', { path }, options) as Promise<void>,
  reveal: (path: string, options?: CallOptions): Promise<void> => post('ctx.shell.reveal', { path }, options) as Promise<void>,
}

export const exec = {
  run: (payload: { command: string; args?: unknown; timeoutMs?: number }, options?: CallOptions): Promise<unknown> =>
    post('ctx.exec.run', payload as Record<string, unknown>, { timeoutMs: payload.timeoutMs ?? options?.timeoutMs ?? 15000 }),
}

export const notify = {
  show: (payload: { title: string; body?: string; silent?: boolean }, options?: CallOptions): Promise<boolean> =>
    post('ctx.notify.show', payload as Record<string, unknown>, options) as Promise<boolean>,
}

export const screenshot = {
  start: (options?: CallOptions): Promise<boolean> => post('ctx.screenshot.start', undefined, options) as Promise<boolean>,
}

export const quicklink = {
  all: (options?: CallOptions): Promise<Array<{ id: string; name: string; url: string; icon?: string }>> =>
    post('ctx.quicklink.all', undefined, options) as never,
  add: (link: { name: string; url: string; icon?: string }, options?: CallOptions): Promise<{ id: string }> =>
    post('ctx.quicklink.add', link as Record<string, unknown>, options) as never,
  edit: (id: string, patch: { name?: string; url?: string }, options?: CallOptions): Promise<void> =>
    post('ctx.quicklink.edit', { id, ...patch }, options) as Promise<void>,
  remove: (id: string, options?: CallOptions): Promise<void> =>
    post('ctx.quicklink.remove', { id }, options) as Promise<void>,
}

/**
 * 管理面特权（只有 `internal-*` 插件在装配期拿得到该服务，P2「仅管理面除外」）。
 * 第三方插件调用会得到 FORBIDDEN。
 */
export interface SettingsApi {
  get(): Promise<unknown>
  patch(patch: Record<string, unknown>): Promise<{ config: unknown; hotkey?: { ok: boolean; reason?: string } }>
  setAutostart(enabled: boolean): Promise<void>
  setHistoryLimit(limit: number): Promise<void>
  plugins(): Promise<unknown[]>
  pluginAction(action: string, payload?: Record<string, unknown>): Promise<unknown>
  audit(limit?: number): Promise<unknown[]>
  clearAudit(): Promise<void>
  clearHistory(): Promise<void>
  openDataDir(): Promise<void>
  revealPlugin(id: string): Promise<void>
  info(): Promise<{ version: string; platform: string; dataRoot: string; node: string }>
}

export const settings: SettingsApi = {
  get: (options?: CallOptions) => post('ctx.settings.get', undefined, options) as Promise<never>,
  patch: (patch, options?: CallOptions) => post('ctx.settings.patch', { patch }, options) as Promise<never>,
  setAutostart: (enabled, options?: CallOptions) =>
    post('ctx.settings.setAutostart', { enabled }, options) as Promise<void>,
  setHistoryLimit: (limit, options?: CallOptions) =>
    post('ctx.settings.setHistoryLimit', { limit }, options) as Promise<void>,
  plugins: (options?: CallOptions) => post('ctx.settings.plugins', undefined, options) as Promise<never>,
  pluginAction: (action, payload, options?: CallOptions) =>
    post('ctx.settings.pluginAction', { action, payload }, options) as Promise<unknown>,
  audit: (limit = 100, options?: CallOptions) => post('ctx.settings.audit', { limit }, options) as Promise<never>,
  clearAudit: (options?: CallOptions) => post('ctx.settings.clearAudit', undefined, options) as Promise<void>,
  clearHistory: (options?: CallOptions) => post('ctx.settings.clearHistory', undefined, options) as Promise<void>,
  openDataDir: (options?: CallOptions) => post('ctx.settings.openDataDir', undefined, options) as Promise<void>,
  revealPlugin: (id: string, options?: CallOptions) =>
    post('ctx.settings.revealPlugin', { id }, options) as Promise<void>,
  info: (options?: CallOptions) => post('ctx.settings.info', undefined, options) as Promise<never>,
}

/** 贡献型搜索：宿主每次输入会调用该 handler（plugin-spec §9.2） */
export const search = {
  onQuery: (handler: (payload: { query: string; token: number }) => ResultItem[] | Promise<ResultItem[]> | void): (() => void) => {
    searchHandlers.push(handler)
    const off = (): void => {
      const index = searchHandlers.indexOf(handler)
      if (index >= 0) searchHandlers.splice(index, 1)
    }
    cleanups.push(off)
    return off
  },
}

/** 插件清理（SDK 统一回收，plugin-spec §6.2） */
export function onCleanup(fn: () => void): () => void {
  cleanups.push(fn)
  return () => {
    const index = cleanups.indexOf(fn)
    if (index >= 0) cleanups.splice(index, 1)
  }
}

function applyCapabilityMask(info: HostInfo): void {
  const granted = new Set(info.capabilities ?? [])
  const denied = info.deniedCapabilities ?? []
  const all = [...granted, ...denied]
  if (all.length === 0) return
  const mask: Record<string, () => void> = {
    storage: () => delete (api as Record<string, unknown>).storage,
    hostUi: () => delete (api as Record<string, unknown>).hostUi,
    clipboard: () => delete (api as Record<string, unknown>).clipboard,
    'shell.open': () => delete (api as Record<string, unknown>).shell,
    'exec.spawn': () => delete (api as Record<string, unknown>).exec,
    'notify.show': () => delete (api as Record<string, unknown>).notify,
    screenshot: () => delete (api as Record<string, unknown>).screenshot,
    quicklink: () => delete (api as Record<string, unknown>).quicklink,
  }
  for (const cap of all) {
    if (granted.has(cap)) continue
    mask[cap]?.()
  }
}

/** 聚合对象（便于 default import 使用） */
export const api = {
  host,
  commands,
  searchResult,
  storage,
  hostUi,
  clipboard,
  shell,
  exec,
  notify,
  screenshot,
  quicklink,
  search,
  settings,
  onCleanup,
  LauncherError,
}

export default api
