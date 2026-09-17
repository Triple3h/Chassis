import assert from 'node:assert/strict'
import {
  createPomodoro,
  formatClock,
  pause,
  progress,
  reset,
  setDurations,
  skip,
  start,
  tick,
} from '../src/core/pomodoro'

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

const FOCUS = 25 * 60_000
const BREAK = 5 * 60_000

console.log('基础状态')

test('初始是待开始的专注段', () => {
  const state = createPomodoro(FOCUS, BREAK, 1000)
  assert.equal(state.phase, 'focus')
  assert.equal(state.running, false)
  assert.equal(state.remaining, FOCUS)
  assert.equal(state.rounds, 0)
  assert.equal(formatClock(state.remaining), '25:00')
})

test('开始 / 暂停把时间折算进去', () => {
  let state = start(createPomodoro(FOCUS, BREAK, 1000), 1000)
  state = pause(state, 1000 + 90_000)
  assert.equal(state.running, false)
  assert.equal(state.remaining, FOCUS - 90_000)
  assert.equal(formatClock(state.remaining), '23:30')
})

test('暂停之后 tick 不再吃时间', () => {
  const state = pause(createPomodoro(FOCUS, BREAK, 1000), 1000)
  const { state: next, finished } = tick(state, 999_999)
  assert.equal(finished, null)
  assert.equal(next.remaining, FOCUS)
})

console.log('推进与阶段切换')

test('专注走完自动进入休息并计一轮', () => {
  const state = start(createPomodoro(FOCUS, BREAK, 0), 0)
  const { state: next, finished } = tick(state, FOCUS + 1)
  assert.equal(finished, 'focus')
  assert.equal(next.phase, 'break')
  assert.equal(next.rounds, 1)
  assert.equal(next.remaining, BREAK)
  assert.equal(next.running, true, '阶段切换后继续跑，不用再点一次开始')
})

test('休息走完回到专注', () => {
  const state = start({ ...createPomodoro(FOCUS, BREAK, 0), phase: 'break', remaining: BREAK }, 0)
  const { state: next, finished } = tick(state, BREAK + 10)
  assert.equal(finished, 'break')
  assert.equal(next.phase, 'focus')
  assert.equal(next.remaining, FOCUS)
  assert.equal(next.rounds, 0, '休息结束不加轮数')
})

test('时间没到不切阶段', () => {
  const state = start(createPomodoro(FOCUS, BREAK, 0), 0)
  const { state: next, finished } = tick(state, 60_000)
  assert.equal(finished, null)
  assert.equal(next.phase, 'focus')
  assert.equal(next.remaining, FOCUS - 60_000)
})

console.log('重置 / 跳过 / 时长')

test('重置只回到本阶段起点', () => {
  let state = start({ ...createPomodoro(FOCUS, BREAK, 0), rounds: 3 }, 0)
  state = tick(state, 120_000).state
  const next = reset(state, 120_000)
  assert.equal(next.remaining, FOCUS)
  assert.equal(next.running, false)
  assert.equal(next.rounds, 3, '重置不动轮数')
})

test('跳过专注进休息（不计轮数），跳过休息回专注', () => {
  const focus = skip(createPomodoro(FOCUS, BREAK, 0), 0)
  assert.equal(focus.phase, 'break')
  assert.equal(focus.rounds, 0)
  const back = skip(focus, 0)
  assert.equal(back.phase, 'focus')
})

test('改时长在空闲时才重置剩余', () => {
  const idle = setDurations(createPomodoro(FOCUS, BREAK, 0), 45, 10, 0)
  assert.equal(idle.focusMs, 45 * 60_000)
  assert.equal(idle.remaining, 45 * 60_000)
  const running = setDurations(start(createPomodoro(FOCUS, BREAK, 0), 0), 45, 10, 0)
  assert.equal(running.remaining, FOCUS, '正在计时不打断')
})

console.log('展示')

test('进度条 0~1', () => {
  const state = start(createPomodoro(FOCUS, BREAK, 0), 0)
  assert.equal(progress(state), 0)
  assert.equal(progress(tick(state, FOCUS / 2).state), 0.5)
})

test('时钟格式化带补零', () => {
  assert.equal(formatClock(9_000), '00:09')
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(60 * 60_000), '60:00')
  assert.equal(formatClock(-5), '00:00')
})

console.log(`\n通过 ${passed} 项`)
