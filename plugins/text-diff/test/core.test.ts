import assert from 'node:assert/strict'
import { computeDiff, inlineDiff, splitLines, toUnified } from '../src/core/diff'
import { diffInts } from '../src/core/myers'

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

console.log('行切分')

test('splitLines 处理 CRLF 与末尾换行', () => {
  assert.deepEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('\n'), [''])
})

console.log('行级比对')

test('修改一行', () => {
  const res = computeDiff('a\nb\nc', 'a\nx\nc')
  assert.deepEqual(
    res.rows.map((r) => r.kind),
    ['eq', 'mod', 'eq'],
  )
  assert.equal(res.rows[1].left, 'b')
  assert.equal(res.rows[1].right, 'x')
  assert.equal(res.rows[1].leftNo, 2)
  assert.equal(res.rows[1].rightNo, 2)
  assert.equal(res.stats.changed, 1)
  assert.equal(res.stats.equal, 2)
})

test('新增与删除', () => {
  const added = computeDiff('a\nc', 'a\nb\nc')
  assert.deepEqual(
    added.rows.map((r) => r.kind),
    ['eq', 'ins', 'eq'],
  )
  assert.equal(added.stats.added, 1)

  const removed = computeDiff('a\nb\nc', 'a\nc')
  assert.equal(removed.stats.removed, 1)
  assert.deepEqual(
    removed.rows.map((r) => r.kind),
    ['eq', 'del', 'eq'],
  )
})

test('多行替换会逐行配对', () => {
  const res = computeDiff('a\n1\n2\n3\nb', 'a\nx\ny\nb')
  const kinds = res.rows.map((r) => r.kind)
  assert.deepEqual(kinds, ['eq', 'mod', 'mod', 'del', 'eq'])
})

test('折叠大段相同内容', () => {
  const common = Array.from({ length: 100 }, (_, i) => `line ${i}`)
  const a = [...common, 'change-a'].join('\n')
  const b = [...common, 'change-b'].join('\n')
  const res = computeDiff(a, b)
  const skip = res.rows.find((r) => r.kind === 'skip')
  assert.ok(skip, '应该有折叠行')
  assert.ok((skip?.skipped ?? 0) > 90)
  // 关闭折叠后行数应等于总行数
  const full = computeDiff(a, b, { collapse: false })
  assert.equal(full.rows.length, 101)
  assert.equal(full.rows.filter((r) => r.kind === 'skip').length, 0)
})

test('忽略大小写与空白', () => {
  const a = 'Hello World\n  indented\ttext  \nEnd'
  const b = 'hello world\nindented text\nEnd'
  // 默认严格比较：大小写与空白差异都算改动
  assert.ok(computeDiff(a, b).rows.filter((r) => r.kind !== 'eq' && r.kind !== 'skip').length > 0)
  // 开启忽略后应完全一致
  const relaxed = computeDiff(a, b, { ignoreCase: true, ignoreWhitespace: true })
  assert.equal(
    relaxed.rows.filter((r) => r.kind === 'mod' || r.kind === 'del' || r.kind === 'ins').length,
    0,
  )
})

test('两侧文本可完整还原', () => {
  const a = 'a\nb\nc\nd\ne'
  const b = 'a\nB\nc\nx\ne\nf'
  const res = computeDiff(a, b, { collapse: false })
  const left = res.rows.filter((r) => r.leftNo > 0).map((r) => r.left)
  const right = res.rows.filter((r) => r.rightNo > 0).map((r) => r.right)
  // 折叠关闭时行号连续，直接比对原文
  assert.deepEqual(left, a.split('\n'))
  assert.deepEqual(right, b.split('\n'))
})

console.log('字符级内联')

test('内联片段能拼回原文', () => {
  const { leftSegs, rightSegs } = inlineDiff('const a = 1', 'const a = 2')
  assert.equal(leftSegs.map((s) => s.t).join(''), 'const a = 1')
  assert.equal(rightSegs.map((s) => s.t).join(''), 'const a = 2')
  assert.equal(leftSegs.filter((s) => s.hl).map((s) => s.t).join(''), '1')
  assert.equal(rightSegs.filter((s) => s.hl).map((s) => s.t).join(''), '2')
})

test('中文与 emoji 也能处理', () => {
  const { leftSegs, rightSegs } = inlineDiff('今天天气不错', '今天天气很好')
  assert.equal(leftSegs.map((s) => s.t).join(''), '今天天气不错')
  assert.equal(rightSegs.map((s) => s.t).join(''), '今天天气很好')
})

