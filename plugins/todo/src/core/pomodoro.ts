/**
 * 番茄钟状态机（纯函数，时间由调用方喂进来，方便单测）。
 *
 * 用「上一次推进时间 + 剩余毫秒」表达状态：每一秒 tick 一次就把真实流逝的时间折算掉，
 * 窗口被隐藏（宿主收起）时定时器会被节流，但回到前台后时间依然是对的。
 */

export type PomoPhase = 'focus' | 'break'

export interface PomodoroState {
  phase: PomoPhase
  running: boolean
  /** 剩余毫秒 */
  remaining: number
  /** 已完成的专注轮数 */
  rounds: number
  focusMs: number
  breakMs: number
  updatedAt: number
}

export const DEFAULT_FOCUS_MS = 25 * 60_000
export const DEFAULT_BREAK_MS = 5 * 60_000

export function createPomodoro(focusMs = DEFAULT_FOCUS_MS, breakMs = DEFAULT_BREAK_MS, now = Date.now()): PomodoroState {
  return { phase: 'focus', running: false, remaining: focusMs, rounds: 0, focusMs, breakMs, updatedAt: now }
}

/** 把「已流逝时间」折进 remaining（不推进阶段） */
function advance(state: PomodoroState, now: number): PomodoroState {
  if (!state.running) return { ...state, updatedAt: now }
  const elapsed = Math.max(0, now - state.updatedAt)
  return { ...state, remaining: state.remaining - elapsed, updatedAt: now }
}

export function start(state: PomodoroState, now = Date.now()): PomodoroState {
  if (state.running) return state
  return { ...state, running: true, updatedAt: now }
}

export function pause(state: PomodoroState, now = Date.now()): PomodoroState {
  const next = advance(state, now)
  return { ...next, running: false, remaining: Math.max(0, next.remaining) }
}

export function reset(state: PomodoroState, now = Date.now()): PomodoroState {
  const duration = state.phase === 'focus' ? state.focusMs : state.breakMs
  return { ...state, running: false, remaining: duration, updatedAt: now }
}

/** 跳过当前阶段：专注被跳过不计入轮数，休息被跳过直接回到专注 */
export function skip(state: PomodoroState, now = Date.now()): PomodoroState {
  if (state.phase === 'focus') return { ...state, phase: 'break', remaining: state.breakMs, running: false, updatedAt: now }
  return { ...state, phase: 'focus', remaining: state.focusMs, running: false, updatedAt: now }
}

export interface TickResult {
  state: PomodoroState
  /** 这一 tick 里刚刚结束的阶段（用于弹通知 / 给任务记一个番茄） */
  finished: PomoPhase | null
}

export function tick(state: PomodoroState, now = Date.now()): TickResult {
  if (!state.running) return { state, finished: null }
  const next = advance(state, now)
  if (next.remaining > 0) return { state: next, finished: null }
  const finished = next.phase
  if (finished === 'focus') {
    return {
      state: { ...next, phase: 'break', remaining: next.breakMs, rounds: next.rounds + 1, updatedAt: now },
      finished,
    }
  }
  return { state: { ...next, phase: 'focus', remaining: next.focusMs, updatedAt: now }, finished }
}

export function setDurations(state: PomodoroState, focusMinutes: number, breakMinutes: number, now = Date.now()): PomodoroState {
  const focusMs = Math.max(60_000, Math.round(focusMinutes * 60_000))
  const breakMs = Math.max(60_000, Math.round(breakMinutes * 60_000))
  const idle = !state.running
  return {
    ...state,
    focusMs,
    breakMs,
    // 只有停着（且还没开始走）的时候改时长才顺带重置剩余，正在计时的不打断
    ...(idle ? { remaining: state.phase === 'focus' ? focusMs : breakMs } : {}),
    updatedAt: now,
  }
}

/** 剩余时间 → `25:00` / `05:09` */
export function formatClock(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 已走过的进度（0~1），给进度条用 */
export function progress(state: PomodoroState): number {
  const duration = state.phase === 'focus' ? state.focusMs : state.breakMs
  if (duration <= 0) return 0
  return Math.min(1, Math.max(0, 1 - state.remaining / duration))
}

export function plainPomodoro(state: PomodoroState): PomodoroState {
  return { ...state }
}
