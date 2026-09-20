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

/** 状态条数据（内核 `services/systemStats.ts` 采样）：主角是启动台自身占用 */
export interface SystemStats {
  /** 启动台自身（壳 + 内核两个进程） */
  app: {
    rss: number
    rssShell: number
    rssKernel: number
    /** 占整机 CPU 百分比（一位小数）；没有基线时为 null */
    cpu: number | null
    cores: number
  }
  /** 整机 CPU 使用率（0–100，对照用） */
  cpu: number
  /** 整机已用 / 总内存（bytes，对照用） */
  memUsed: number
  memTotal: number
  loadAvg: number[]
  sampledAt: number
}

/** 无边框窗口的八向缩放手柄（与壳侧 `ResizeDirection` 一一对应） */
export type ResizeDirection =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northEast'
  | 'northWest'
  | 'southEast'
  | 'southWest'

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
  /**
   * 当前窗口几何（位置 = 屏幕物理像素、尺寸 = 逻辑像素）：
   * 「窗口几何记忆」（requirements §3.1）关闭前 / 切换窗口态时读它落盘。
   * `bounds: null` = 问不到壳（standalone / 未连接）—— 当「没记过」处理，别编默认值。
   */
  windowBounds: () =>
    request<{ ok: boolean; bounds: { x: number; y: number; width: number; height: number } | null }>(
      '/api/window/bounds',
    ),
  /**
   * 应用用户记忆的窗口几何（唤出 / 切换窗口态时还原）：x/y 与 width/height 各自成对、至少给一对。
   * 与 `setWindowHeight`（内容自适应）是两条路，别混用。
   */
  setWindowBounds: (bounds: { x?: number; y?: number; width?: number; height?: number }) =>
    request<{ ok: boolean }>('/api/window/setBounds', { method: 'POST', body: JSON.stringify(bounds) }),
  /**
   * 无边框窗口的拖动：拖拽区 mousedown 时调一次即可 —— 系统接管后的移动
   * 不会再经过这里（不是每帧请求，也不会跟动画抢频）。
   */
  startWindowDrag: () => request<{ ok: boolean }>('/api/window/startDrag', { method: 'POST' }),
  /** 四边 / 四角缩放：把手 mousedown 时调一次 */
  startWindowResize: (direction: ResizeDirection) =>
    request<{ ok: boolean }>('/api/window/startResize', { method: 'POST', body: JSON.stringify({ direction }) }),
  hideWindow: () => request<{ ok: boolean }>('/api/window/hide', { method: 'POST' }),
  /**
   * 离场回执：离场动画的最后一帧**已经画出来了** → 内核可以真正隐藏窗口了。
   * 走这条路而不是「等固定时长」是刻意的：隐藏广播穿过内核 → SSE → webview 的耗时不可控，
   * 定时落地会把淡出砍在中间，把半透明的一帧留成「下次唤出先亮的旧画面」。
   * 带上 `opacity` 是给内核日志留证据：它不是 0 就说明时序又被改坏了。
   */
  confirmWindowHidden: (payload: { opacity: number; elapsedMs: number }) =>
    request<{ ok: boolean }>('/api/window/hidden', { method: 'POST', body: JSON.stringify(payload) }),
  showWindow: () => request<{ ok: boolean }>('/api/window/show', { method: 'POST' }),
  /** `visible` 为 `null` = 内核问不到壳（standalone / 浏览器开发），此时一律当可见处理 */
  windowVisible: () => request<{ ok: boolean; visible: boolean | null }>('/api/window/visible'),
  reportTheme: (theme: 'light' | 'dark') =>
    request<{ ok: boolean }>('/api/ui/theme', { method: 'POST', body: JSON.stringify({ theme }) }),
  /** 状态条：CPU / 内存占用（UI 自己决定刷新节奏，窗口隐藏时不拉） */
  systemStats: () => request<{ ok: boolean; stats: SystemStats }>('/api/system/stats'),
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
      'config/changed',
      'plugin/state',
      'plugin/reloaded',
      'session/closed',
      'history/changed',
      'pinned/changed',
      'search/query',
      'search/results',
      'ui/searchContent',
      'ui/footer',
      'ui/hide',
      'ui/openView',
      'shell/visibility',
      'app/quit',
      'hot/updated',
      'hot/restarting',
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
