export type Priority = 0 | 1 | 2

export interface Task {
  id: string
  title: string
  note: string
  done: boolean
  priority: Priority
  /** 截止时刻（当天 23:59:59：按天判轻重） */
  dueAt?: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  /** 累计投入的番茄数 */
  pomodoros: number
}

export type TaskFilter = 'open' | 'today' | 'done' | 'all'

export const PRIORITY_LABEL: Record<Priority, string> = { 0: '普通', 1: '重要', 2: '紧急' }

export function makeId(seed = Date.now()): string {
  return `t${seed.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function endOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

export function createTask(title: string, extra: Partial<Task> = {}, now = Date.now()): Task {
  return {
    id: makeId(now),
    title: title.trim() || '未命名待办',
    note: '',
    done: false,
    priority: 0,
    createdAt: now,
    updatedAt: now,
    pomodoros: 0,
    ...extra,
  }
}

export function toggleDone(task: Task, now = Date.now()): Task {
  const done = !task.done
  return {
    ...task,
    done,
    updatedAt: now,
    ...(done ? { completedAt: now } : { completedAt: undefined }),
  }
}

export function updateTask(task: Task, patch: Partial<Task>, now = Date.now()): Task {
  return { ...task, ...patch, updatedAt: now }
}

export function isOverdue(task: Task, now = Date.now()): boolean {
  if (task.done || task.dueAt === undefined) return false
  return task.dueAt < startOfDay(now)
}

export function isDueToday(task: Task, now = Date.now()): boolean {
  if (task.dueAt === undefined) return false
  return startOfDay(task.dueAt) === startOfDay(now)
}

export function matchesFilter(task: Task, filter: TaskFilter, now = Date.now()): boolean {
  if (filter === 'all') return true
  if (filter === 'done') return task.done
  if (task.done) return false
  if (filter === 'open') return true
  // today：今天到期 + 已经逾期的
  if (task.dueAt === undefined) return false
  return startOfDay(task.dueAt) <= startOfDay(now)
}

/** 排序：未完成在前 → 优先级高优先 → 有截止的按截止先后 → 新建的在前 */
export function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.priority !== b.priority) return b.priority - a.priority
    const aDue = a.dueAt ?? Number.POSITIVE_INFINITY
    const bDue = b.dueAt ?? Number.POSITIVE_INFINITY
    if (aDue !== bDue) return aDue - bDue
    return b.createdAt - a.createdAt
  })
}

export interface DueLabel {
  text: string
  tone: 'danger' | 'warn' | 'muted' | 'done'
}

export function dueLabel(task: Task, now = Date.now()): DueLabel | null {
  if (task.dueAt === undefined) return null
  if (task.done) return { text: '已完成', tone: 'done' }
  const day = startOfDay(now)
  const due = startOfDay(task.dueAt)
  const diffDays = Math.round((due - day) / 86_400_000)
  if (diffDays < 0) return { text: `逾期 ${Math.abs(diffDays)} 天`, tone: 'danger' }
  if (diffDays === 0) return { text: '今天到期', tone: 'warn' }
  if (diffDays === 1) return { text: '明天到期', tone: 'warn' }
  if (diffDays <= 7) return { text: `${diffDays} 天后`, tone: 'muted' }
  const date = new Date(task.dueAt)
  return { text: `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`, tone: 'muted' }
}

/**
 * 解析用户敲的截止日期：今天 / 明天 / 后天 / N天后 / 周一~周日 / MM-DD / YYYY-MM-DD。
 * 认不出来返回 undefined（UI 会提示）。
 */
export function parseDue(input: string, now = Date.now()): number | undefined {
  const text = input.trim()
  if (!text) return undefined
  if (text === '今天' || text === 'today') return endOfDay(now)
  if (text === '明天' || text === 'tomorrow') return endOfDay(now + 86_400_000)
  if (text === '后天') return endOfDay(now + 2 * 86_400_000)
  const days = /^(\d{1,3})\s*天后$/.exec(text)
  if (days) return endOfDay(now + Number(days[1]) * 86_400_000)
  const weekday = /^(下)?周([一二三四五六日天])$/.exec(text)
  if (weekday) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
    const target = map[weekday[2] ?? ''] ?? 1
    // 以周一为一周之首：周一=1 … 周日=7
    const today = new Date(now).getDay() || 7
    const delta =
      weekday[1] === '下'
        ? (((8 - today) % 7) || 7) + (target - 1) // 先跳到下周一，再往后数
        : ((target - today + 7) % 7) || 7 // 本周内还没到的那个周几
    return endOfDay(now + delta * 86_400_000)
  }
  const monthDay = /^(\d{1,2})[-/.](\d{1,2})$/.exec(text)
  if (monthDay) {
    const year = new Date(now).getFullYear()
    const date = new Date(year, Number(monthDay[1]) - 1, Number(monthDay[2]))
    if (Number.isNaN(date.getTime())) return undefined
    if (date.getTime() < startOfDay(now)) date.setFullYear(year + 1)
    return endOfDay(date.getTime())
  }
  const full = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
  if (full) {
    const date = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]))
    if (Number.isNaN(date.getTime())) return undefined
    return endOfDay(date.getTime())
  }
  return undefined
}

export function dueInputValue(dueAt: number | undefined): string {
  if (dueAt === undefined) return ''
  const date = new Date(dueAt)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export interface TaskStats {
  open: number
  today: number
  done: number
  overdue: number
}

export function stats(list: Task[], now = Date.now()): TaskStats {
  let open = 0
  let today = 0
  let done = 0
  let overdue = 0
  for (const task of list) {
    if (task.done) {
      done += 1
      continue
    }
    open += 1
    if (isOverdue(task, now)) overdue += 1
    else if (isDueToday(task, now)) today += 1
  }
  return { open, today, done, overdue }
}

export function plainTasks(list: Task[]): Task[] {
  return list.map((task) => ({ ...task }))
}
