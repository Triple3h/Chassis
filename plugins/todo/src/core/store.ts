import { host, storage } from '@launcher/api'
import type { Task } from './tasks'
import { plainTasks } from './tasks'
import type { PomodoroState } from './pomodoro'
import { createPomodoro, DEFAULT_BREAK_MS, DEFAULT_FOCUS_MS } from './pomodoro'

const TASKS_KEY = 'todo:tasks'
const POMODORO_KEY = 'todo:pomodoro'

function isTask(value: unknown): value is Task {
  const task = value as Task | null
  return !!task && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.createdAt === 'number'
}

export async function loadTasks(): Promise<Task[]> {
  if (!host.isLauncher()) return []
  const raw = await storage.get<Task[]>(TASKS_KEY).catch(() => undefined)
  if (!Array.isArray(raw)) return []
  return raw.filter(isTask).map((task) => ({
    ...task,
    note: typeof task.note === 'string' ? task.note : '',
    done: task.done === true,
    priority: task.priority === 1 || task.priority === 2 ? task.priority : 0,
    pomodoros: typeof task.pomodoros === 'number' ? task.pomodoros : 0,
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : task.createdAt,
  }))
}

export async function saveTasks(list: Task[]): Promise<void> {
  if (!host.isLauncher()) return
  await storage.set(TASKS_KEY, plainTasks(list)).catch(() => undefined)
}

/** 番茄钟只持久化设置与轮数：剩余时间不落盘（下次打开从整段重新开始） */
export async function loadPomodoro(): Promise<PomodoroState> {
  if (!host.isLauncher()) return createPomodoro()
  const raw = await storage.get<{ focusMs?: number; breakMs?: number; rounds?: number }>(POMODORO_KEY).catch(() => undefined)
  const focusMs = typeof raw?.focusMs === 'number' ? raw.focusMs : DEFAULT_FOCUS_MS
  const breakMs = typeof raw?.breakMs === 'number' ? raw.breakMs : DEFAULT_BREAK_MS
  const state = createPomodoro(focusMs, breakMs)
  state.rounds = typeof raw?.rounds === 'number' ? raw.rounds : 0
  return state
}

export async function savePomodoro(state: PomodoroState): Promise<void> {
  if (!host.isLauncher()) return
  await storage
    .set(POMODORO_KEY, { focusMs: state.focusMs, breakMs: state.breakMs, rounds: state.rounds })
    .catch(() => undefined)
}
