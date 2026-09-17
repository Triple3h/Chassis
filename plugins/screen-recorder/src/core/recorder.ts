/** 与逻辑层（rec-* 脚本）之间的数据形状 + 面板要用的纯函数 */

export type RecordMode = 'full' | 'region' | 'window'
export type ShotMode = 'full' | 'region' | 'window' | 'clipboard'

export interface StartResult {
  ok: boolean
  pid?: number
  path?: string
  startedAt?: number
  interactive?: boolean
  seconds?: number | null
  args?: string[]
  error?: string
  needsPermission?: boolean
}

export interface StopResult {
  ok: boolean
  path?: string
  size?: number | null
  durationMs?: number
  stillAlive?: boolean
  error?: string | null
}

export interface StatusResult {
  recording: boolean
  path?: string
  startedAt?: number
  elapsedMs?: number
  mode?: string
  interactive?: boolean
  seconds?: number | null
  size?: number | null
  last?: { path: string; size: number; mtimeMs: number } | null
}

export interface ShotResult {
  ok: boolean
  path?: string
  size?: number | null
  clipboard?: boolean
  args?: string[]
  error?: string | null
}

export interface PermissionResult {
  supported: boolean
  granted: boolean
  requested?: boolean
  needsManual?: boolean
  hint?: string
}

export interface RecentFile {
  name: string
  path: string
  size: number
  mtimeMs: number
}

export interface ListResult {
  ok: boolean
  dir?: string
  files: RecentFile[]
}

export const RECORD_MODES: Array<{ value: RecordMode; label: string; hint: string; icon: string }> = [
  { value: 'full', label: '全屏录制', hint: '整块屏幕，开始/停止由我们控制', icon: 'maximize' },
  { value: 'region', label: '区域录制', hint: '系统选择框里拖出任意区域', icon: 'columns' },
  { value: 'window', label: '窗口录制', hint: '跟着窗口走，窗口动它跟着动', icon: 'app-window' },
]

export const SHOT_MODES: Array<{ value: ShotMode; label: string; icon: string }> = [
  { value: 'full', label: '全屏', icon: 'maximize' },
  { value: 'region', label: '框选', icon: 'columns' },
  { value: 'window', label: '窗口', icon: 'app-window' },
  { value: 'clipboard', label: '到剪贴板', icon: 'clipboard' },
]

export function modeLabel(mode: string | undefined): string {
  return RECORD_MODES.find((item) => item.value === mode)?.label ?? '录制'
}

/** 录制时长：`00:12` / `1:02:03`（数字等宽，跳秒不抖） */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export function formatWhen(ts: number, now = Date.now()): string {
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(ts)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date(now).toDateString()) return `今天 ${hhmm}`
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (date.getFullYear() === new Date(now).getFullYear()) return `${month}-${day} ${hhmm}`
  return `${date.getFullYear()}-${month}-${day}`
}

/** 面板上的选项 → rec-start 的参数（与 Rust 侧 `RecordOptions::from_args` 一一对应） */
export function startArgs(input: {
  mode: RecordMode
  delaySec: number
  maxMinutes: number
  audio: boolean
  clicks: boolean
  dir?: string
}): Record<string, unknown> {
  return {
    mode: input.mode,
    delaySec: input.delaySec,
    seconds: input.maxMinutes > 0 ? input.maxMinutes * 60 : undefined,
    audio: input.audio,
    clicks: input.clicks,
    dir: input.dir?.trim() ? input.dir.trim() : undefined,
  }
}

export function shotArgs(input: { mode: ShotMode; delaySec: number; cursor: boolean; dir?: string }): Record<string, unknown> {
  return {
    mode: input.mode,
    delaySec: input.delaySec,
    cursor: input.cursor,
    dir: input.dir?.trim() ? input.dir.trim() : undefined,
  }
}
