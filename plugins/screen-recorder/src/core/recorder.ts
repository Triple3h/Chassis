/**
 * 与逻辑层（rec-* 脚本）之间的数据形状 + 面板要用的纯函数。
 *
 * 契约的权威定义在 `src/lib.rs`（后端 `macos.rs` / `windows.rs` 各自实现，
 * 对 UI 的字段两端完全一致 —— plugin-spec §3.5 规则 1）。
 */

export type RecordMode = 'full' | 'region' | 'window'
export type ShotMode = 'full' | 'region' | 'window' | 'clipboard'

/** 失败码：面板据此决定给什么补救入口（不再是一句「失败了」） */
export type FailCode =
  | 'PERMISSION'
  | 'AUDIO_UNAVAILABLE'
  | 'DEPENDENCY_MISSING'
  | 'BUSY'
  | 'ORPHAN'
  | 'ORPHAN_STOPPED'
  | 'IDLE'
  | 'CANCELLED'
  | 'DIR_FAILED'
  | 'SPAWN_FAILED'
  | 'START_FAILED'
  | 'STATE_FAILED'
  | 'CAPTURE_FAILED'
  | 'UNSUPPORTED'

export interface StartResult {
  ok: boolean
  backend?: string
  pid?: number
  path?: string
  startedAt?: number
  interactive?: boolean
  seconds?: number | null
  audio?: boolean
  args?: string[]
  code?: FailCode
  error?: string
  /** 后端原始输出（诊断） */
  detail?: string
  needsPermission?: boolean
  retryWithoutAudio?: boolean
  micSettingsUrl?: string
  settingsUrl?: string
}

export interface StopResult {
  ok: boolean
  path?: string
  size?: number | null
  durationMs?: number
  stillAlive?: boolean
  code?: FailCode
  orphans?: number
  error?: string | null
  detail?: string | null
}

export interface StatusResult {
  recording: boolean
  /** 会话契约字段（plugin-spec §3.6，托盘按它显示）：还在录吗 */
  active?: boolean
  /** 会话契约字段：暂停中（计时停住） */
  paused?: boolean
  /** 会话契约字段：**有效录制时长**（扣掉暂停；秒表与托盘都用它） */
  activeMs?: number
  /** 会话契约字段：状态词（托盘那一行显示「录制中」/「已暂停」） */
  state?: string
  path?: string
  startedAt?: number
  elapsedMs?: number
  mode?: string
  interactive?: boolean
  seconds?: number | null
  size?: number | null
  backend?: string
  audio?: boolean
  clicks?: boolean
  /** 状态文件没了但系统里还有录制进程 */
  orphan?: boolean
  last?: { path: string; size: number; mtimeMs: number } | null
  detail?: string | null
}

export interface ShotResult {
  ok: boolean
  mode?: ShotMode
  path?: string | null
  size?: number | null
  clipboard?: boolean
  /** 交给系统截图工具做（此时不会产出文件） */
  delegated?: boolean
  note?: string | null
  args?: string[]
  code?: FailCode
  cancelled?: boolean
  error?: string | null
  detail?: string
}

/** `rec-pause` 的返回：切完之后的状态（托盘与面板都读它） */
export interface PauseResult {
  ok: boolean
  paused?: boolean
  activeMs?: number
  elapsedMs?: number
  path?: string
  code?: FailCode
  error?: string
}

/** 平台能力矩阵（后端自报，视图层不猜平台） */
export interface Features {
  audio: boolean
  clicks: boolean
  cursor: boolean
  windowRecording: boolean
  regionPick: boolean
  delegatedShot: boolean
  delayInInteractive: boolean
  notes: string[]
}

