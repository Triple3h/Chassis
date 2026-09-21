import assert from 'node:assert/strict'
import {
  FALLBACK_FEATURES,
  SHOT_MODES,
  backendLabel,
  formatBytes,
  formatClock,
  formatWhen,
  issueFromStart,
  issueFromStatusEnd,
  modeLabel,
  nextPollDelay,
  recordModes,
  shotArgs,
  startArgs,
} from '../src/core/recorder'
import type { Features } from '../src/core/recorder'

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

test('模式标签与后端标签', () => {
  assert.equal(modeLabel('full'), '全屏录制')
  assert.equal(modeLabel('region'), '区域录制')
  assert.equal(modeLabel(undefined), '录制')
  assert.equal(backendLabel('screencapture'), '系统 screencapture')
  assert.equal(backendLabel('ffmpeg'), 'ffmpeg (gdigrab)')
  assert.equal(backendLabel('none'), '无后端')
  assert.equal(backendLabel(undefined), '')
})

console.log('能力矩阵')

test('窗口录制按后端能力出现 / 消失', () => {
  const mac = recordModes({ ...FALLBACK_FEATURES, windowRecording: true })
  assert.deepEqual(mac.map((item) => item.value), ['full', 'region', 'window'])
  const win = recordModes({ ...FALLBACK_FEATURES, windowRecording: false })
  assert.deepEqual(win.map((item) => item.value), ['full', 'region'], 'Windows 端不出现「窗口录制」')
})

test('四种截图模式两端都有', () => {
  assert.deepEqual(SHOT_MODES.map((item) => item.value), ['full', 'region', 'window', 'clipboard'])
})

test('面板图标只用真实存在的图标名', () => {
  // UiIcon 表里没有 'maximize' / 'app-window'：写错只会回落成首字母，不报错
  const allowed = new Set(['video', 'file', 'columns', 'camera', 'clipboard'])
  for (const item of [...recordModes(FALLBACK_FEATURES), ...SHOT_MODES]) {
    assert.ok(allowed.has(item.icon), `图标名 ${item.icon} 不在允许集合里`)
  }
})

console.log('轮询')

test('轮询前 15 秒密集、之后放稀', () => {
  assert.equal(nextPollDelay(0), 1_000)
  assert.equal(nextPollDelay(14_999), 1_000)
  assert.equal(nextPollDelay(15_000), 5_000)
  assert.equal(nextPollDelay(3_600_000), 5_000, '一小时录制不该 spawn 3600 次脚本')
})

console.log('参数组装')

test('startArgs 把「不限时」翻译成 undefined，自定义目录留空则不传', () => {
  const args = startArgs({ mode: 'full', delaySec: 3, maxMinutes: 0, audio: true, clicks: false, cursor: true, dir: '   ' })
  assert.equal(args.mode, 'full')
  assert.equal(args.delaySec, 3)
  assert.equal(args.seconds, undefined)
  assert.equal(args.audio, true)
  assert.equal(args.cursor, true, '「显示指针」要能传到录制侧')
  assert.equal(args.dir, undefined)
  const limited = startArgs({ mode: 'region', delaySec: 0, maxMinutes: 5, audio: false, clicks: true, cursor: false, dir: ' /tmp/out ' })
  assert.equal(limited.seconds, 300)
  assert.equal(limited.dir, '/tmp/out')
  assert.equal(limited.clicks, true)
})

test('shotArgs 只带系统认得的字段', () => {
  const args = shotArgs({ mode: 'clipboard', delaySec: 5, cursor: false })
  assert.deepEqual(args, { mode: 'clipboard', delaySec: 5, cursor: false, dir: undefined })
})

console.log('失败 → 可行动')

test('权限不足给「打开系统设置」', () => {
  const issue = issueFromStart({ ok: false, code: 'PERMISSION', error: '系统还没给屏幕录制权限', detail: 'could not create image from display' })
  assert.equal(issue?.tone, 'error')
  assert.deepEqual(issue?.actions?.map((a) => a.id), ['settings'])
  assert.equal(issue?.detail, 'could not create image from display', '把后端原始输出带出来，便于排查')
})

test('麦克风问题给「改用无声录制」（macOS 才给麦克风授权入口）', () => {
  const mac = issueFromStart({ ok: false, code: 'AUDIO_UNAVAILABLE', retryWithoutAudio: true }, true)
  assert.deepEqual(mac?.actions?.map((a) => a.id), ['retry-silent', 'mic-settings'])
  const win = issueFromStart({ ok: false, code: 'AUDIO_UNAVAILABLE', retryWithoutAudio: true }, false)
  assert.deepEqual(win?.actions?.map((a) => a.id), ['retry-silent'])
})

test('缺依赖 / 已在录 / 孤儿录制各有出路', () => {
  assert.deepEqual(issueFromStart({ ok: false, code: 'DEPENDENCY_MISSING' })?.actions?.map((a) => a.id), ['open-dep'])
  assert.deepEqual(issueFromStart({ ok: false, code: 'BUSY' })?.actions?.map((a) => a.id), ['stop'])
  assert.deepEqual(issueFromStart({ ok: false, code: 'ORPHAN' })?.actions?.map((a) => a.id), ['stop'])
  assert.equal(issueFromStart({ ok: false, code: 'CANCELLED' })?.tone, 'info', '取消不是错误')
})

test('成功与空结果不产生横幅', () => {
  assert.equal(issueFromStart({ ok: true }), null)
  assert.equal(issueFromStart(null), null)
})

test('录制结束时没有产物要如实说', () => {
  assert.equal(issueFromStatusEnd({ recording: false, last: { path: '/a.mov', size: 10, mtimeMs: 1 } }), null)
  const missing = issueFromStatusEnd({ recording: false, last: null })
  assert.equal(missing?.tone, 'error')
  assert.match(missing?.message ?? '', /没有拿到文件/)
  const cancelled = issueFromStatusEnd({ recording: false, last: null, interactive: true })
  assert.match(cancelled?.message ?? '', /框选被取消/)
})

test('能力矩阵缺省值保守（拿不到 env 时按旧行为放行）', () => {
  assert.equal(FALLBACK_FEATURES.audio, true)
  assert.equal(FALLBACK_FEATURES.clicks, true)
  assert.equal(FALLBACK_FEATURES.delayInInteractive, false, '缺省按 macOS 口径：交互式不吃延迟')
  const features: Features = FALLBACK_FEATURES
  assert.deepEqual(features.notes, [])
})

console.log(`\n通过 ${passed} 项`)
