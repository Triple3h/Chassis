import assert from 'node:assert/strict'
import { appendRow, clearPad, createPad, padScope, padText, recompute, removeRow, renamePad, setNote, updateRow } from '../src/core/pads'
import { formatNumber, formatPlain, parseNumber } from '../src/core/format'

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

console.log('数字格式化')

test('千分位与浮点噪声', () => {
  assert.equal(formatNumber(4175270), '4,175,270')
  assert.equal(formatNumber(0.1 + 0.2), '0.3')
  assert.equal(formatNumber(51599.25), '51,599.25')
  assert.equal(formatNumber(-1234.5), '-1,234.5')
})

test('极大极小走科学计数法', () => {
  assert.ok(formatNumber(1e20).includes('e'))
  assert.ok(formatNumber(1e-12).includes('e'))
})

test('formatPlain 不带千分位', () => {
  assert.equal(formatPlain(4175270), '4175270')
  assert.equal(formatPlain(0.1 + 0.2), '0.3')
})

test('parseNumber 容忍千分位', () => {
  assert.equal(parseNumber('1,234.5'), 1234.5)
  assert.equal(parseNumber('abc'), null)
})

console.log('稿纸求值')

test('逐行求值并把结果写回行上', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, '55 + 88 + 7689 * 543', 1001)
  pad = appendRow(pad, 'a = 10', 1002)
  pad = appendRow(pad, 'a * 2', 1003)
  assert.equal(pad.rows[0]?.text, '4,175,270')
  assert.equal(pad.rows[2]?.text, '20')
})

test('ans 带上一行结果', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, '20 * 2', 1001)
  pad = appendRow(pad, 'ans + 1', 1002)
  assert.equal(pad.rows[1]?.text, '41')
})

test('报错行不影响后面的行', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, '2 +', 1001)
  pad = appendRow(pad, '3 + 4', 1002)
  assert.ok(pad.rows[0]?.error)
  assert.equal(pad.rows[0]?.text, '')
  assert.equal(pad.rows[1]?.text, '7')
})

test('改一行会重算整张稿纸', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, 'a = 2', 1001)
  pad = appendRow(pad, 'a * 10', 1002)
  const firstRowId = pad.rows[0]?.id ?? ''
  pad = updateRow(pad, firstRowId, 'a = 5', 1003)
  assert.equal(pad.rows[1]?.text, '50')
})

test('删行 / 清空 / 备注 / 改名', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, '1 + 1', 1001)
  pad = appendRow(pad, '2 + 2', 1002)
  const secondId = pad.rows[1]?.id ?? ''
  pad = setNote(pad, secondId, '房租分摊')
  assert.equal(pad.rows[1]?.note, '房租分摊')
  pad = removeRow(pad, secondId, 1003)
  assert.equal(pad.rows.length, 1)
  pad = renamePad(pad, '十月预算', 1004)
  assert.equal(pad.title, '十月预算')
  pad = clearPad(pad, 1005)
  assert.equal(pad.rows.length, 0)
  assert.equal(pad.title, '十月预算', '清空稿纸不该动标题')
})

test('padScope 拿到最后一行的作用域', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, 'a = 4', 1001)
  const scope = padScope(pad)
  assert.equal(scope.vars.a, 4)
  assert.equal(scope.last, 4)
})

test('recompute 幂等', () => {
  let pad = createPad(1000)
  pad = appendRow(pad, '3 * 3', 1001)
  assert.deepEqual(recompute(pad), pad)
})

test('padText 导出纯文本', () => {
  let pad = createPad(1000, '十月预算')
  pad = appendRow(pad, '10 * 3', 1001)
  pad = setNote(pad, pad.rows[0]?.id ?? '', '每月订阅')
  assert.equal(padText(pad), '# 十月预算\n10 * 3 = 30  // 每月订阅')
})

console.log(`\n通过 ${passed} 项`)
