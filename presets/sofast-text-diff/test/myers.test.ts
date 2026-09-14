import assert from 'node:assert/strict'
import { diffInts, groupOps, type EditOp } from '../src/core/myers'

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

/**
 * 两份文本共用一个 line→id 映射，才能让相同行拿到相同的整数。
 * （各自独立映射会把毫不相干的文本判成全等，这正是踩过的坑）
 */
function toIds(text: string): Int32Array {
  return pair(text, '').a
}

function pair(textA: string, textB: string): { a: Int32Array; b: Int32Array; linesA: string[]; linesB: string[] } {
  const map = new Map<string, number>()
  const id = (s: string) => {
    let v = map.get(s)
    if (v === undefined) {
      v = map.size
      map.set(s, v)
    }
    return v
  }
  const linesA = textA ? textA.split('\n') : []
  const linesB = textB ? textB.split('\n') : []
  return { a: Int32Array.from(linesA.map(id)), b: Int32Array.from(linesB.map(id)), linesA, linesB }
}

/** 把操作应用到 A 上，应还原出 B */
function applyOps(a: string[], b: string[], ops: EditOp[]): string[] {
  const out: string[] = []
  for (const op of ops) {
    if (op.kind === 'eq') {
      for (let i = op.a0; i < op.a1; i++) out.push(a[i])
    } else if (op.kind === 'ins') {
      for (let i = op.b0; i < op.b1; i++) out.push(b[i])
    }
  }
  return out
}

/** 操作序列必须完整覆盖两侧、且不重不漏 */
function assertCoverage(n: number, m: number, ops: EditOp[]) {
  let aPos = 0
  let bPos = 0
  for (const op of ops) {
    assert.equal(op.a0, aPos, 'A 侧区间必须连续')
    assert.equal(op.b0, bPos, 'B 侧区间必须连续')
    aPos = op.kind === 'ins' ? op.a1 : op.a1
    bPos = op.kind === 'del' ? op.b1 : op.b1
    if (op.kind === 'eq') {
      assert.equal(op.a1 - op.a0, op.b1 - op.b0, 'eq 段两侧长度必须一致')
    }
    if (op.kind === 'del') assert.equal(op.a1 > op.a0, true)
    if (op.kind === 'ins') assert.equal(op.b1 > op.b0, true)
  }
  assert.equal(aPos, n, 'A 侧应被完整覆盖')
  assert.equal(bPos, m, 'B 侧应被完整覆盖')
}

/** DP 求最长公共子序列长度，作为最优编辑距离的基准 */
function lcsLength(a: number[], b: number[]): number {
  const n = a.length
  const m = b.length
  let prev = new Int32Array(m + 1)
  let cur = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const tmp = prev
    prev = cur
    cur = tmp
    cur.fill(0)
  }
  return prev[m]
}

function editDistance(ops: EditOp[]): number {
  let d = 0
  for (const op of ops) {
    if (op.kind === 'del') d += op.a1 - op.a0
    else if (op.kind === 'ins') d += op.b1 - op.b0
  }
  return d
}

console.log('myers 基础')

test('完全相同 / 空输入', () => {
  const same = pair('a\nb\nc', 'a\nb\nc')
  assert.equal(diffInts(same.a, same.b).length, 1)
  assert.equal(diffInts(new Int32Array(0), new Int32Array(0)).length, 0)
  const ins = diffInts(new Int32Array(0), Int32Array.from([0]))
  assert.deepEqual(ins, [{ kind: 'ins', a0: 0, a1: 0, b0: 0, b1: 1 }])
  const del = diffInts(Int32Array.from([0]), new Int32Array(0))
  assert.deepEqual(del, [{ kind: 'del', a0: 0, a1: 1, b0: 0, b1: 0 }])
})

test('单行插入与删除', () => {
  const p = pair('a\nb\nc', 'a\nx\nb\nc')
  const ops = diffInts(p.a, p.b)
  assert.deepEqual(
    ops.map((o) => o.kind),
    ['eq', 'ins', 'eq'],
  )
  assert.equal(ops[1].b1 - ops[1].b0, 1)
  assert.deepEqual(applyOps(p.linesA, p.linesB, ops), ['a', 'x', 'b', 'c'])
})

test('替换一行会被识别为删 + 插', () => {
  const p = pair('a\nb\nc', 'a\nz\nc')
  const ops = diffInts(p.a, p.b)
  assert.equal(editDistance(ops), 2)
  assert.deepEqual(applyOps(p.linesA, p.linesB, ops), ['a', 'z', 'c'])
})

test('groupOps 把删插配成变更块', () => {
  const p = pair('a\nb\nc', 'a\nz\nc')
  const blocks = groupOps(diffInts(p.a, p.b))
  assert.equal(blocks.length, 3)
  assert.ok(blocks[1].del && blocks[1].ins)
  assert.ok(blocks[0].eq && blocks[2].eq)
})

