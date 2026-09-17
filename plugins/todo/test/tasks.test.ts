import assert from 'node:assert/strict'
import {
  createTask,
  dueInputValue,
  dueLabel,
  endOfDay,
  isDueToday,
  isOverdue,
  matchesFilter,
  parseDue,
  sortTasks,
  startOfDay,
  stats,
  toggleDone,
  updateTask,
} from '../src/core/tasks'
import type { Task } from '../src/core/tasks'

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

/** 固定「现在」：2026-09-17 周四 15:00 */
const NOW = new Date('2026-09-17T15:00:00').getTime()

console.log('创建与切换')

test('createTask 生成默认字段', () => {
  const task = createTask('  买牛奶  ', {}, NOW)
  assert.equal(task.title, '买牛奶')
  assert.equal(task.done, false)
  assert.equal(task.priority, 0)
  assert.equal(task.pomodoros, 0)
  assert.ok(task.id.startsWith('t'))
})

test('toggleDone 记录完成时间，取消时清掉', () => {
  const task = createTask('写周报', {}, NOW)
  const done = toggleDone(task, NOW + 1000)
  assert.equal(done.done, true)
  assert.equal(done.completedAt, NOW + 1000)
  const back = toggleDone(done, NOW + 2000)
  assert.equal(back.done, false)
  assert.equal(back.completedAt, undefined)
})

test('updateTask 改优先级与备注', () => {
  const task = createTask('修水管', {}, NOW)
  const next = updateTask(task, { priority: 2, note: '找物业' }, NOW + 500)
  assert.equal(next.priority, 2)
  assert.equal(next.note, '找物业')
  assert.equal(next.updatedAt, NOW + 500)
})

console.log('截止日期解析')

test('今天 / 明天 / 后天 / N天后', () => {
  assert.equal(parseDue('今天', NOW), endOfDay(NOW))
  assert.equal(parseDue('明天', NOW), endOfDay(NOW + 86_400_000))
  assert.equal(parseDue('后天', NOW), endOfDay(NOW + 2 * 86_400_000))
  assert.equal(parseDue('3天后', NOW), endOfDay(NOW + 3 * 86_400_000))
})

test('周几与下周几', () => {
  // 2026-09-17 是周四
  assert.equal(parseDue('周五', NOW), endOfDay(NOW + 86_400_000))
  assert.equal(parseDue('周四', NOW), endOfDay(NOW + 7 * 86_400_000), '今天是周四，不加"下"就是下周四')
  assert.equal(parseDue('下周一', NOW), endOfDay(NOW + 4 * 86_400_000))
})

test('月-日与完整日期', () => {
  const due = parseDue('09-20', NOW)
  assert.equal(new Date(due ?? 0).getDate(), 20)
  const full = parseDue('2026-10-01', NOW)
  assert.equal(new Date(full ?? 0).getMonth(), 9)
  assert.equal(parseDue('02-01', NOW) !== undefined, true, '已经过去的日子按明年算')
  assert.equal(new Date(parseDue('02-01', NOW) ?? 0).getFullYear(), 2027)
})

test('认不出来的输入返回 undefined', () => {
  assert.equal(parseDue('下周看看', NOW), undefined)
  assert.equal(parseDue('', NOW), undefined)
})

test('dueInputValue 回填成 YYYY-MM-DD', () => {
  assert.equal(dueInputValue(parseDue('2026-10-01', NOW)), '2026-10-01')
  assert.equal(dueInputValue(undefined), '')
})

console.log('轻重缓急')

test('逾期 / 今天到期', () => {
  const overdue = createTask('倒垃圾', { dueAt: endOfDay(NOW - 2 * 86_400_000) }, NOW)
  const today = createTask('交房租', { dueAt: endOfDay(NOW) }, NOW)
  assert.equal(isOverdue(overdue, NOW), true)
  assert.equal(isDueToday(today, NOW), true)
  assert.equal(isOverdue(today, NOW), false)
  const done = toggleDone(overdue, NOW)
  assert.equal(isOverdue(done, NOW), false, '已完成的不算逾期')
})

test('dueLabel 文案与语气', () => {
  const overdue = createTask('倒垃圾', { dueAt: endOfDay(NOW - 2 * 86_400_000) }, NOW)
  assert.deepEqual(dueLabel(overdue, NOW), { text: '逾期 2 天', tone: 'danger' })
  const today = createTask('交房租', { dueAt: endOfDay(NOW) }, NOW)
  assert.deepEqual(dueLabel(today, NOW), { text: '今天到期', tone: 'warn' })
  const tomorrow = createTask('开会', { dueAt: endOfDay(NOW + 86_400_000) }, NOW)
  assert.deepEqual(dueLabel(tomorrow, NOW), { text: '明天到期', tone: 'warn' })
  const none = createTask('随便', {}, NOW)
  assert.equal(dueLabel(none, NOW), null)
})

console.log('过滤与排序')

const pool: Task[] = [
  createTask('普通无期限', {}, NOW - 5000),
  createTask('紧急今天', { priority: 2, dueAt: endOfDay(NOW) }, NOW - 4000),
  createTask('重要明天', { priority: 1, dueAt: endOfDay(NOW + 86_400_000) }, NOW - 3000),
  toggleDone(createTask('已完成的', {}, NOW - 2000), NOW - 1000),
  createTask('逾期两天', { dueAt: endOfDay(NOW - 2 * 86_400_000) }, NOW - 1000),
]

test('四种视图各自的集合', () => {
  assert.equal(pool.filter((task) => matchesFilter(task, 'open', NOW)).length, 4)
  assert.equal(pool.filter((task) => matchesFilter(task, 'done', NOW)).length, 1)
  assert.equal(pool.filter((task) => matchesFilter(task, 'today', NOW)).length, 2, '今天 + 逾期')
  assert.equal(pool.filter((task) => matchesFilter(task, 'all', NOW)).length, 5)
})

test('排序：未完成 → 优先级 → 截止 → 新建', () => {
  const ordered = sortTasks(pool.filter((task) => matchesFilter(task, 'open', NOW))).map((task) => task.title)
  assert.deepEqual(ordered, ['紧急今天', '重要明天', '逾期两天', '普通无期限'])
})

test('统计口径', () => {
  const result = stats(pool, NOW)
  assert.deepEqual(result, { open: 4, today: 1, done: 1, overdue: 1 })
})

test('startOfDay 归零到当天零点', () => {
  assert.equal(new Date(startOfDay(NOW)).getHours(), 0)
  assert.equal(startOfDay(NOW) < NOW, true)
})

console.log(`\n通过 ${passed} 项`)