test('超长行不做字符级拆分', () => {
  const long = 'x'.repeat(3000)
  const { leftSegs } = inlineDiff(long, `${long}y`)
  assert.equal(leftSegs.length, 1)
  assert.equal(leftSegs[0].hl, true)
})

test('配对行的内联高亮会写进 rows', () => {
  const res = computeDiff('value = 100', 'value = 200')
  const row = res.rows.find((r) => r.kind === 'mod')
  assert.ok(row?.leftSegs?.some((s) => s.hl))
  assert.equal(row?.leftSegs?.map((s) => s.t).join(''), 'value = 100')
})

console.log('unified 输出')

test('unified diff 格式正确', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
  const b = ['1', '2', '3', '4', '5', 'x', '7', '8', '9', '10']
  const ops = diffInts(
    Int32Array.from(a.map((_, i) => i)),
    Int32Array.from(b.map((v) => (v === 'x' ? 100 : Number(v) - 1))),
  )
  const text = toUnified(a, b, ops, 3)
  const lines = text.split('\n')
  assert.equal(lines[0], '--- 原始')
  assert.equal(lines[1], '+++ 修改后')
  assert.match(lines[2], /^@@ -\d+,\d+ \+\d+,\d+ @@$/)
  assert.ok(lines.includes('-6'))
  assert.ok(lines.includes('+x'))
  assert.ok(lines.length < 14, '应该只输出上下文附近的行')
})

test('无差异时 unified 只有头', () => {
  const a = ['x', 'y']
  const ops = diffInts(Int32Array.from([0, 1]), Int32Array.from([0, 1]))
  assert.equal(toUnified(a, a, ops).split('\n').length, 2)
})

console.log('性能与健壮性')

test('1 万行、200 处改动 < 400ms', () => {
  const base = Array.from({ length: 10_000 }, (_, i) => `line ${i} content ${(i * 13) % 97}`)
  const next = [...base]
  for (let i = 0; i < 200; i++) next[i * 41] = `changed ${i}`
  const t0 = performance.now()
  const res = computeDiff(base.join('\n'), next.join('\n'))
  const dt = performance.now() - t0
  console.log(`    耗时 ${dt.toFixed(0)}ms，${res.rows.length} 行，${res.stats.hunks} 个变更块`)
  assert.ok(dt < 400, `耗时 ${dt.toFixed(0)}ms`)
  assert.ok(res.stats.changed >= 100)
})

test('3 万行、大量散落改动 < 1200ms', () => {
  const base = Array.from({ length: 30_000 }, (_, i) => `row-${i}-${i % 17}`)
  const next = base.map((l, i) => (i % 3 === 0 ? `CHANGED-${i}` : l))
  const t0 = performance.now()
  const res = computeDiff(base.join('\n'), next.join('\n'))
  const dt = performance.now() - t0
  console.log(`    耗时 ${dt.toFixed(0)}ms，${res.rows.length} 行，降级=${res.degraded}`)
  assert.ok(dt < 1200, `耗时 ${dt.toFixed(0)}ms`)
})

test('两份完全不同的 2 万行文本 < 2s', () => {
  const a = Array.from({ length: 20_000 }, (_, i) => `alpha-${i}`).join('\n')
  const b = Array.from({ length: 20_000 }, (_, i) => `beta-${i}`).join('\n')
  const t0 = performance.now()
  const res = computeDiff(a, b)
  const dt = performance.now() - t0
  console.log(`    耗时 ${dt.toFixed(0)}ms`)
  assert.ok(dt < 2000, `耗时 ${dt.toFixed(0)}ms`)
  assert.ok(res.rows.length > 0)
})

test('空输入 / 单侧为空', () => {
  assert.equal(computeDiff('', '').rows.length, 0)
  assert.equal(computeDiff('', 'a\nb').rows.filter((r) => r.kind === 'ins').length, 2)
  assert.equal(computeDiff('a\nb', '').rows.filter((r) => r.kind === 'del').length, 2)
})

test('相同文本没有任何变更行', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')
  const res = computeDiff(text, text)
  assert.equal(res.rows.filter((r) => r.kind === 'mod' || r.kind === 'del' || r.kind === 'ins').length, 0)
  assert.equal(res.stats.hunks, 0)
})

console.log(`\n通过 ${passed} 项`)