console.log('myers 正确性（随机对拍 DP）')

test('300 组随机输入：可还原 + 编辑距离最优', () => {
  let rng = 123456789
  const rand = (n: number) => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    return rng % n
  }
  for (let round = 0; round < 300; round++) {
    const lenA = rand(40)
    const lenB = rand(40)
    const alphabet = 1 + rand(4)
    const a: number[] = Array.from({ length: lenA }, () => rand(alphabet))
    const b: number[] = Array.from({ length: lenB }, () => rand(alphabet))
    const ops = diffInts(Int32Array.from(a), Int32Array.from(b))
    assertCoverage(a.length, b.length, ops)
    const rebuilt = applyOps(
      a.map(String),
      b.map(String),
      ops,
    ).map(Number)
    assert.deepEqual(rebuilt, b, `第 ${round} 组：还原失败`)
    const expected = a.length + b.length - 2 * lcsLength(a, b)
    assert.equal(editDistance(ops), expected, `第 ${round} 组：编辑距离不是最优`)
  }
})

test('边界样本：交错 / 全删全增 / 单元素', () => {
  const cases: Array<[number[], number[]]> = [
    [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1]],
    [[1, 1, 1, 1], [1]],
    [[1], [1, 1, 1, 1]],
    [[1, 2], [3, 4]],
    [[0], []],
    [[], [0]],
    [Array.from({ length: 60 }, (_, i) => i % 7), Array.from({ length: 55 }, (_, i) => (i + 3) % 5)],
  ]
  for (const [a, b] of cases) {
    const ops = diffInts(Int32Array.from(a), Int32Array.from(b))
    assertCoverage(a.length, b.length, ops)
    assert.deepEqual(applyOps(a.map(String), b.map(String), ops).map(Number), b)
    assert.equal(editDistance(ops), a.length + b.length - 2 * lcsLength(a, b))
  }
  const textCases: Array<[string, string]> = [
    ['', 'x'],
    ['x', ''],
    ['a\nb\nc\nd', 'd\nc\nb\na'],
    ['只有一行', '只有一行\n第二行'],
  ]
  for (const [ta, tb] of textCases) {
    const p = pair(ta, tb)
    const ops = diffInts(p.a, p.b)
    assertCoverage(p.linesA.length, p.linesB.length, ops)
    assert.deepEqual(applyOps(p.linesA, p.linesB, ops), p.linesB)
  }
})

console.log('myers 性能')

test('2 万行、100 处修改 < 200ms', () => {
  const base = Array.from({ length: 20_000 }, (_, i) => `line ${i} 一些内容 ${(i * 7) % 13}`)
  const changed = [...base]
  for (let i = 0; i < 100; i++) changed[i * 197] = `修改后的第 ${i} 行`
  const p = pair(base.join('\n'), changed.join('\n'))
  const t0 = performance.now()
  const ops = diffInts(p.a, p.b)
  const dt = performance.now() - t0
  console.log(`    耗时 ${dt.toFixed(1)}ms，${ops.length} 段`)
  assert.ok(dt < 200, `耗时 ${dt.toFixed(0)}ms`)
  assert.deepEqual(applyOps(p.linesA, p.linesB, ops), changed)
})

test('2 万行全不相同 < 600ms 且结果可用', () => {
  const a = Array.from({ length: 20_000 }, (_, i) => `a${i}`)
  const b = Array.from({ length: 20_000 }, (_, i) => `b${i}`)
  const p = pair(a.join('\n'), b.join('\n'))
  const t0 = performance.now()
  const ops = diffInts(p.a, p.b)
  const dt = performance.now() - t0
  assertCoverage(20_000, 20_000, ops)
  assert.deepEqual(applyOps(p.linesA, p.linesB, ops), b)
  console.log(`    耗时 ${dt.toFixed(1)}ms`)
  assert.ok(dt < 600, `耗时 ${dt.toFixed(0)}ms`)
})

test('10 万行、少量改动 < 900ms', () => {
  const base = Array.from({ length: 100_000 }, (_, i) => `row-${i}`)
  const next = [...base]
  next[50] = 'X'
  next[50_000] = 'Y'
  const p = pair(base.join('\n'), next.join('\n'))
  const t0 = performance.now()
  const ops = diffInts(p.a, p.b, { deadlineMs: 2000 })
  const dt = performance.now() - t0
  console.log(`    耗时 ${dt.toFixed(1)}ms，${ops.length} 段`)
  assert.ok(dt < 900, `耗时 ${dt.toFixed(0)}ms`)
})

console.log(`\n通过 ${passed} 项`)
