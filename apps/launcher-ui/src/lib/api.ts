import type { ActionDecl, ActionResult, AuditRecord, Config, PluginRuntimeInfo, ResultItem } from '@launcher/plugin-manifest'
import type { RankedResult, SearchResponse } from './types'

/** 内核地址：生产由内核托管（same-origin），开发用 `?kernel=` 指定 */
export function kernelBase(): string {
  const param = new URLSearchParams(location.search).get('kernel')
  if (param) {
    try {
      localStorage.setItem('launcher.kernelUrl', param)
    } catch {
      /* ignore */
    }
    return param.replace(/\/$/, '')
  }
  if (location.port === '3333') {
    try {
      const saved = localStorage.getItem('launcher.kernelUrl')
      if (saved) return saved.replace(/\/$/, '')
    } catch {
      /* ignore */
    }
  }
  return location.origin
}

export interface BootstrapData {
  ok: boolean
  version: string
  platform: string
  dataRoot: string
  config: Config
  theme: 'light' | 'dark'
  plugins: PluginRuntimeInfo[]
  snapshot: {
    commands: Array<{
      id: string
      pluginId: string
      pluginTitle: string
      title: string
      subtitle?: string
      icon?: string
      mode: string
      placeholder?: string
    }>
    pinned: unknown[]
    recent: unknown[]
  }
  historyLimit: number
}

export interface ExecuteResult {
  ok: boolean
  result?: ActionResult
}

export interface PluginViewData {
  sid: string
  url: string
  pluginId: string
  command: string
  title: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${kernelBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const payload = (await res.json()) as { error?: { message?: string } }
      if (payload?.error?.message) message = payload.error.message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export const api = {
  bootstrap: () => request<BootstrapData>('/api/bootstrap'),
  search: (query: string) => request<{ ok: boolean } & SearchResponse>('/api/search', {
    method: 'POST',
    body: JSON.stringify({ query }),
  }),
  exec: (payload: { pluginId: string; command?: string; args?: unknown; item?: ResultItem; action?: ActionDecl }) =>
    request<ExecuteResult>('/api/exec', { method: 'POST', body: JSON.stringify(payload) }),
  invoke: (id: string, args?: unknown) =>
    request<{ ok: boolean; result: ActionResult }>('/api/invoke', { method: 'POST', body: JSON.stringify({ id, args }) }),
  history: () => request<{ items: unknown[]; pinned: unknown[]; limit: number }>('/api/history'),
  removeHistory: (key: string) => request<{ ok: boolean }>('/api/history/remove', { method: 'POST', body: JSON.stringify({ key }) }),
  clearHistory: () => request<{ ok: boolean }>('/api/history/clear', { method: 'POST' }),
  togglePin: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; pinned: boolean }>('/api/pinned/toggle', { method: 'POST', body: JSON.stringify(payload) }),
  reorderPinned: (keys: string[]) =>
    request<{ ok: boolean }>('/api/pinned/reorder', { method: 'POST', body: JSON.stringify({ keys }) }),
  patchConfig: (patch: Partial<Config>) =>
    request<{ ok: boolean; config: Config; hotkey?: { ok: boolean; reason?: string } }>('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  plugins: () => request<{ ok: boolean; plugins: PluginRuntimeInfo[] }>('/api/plugins'),
  pluginAction: (payload: { action: string; id?: string; path?: string; overwrite?: boolean }) =>
    request<{ ok: boolean }>('/api/plugins/action', { method: 'POST', body: JSON.stringify(payload) }),
  bridge: (payload: { sid: string; token: string; id: number; method: string; params?: unknown }) =>
    request<{ id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } }>('/api/bridge', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  closeSession: (sid: string) => request<{ ok: boolean }>('/api/session/close', { method: 'POST', body: JSON.stringify({ sid }) }),
  reportCrash: (sid: string, reason: string) =>
    request<{ ok: boolean }>('/api/session/crashed', { method: 'POST', body: JSON.stringify({ sid, reason }) }),
  setWindowHeight: (height: number) =>
    request<{ ok: boolean }>('/api/window/setHeight', { method: 'POST', body: JSON.stringify({ height }) }),
  hideWindow: () => request<{ ok: boolean }>('/api/window/hide', { method: 'POST' }),
  showWindow: () => request<{ ok: boolean }>('/api/window/show', { method: 'POST' }),
  reportTheme: (theme: 'light' | 'dark') =>
    request<{ ok: boolean }>('/api/ui/theme', { method: 'POST', body: JSON.stringify({ theme }) }),
  audit: (limit = 200) => request<{ ok: boolean; records: AuditRecord[] }>(`/api/audit?limit=${limit}`),
  clearAudit: () => request<{ ok: boolean }>('/api/audit/clear', { method: 'POST' }),
  quit: () => request<{ ok: boolean }>('/api/app/quit', { method: 'POST' }),
  openDataDir: () => request<{ ok: boolean }>('/api/data/openDir', { method: 'POST' }),
}

export type { RankedResult, SearchResponse, ActionDecl, ActionResult, Config }

/** SSE 订阅（内核 → UI 的所有事件） */
export function subscribeEvents(
  handler: (event: string, payload: unknown) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  let source: EventSource | null = null
  let closed = false
  let retry = 0
  let timer: number | null = null

  const connect = (): void => {
    if (closed) return
    source = new EventSource(`${kernelBase()}/api/events`)
    const forward = (event: string) => (ev: MessageEvent) => {
      try {
        handler(event, JSON.parse(ev.data))
      } catch {
        handler(event, null)
      }
    }
    for (const name of [
      'registry/changed',
      'plugin/state',
      'history/changed',
      'pinned/changed',
      'search/query',
      'search/results',
      'ui/searchContent',
      'ui/footer',
      'ui/hide',
      'shell/visibility',
      'app/quit',
    ]) {
      source.addEventListener(name, forward(name) as EventListener)
    }
    source.onopen = () => {
      retry = 0
      onStatus?.(true)
    }
    source.onerror = () => {
      onStatus?.(false)
      source?.close()
      source = null
      retry += 1
      timer = window.setTimeout(connect, Math.min(4000, 300 * retry))
    }
  }

  connect()
  return () => {
    closed = true
    if (timer) window.clearTimeout(timer)
    source?.close()
  }
}
