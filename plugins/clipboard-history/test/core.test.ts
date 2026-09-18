import assert from 'node:assert/strict'
import { detailOf, formatDateTime, formatTime, kindIcon, pauseLabel } from '../src/core/format'
import type { HistoryEntry } from '../src/core/types'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

function entry(patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: 'text:abc',
    kind: 'text',
    title: '标题',
    subtitle: '刚刚 · 12 字',
    createdAt: 0,
    pinned: false,
    uses: 1,
    hasBlob: false,
    ...patch,
  }
}

console.log('format')

await test('时间补零到本地时区', () => {
  const ts = new Date(2026, 8, 18, 9, 5).getTime()
  assert.equal(formatTime(ts), '09:05')
  assert.equal(formatDateTime(ts), '9-18 09:05')
  assert.equal(formatDateTime(0), '')
})

await test('暂停说明区分「定时」与「手动」', () => {
  assert.equal(pauseLabel(0, 0), '', '没暂停时不显示')
  assert.match(pauseLabel(Number.MAX_SAFE_INTEGER, 0), /手动恢复/)
  const now = 1_000_000
  assert.match(pauseLabel(now + 5 * 60_000, now), /约 5 分钟后恢复/)
  assert.equal(pauseLabel(now - 1, now), '', '过点了就不该再显示')
})

await test('图标与详情按类型分流', () => {
  assert.equal(kindIcon('text'), 'clipboard')
  assert.equal(kindIcon('image'), 'image')
  assert.equal(kindIcon('file'), 'folder')

  assert.equal(detailOf(entry({ text: 'hello' })), 'hello')
  assert.equal(detailOf(entry({ kind: 'image', width: 800, height: 600 })), '800×600')
  assert.equal(detailOf(entry({ kind: 'image' })), '图片')
  assert.equal(detailOf(entry({ kind: 'file', paths: ['C:\\a\\b.txt', 'C:\\a\\c.txt'] })), 'C:\\a\\b.txt  C:\\a\\c.txt')
  assert.equal(detailOf(entry({ kind: 'file' })), '')
})

console.log(`\n${passed} 个用例通过`)
