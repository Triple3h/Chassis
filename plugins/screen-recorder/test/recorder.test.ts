import assert from 'node:assert/strict'
import { formatBytes, formatClock, formatWhen, modeLabel, shotArgs, startArgs } from '../src/core/recorder'

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

console.log('时长 / 体积展示')

test('录制时长按需带小时', () => {
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(12_400), '00:12')
  assert.equal(formatClock(59_999), '00:59')
  assert.equal(formatClock(3_661_000), '1:01:01')
  assert.equal(formatClock(-5), '00:00')
})

test('体积换算保留一位小数', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB')
  assert.equal(formatBytes(null), '—')
})

test('时间戳展示成相对时间', () => {
  const now = new Date('2026-09-17T15:04:00').getTime()
  assert.equal(formatWhen(now - 30_000, now), '刚刚')
  assert.equal(formatWhen(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(formatWhen(new Date('2026-09-17T09:00:00').getTime(), now), '今天 09:00')
  assert.equal(formatWhen(new Date('2026-09-01T09:00:00').getTime(), now), '09-01 09:00')
})

test('模式标签', () => {
  assert.equal(modeLabel('full'), '全屏录制')
  assert.equal(modeLabel('region'), '区域录制')
  assert.equal(modeLabel(undefined), '录制')
})

console.log('参数组装')

test('startArgs 把「不限时」翻译成 undefined，自定义目录留空则不传', () => {
  const args = startArgs({ mode: 'full', delaySec: 3, maxMinutes: 0, audio: true, clicks: false, dir: '   ' })
  assert.equal(args.mode, 'full')
  assert.equal(args.delaySec, 3)
  assert.equal(args.seconds, undefined)
  assert.equal(args.audio, true)
  assert.equal(args.dir, undefined)
  const limited = startArgs({ mode: 'region', delaySec: 0, maxMinutes: 5, audio: false, clicks: true, dir: ' /tmp/out ' })
  assert.equal(limited.seconds, 300)
  assert.equal(limited.dir, '/tmp/out')
  assert.equal(limited.clicks, true)
})

test('shotArgs 只带系统认得的字段', () => {
  const args = shotArgs({ mode: 'clipboard', delaySec: 5, cursor: false })
  assert.deepEqual(args, { mode: 'clipboard', delaySec: 5, cursor: false, dir: undefined })
})

console.log(`\n通过 ${passed} 项`)