export interface EnvResult {
  supported: boolean
  granted: boolean
  requested?: boolean
  needsManual?: boolean
  hint?: string
  settingsUrl?: string
  micSettingsUrl?: string
  /** "screencapture" | "ffmpeg" | "none" */
  backend?: string
  platform?: string
  /** 录制依赖是否就绪（Windows 未装 ffmpeg 时为 false） */
  ready?: boolean
  readyHint?: string
  features?: Features
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

export const FALLBACK_FEATURES: Features = {
  audio: true,
  clicks: true,
  cursor: true,
  windowRecording: true,
  regionPick: true,
  delegatedShot: false,
  delayInInteractive: false,
  notes: [],
}

export function recordModes(features: Features): Array<{ value: RecordMode; label: string; hint: string; icon: string }> {
  const modes: Array<{ value: RecordMode; label: string; hint: string; icon: string }> = [
    { value: 'full', label: '全屏录制', hint: '整块屏幕，开始/停止由我们控制', icon: 'video' },
    { value: 'region', label: '区域录制', hint: '系统选择框里拖出任意区域', icon: 'columns' },
  ]
  if (features.windowRecording) {
    modes.push({ value: 'window', label: '窗口录制', hint: '跟着窗口走，窗口动它跟着动', icon: 'file' })
  }
  return modes
}

/** 截图四种模式两端都有（Windows 的窗口 / 剪贴板由系统截图工具落地，结果一样是进剪贴板） */
export const SHOT_MODES: Array<{ value: ShotMode; label: string; icon: string }> = [
  { value: 'full', label: '全屏', icon: 'camera' },
  { value: 'region', label: '框选', icon: 'columns' },
  { value: 'window', label: '窗口', icon: 'file' },
  { value: 'clipboard', label: '到剪贴板', icon: 'clipboard' },
]

export function modeLabel(mode: string | undefined): string {
  return ['full', 'region', 'window'].includes(mode ?? '')
    ? { full: '全屏录制', region: '区域录制', window: '窗口录制' }[mode as RecordMode]
    : '录制'
}

/** 后端标签：面板底部显示「现在是哪套实现在干活」 */
export function backendLabel(backend: string | undefined): string {
  switch (backend) {
    case 'screencapture':
      return '系统 screencapture'
    case 'ffmpeg':
      return 'ffmpeg (gdigrab)'
    case 'none':
      return '无后端'
    default:
      return backend ?? ''
  }
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

/**
 * 轮询节奏：录制刚开始时 1s（首帧、报错、用户框选都在这几秒内发生），
 * 稳定之后拉到 5s —— 每次 rec-status 都是一个子进程，一小时录制按 1s 轮询要 spawn 3600 次。
 */
export function nextPollDelay(elapsedMs: number): number {
  return elapsedMs < 15_000 ? 1_000 : 5_000
}

/** 面板上的选项 → rec-start 的参数（与 Rust 侧 `RecordOptions::from_args` 一一对应） */
export function startArgs(input: {
  mode: RecordMode
  delaySec: number
  maxMinutes: number
  audio: boolean
  clicks: boolean
  cursor: boolean
  dir?: string
}): Record<string, unknown> {
  return {
    mode: input.mode,
    delaySec: input.delaySec,
    seconds: input.maxMinutes > 0 ? input.maxMinutes * 60 : undefined,
    audio: input.audio,
    clicks: input.clicks,
    cursor: input.cursor,
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

/** 面板上那条「需要处理」的横幅：一条消息 + 若干个可点的补救动作 */
export interface Issue {
  tone: 'error' | 'info'
  message: string
  detail?: string
  actions?: Array<{ id: 'settings' | 'mic-settings' | 'retry-silent' | 'stop' | 'open-dep' | 'reveal'; label: string }>
}

/**
 * 把 rec-start 的失败翻译成「用户能照着做点什么」。
 * 关键点：失败必须可行动 —— 之前的版本只弹一句「没能开始录制」，
 * 麦克风没授权时录完什么都没有，用户根本无从下手。
 */
export function issueFromStart(result: StartResult | null, micro = false): Issue | null {
  if (!result) return null
  if (result.ok) return null
  const detail = result.detail?.trim() ? result.detail.trim() : undefined
  switch (result.code) {
    case 'PERMISSION':
      return {
        tone: 'error',
        message: result.error ?? '系统还没给屏幕录制权限',
        detail,
        actions: [{ id: 'settings', label: '打开系统设置' }],
      }
    case 'AUDIO_UNAVAILABLE':
      return {
        tone: 'error',
        message: result.error ?? '带麦克风录制没能起来',
        detail,
        actions: [
          ...(result.retryWithoutAudio ? [{ id: 'retry-silent' as const, label: '改用无声录制' }] : []),
          ...(micro ? [{ id: 'mic-settings' as const, label: '麦克风授权' }] : []),
        ],
      }
    case 'DEPENDENCY_MISSING':
      return {
        tone: 'error',
        message: result.error ?? '缺少录制依赖',
        detail,
        actions: [{ id: 'open-dep', label: '怎么装 ffmpeg' }],
      }
    case 'BUSY':
      return { tone: 'info', message: result.error ?? '已经有一段录制在进行中', actions: [{ id: 'stop', label: '去停止' }] }
    case 'ORPHAN':
      return {
        tone: 'error',
        message: result.error ?? '系统里还有一段录制在跑',
        actions: [{ id: 'stop', label: '把它停掉' }],
      }
    case 'CANCELLED':
      return { tone: 'info', message: '已取消' }
    default:
      return { tone: 'error', message: result.error ?? '没能开始录制', detail }
  }
}

/** 录制进程自己退场时（限时到点 / 被系统收走）该说什么 */
export function issueFromStatusEnd(status: StatusResult): Issue | null {
  if (status.last) return null
  return {
    tone: 'error',
    message: status.interactive ? '录制结束，但没有拿到文件（框选被取消？）' : '录制结束，但没有拿到文件',
    detail: status.detail?.trim() ? status.detail.trim() : undefined,
  }
}
