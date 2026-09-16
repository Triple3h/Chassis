import { diffInts, type EditOp } from './myers'

/**
 * 文本比对的上层编排。
 *
 * 三层策略，保证「小文件精确、大文件不卡」：
 *   1. 行级：共用 line→id 映射把字符串比较降级成整数比较，
 *      再用 patience 式的「唯一公共行」锚点把大问题切成小段；
 *   2. 段内：交给 Myers（线性空间分治）求最优解，带时间预算与 maxD 上限；
 *   3. 字符级：只对配对的「改动行」做内联 diff，长度超限直接整行标记，不硬算。
 */

export interface DiffOptions {
  ignoreCase?: boolean
  /** 忽略行首尾空白，并把行内连续空白折叠成一个空格 */
  ignoreWhitespace?: boolean
  ignoreBlankLines?: boolean
  /** 是否计算字符级内联差异 */
  inline?: boolean
  /** 折叠长段相同内容，只保留上下文行 */
  collapse?: boolean
  contextLines?: number
  /** 时间预算（毫秒） */
  deadlineMs?: number
}

export interface Seg {
  t: string
  hl: boolean
}

export type RowKind = 'eq' | 'del' | 'ins' | 'mod' | 'skip'

export interface Row {
  kind: RowKind
  /** 左侧行号（1 基，0 表示该侧无此行） */
  leftNo: number
  rightNo: number
  left: string
  right: string
  leftSegs?: Seg[]
  rightSegs?: Seg[]
  /** 折叠了多少行（kind === 'skip'） */
  skipped?: number
}

export interface DiffStats {
  added: number
  removed: number
  changed: number
  equal: number
  hunks: number
}

export interface DiffResult {
  rows: Row[]
  stats: DiffStats
  unified: string
  /** 因规模保护而做了粗略处理 */
  degraded: boolean
  ms: number
}

/* --------------------------------------------------------------- 行预处理 */

export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  // 末尾换行会产生一个空元素，按惯例忽略
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => (l.charCodeAt(l.length - 1) === 13 ? l.slice(0, -1) : l))
}

function normalizeForCompare(line: string, options: DiffOptions): string {
  let out = line
  if (options.ignoreWhitespace) out = out.trim().replace(/\s+/g, ' ')
  if (options.ignoreCase) out = out.toLowerCase()
  return out
}

function buildIndex(lines: string[], map: Map<string, number>, options: DiffOptions): { ids: Int32Array; keys: string[] } {
  const ids = new Int32Array(lines.length)
  const keys = new Array<string>(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const key = normalizeForCompare(lines[i], options)
    keys[i] = key
    let id = map.get(key)
    if (id === undefined) {
      id = map.size
      map.set(key, id)
    }
    ids[i] = id
  }
  return { ids, keys }
}

/* ------------------------------------------------------------ patience 锚点 */

/**
 * 找出「在两边都只出现一次」的行作为锚点。
 * 这类行几乎不可能是巧合匹配，拿它们切分问题能显著提升大文件的对齐质量，
 * 也是 git 的 patience diff 的核心思想。
 */
function uniqueAnchors(
  a: Int32Array,
  b: Int32Array,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  distinct: number,
): Array<[number, number]> {
  const countA = new Int32Array(distinct)
  const countB = new Int32Array(distinct)
  for (let i = a0; i < a1; i++) countA[a[i]]++
  for (let i = b0; i < b1; i++) countB[b[i]]++

  const posA = new Int32Array(distinct).fill(-1)
  const posB = new Int32Array(distinct).fill(-1)
  for (let i = a0; i < a1; i++) {
    const id = a[i]
    if (countA[id] === 1 && countB[id] === 1) posA[id] = i
  }
  for (let i = b0; i < b1; i++) {
    const id = b[i]
    if (countA[id] === 1 && countB[id] === 1) posB[id] = i
  }

  const candidates: Array<[number, number]> = []
  for (let i = a0; i < a1; i++) {
    const id = a[i]
    if (posA[id] === i && posB[id] >= b0) candidates.push([i, posB[id]])
  }
  if (candidates.length < 2) return candidates

  // 对 B 侧下标求最长递增子序列，保证锚点前后顺序一致
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Int32Array(candidates.length).fill(-1)
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i][1]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < v) lo = mid + 1
      else hi = mid
    }
    tails[lo] = v
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  }
  const out: Array<[number, number]> = []
  let cur = tailIdx[tails.length - 1]
  while (cur >= 0) {
    out.push(candidates[cur])
    cur = prev[cur]
  }
  out.reverse()
  return out
}

/* --------------------------------------------------------------- 主流程 */

export function computeDiff(textA: string, textB: string, options: DiffOptions = {}): DiffResult {
  const started = Date.now()
  const deadlineMs = options.deadlineMs ?? 1500
  const deadline = started + deadlineMs
  const linesA = splitLines(textA)
  const linesB = splitLines(textB)

  const map = new Map<string, number>()
  const idxA = buildIndex(linesA, map, options)
  const idxB = buildIndex(linesB, map, options)
  const distinct = map.size

  const ops: EditOp[] = []
  let degraded = false

  /** 逐段计算：大区间先用锚点切，小区间直接 Myers */
  function range(a0: number, a1: number, b0: number, b1: number, depth: number) {
    if (a0 >= a1 && b0 >= b1) return
    if (a0 >= a1) {
      ops.push({ kind: 'ins', a0: a0, a1: a0, b0, b1 })
      return
    }
    if (b0 >= b1) {
      ops.push({ kind: 'del', a0, a1, b0: b0, b1: b0 })
      return
    }
    const size = a1 - a0 + (b1 - b0)
    if (depth < 3 && size > 2000) {
      const anchors = uniqueAnchors(idxA.ids, idxB.ids, a0, a1, b0, b1, distinct)
      if (anchors.length) {
        let pa = a0
        let pb = b0
        for (const [ai, bi] of anchors) {
          range(pa, ai, pb, bi, depth + 1)
          ops.push({ kind: 'eq', a0: ai, a1: ai + 1, b0: bi, b1: bi + 1 })
          pa = ai + 1
          pb = bi + 1
        }
        range(pa, a1, pb, b1, depth + 1)
        return
      }
    }
    const remain = deadline - Date.now()
    const part = diffInts(idxA.ids.subarray(a0, a1), idxB.ids.subarray(b0, b1), {
      deadlineMs: Math.max(60, remain),
    })
    if (part.length === 1 && part[0].kind === 'del') degraded = true
    for (const op of part) {
      ops.push({ kind: op.kind, a0: op.a0 + a0, a1: op.a1 + a0, b0: op.b0 + b0, b1: op.b1 + b0 })
    }
  }

  range(0, linesA.length, 0, linesB.length, 0)

  const rows: Row[] = []
  const stats: DiffStats = { added: 0, removed: 0, changed: 0, equal: 0, hunks: 0 }
  let hasChange = false

  for (const op of ops) {
    if (op.kind === 'eq') {
      hasChange = false
      stats.equal += op.a1 - op.a0
      pushEqual(op)
    } else if (op.kind === 'del') {
      stats.removed += op.a1 - op.a0
      if (!hasChange) {
        hasChange = true
        stats.hunks++
      }
      for (let i = op.a0; i < op.a1; i++) {
        rows.push({ kind: 'del', leftNo: i + 1, rightNo: 0, left: linesA[i], right: '' })
      }
    } else {
      stats.added += op.b1 - op.b0
      if (!hasChange) {
        hasChange = true
        stats.hunks++
      }
      for (let i = op.b0; i < op.b1; i++) {
        rows.push({ kind: 'ins', leftNo: 0, rightNo: i + 1, left: '', right: linesB[i] })
      }
    }
  }

  // 相邻的删除段 + 插入段配对成「修改行」，并做字符级内联 diff
  if (options.inline !== false) pairChanges(rows)

  const unified = toUnified(linesA, linesB, ops, options.contextLines ?? 3)

  return {
    rows,
    stats: { ...stats, changed: countChanged(rows) },
    unified,
    degraded,
    ms: Date.now() - started,
  }

  function pushEqual(op: EditOp) {
    const len = op.a1 - op.a0
    const context = options.contextLines ?? 3
    const collapse = options.collapse !== false
    if (!collapse || len <= context * 2 + 2) {
      for (let i = op.a0; i < op.a1; i++) {
        rows.push({ kind: 'eq', leftNo: i + 1, rightNo: op.b0 + (i - op.a0) + 1, left: linesA[i], right: linesB[op.b0 + (i - op.a0)] })
      }
      return
    }
    for (let k = 0; k < context; k++) {
      const i = op.a0 + k
      rows.push({ kind: 'eq', leftNo: i + 1, rightNo: op.b0 + k + 1, left: linesA[i], right: linesB[op.b0 + k] })
    }
    const skipped = len - context * 2
    rows.push({ kind: 'skip', leftNo: 0, rightNo: 0, left: '', right: '', skipped })
    for (let k = 0; k < context; k++) {
      const i = op.a1 - context + k
      rows.push({ kind: 'eq', leftNo: i + 1, rightNo: op.b1 - context + k + 1, left: linesA[i], right: linesB[op.b1 - context + k] })
    }
  }
}

/**
 * 把「一整段变更」里的删除行与插入行两两配对，生成带内联高亮的修改行。
 * 注意不能假设顺序是「先删后插」——Myers 在部分输入上会先给插入，
 * 因此这里按整段收集两侧再做配对，顺带把未配对的删/插行归一化顺序。
 */
function pairChanges(rows: Row[]) {
  let i = 0
  while (i < rows.length) {
    const kind = rows[i].kind
    if (kind !== 'del' && kind !== 'ins') {
      i++
      continue
    }
    let end = i
    const dels: Row[] = []
    const inses: Row[] = []
    while (end < rows.length && (rows[end].kind === 'del' || rows[end].kind === 'ins')) {
      if (rows[end].kind === 'del') dels.push(rows[end])
      else inses.push(rows[end])
      end++
    }
    const pairs = Math.min(dels.length, inses.length)
    const next: Row[] = []
    for (let k = 0; k < pairs; k++) {
      const left = dels[k]
      const right = inses[k]
      const { leftSegs, rightSegs } = inlineDiff(left.left, right.right)
      next.push({
        kind: 'mod',
        leftNo: left.leftNo,
        rightNo: right.rightNo,
        left: left.left,
        right: right.right,
        leftSegs,
        rightSegs,
      })
    }
    for (let k = pairs; k < dels.length; k++) next.push(dels[k])
    for (let k = pairs; k < inses.length; k++) next.push(inses[k])
    rows.splice(i, end - i, ...next)
    i += next.length
  }
}

/** 字符级内联 diff */
export function inlineDiff(a: string, b: string): { leftSegs: Seg[]; rightSegs: Seg[] } {
  const MAX = 2000
  if (a === b) return { leftSegs: [{ t: a, hl: false }], rightSegs: [{ t: b, hl: false }] }
  if (a.length > MAX || b.length > MAX) {
    return { leftSegs: [{ t: a, hl: true }], rightSegs: [{ t: b, hl: true }] }
  }
  const codesA = new Int32Array(a.length)
  const codesB = new Int32Array(b.length)
  for (let i = 0; i < a.length; i++) codesA[i] = a.charCodeAt(i)
  for (let i = 0; i < b.length; i++) codesB[i] = b.charCodeAt(i)
  const ops = diffInts(codesA, codesB, { deadlineMs: 60, maxD: 2000 })
  const leftSegs: Seg[] = []
  const rightSegs: Seg[] = []
  const pushSeg = (arr: Seg[], text: string, hl: boolean) => {
    if (!text) return
    const last = arr[arr.length - 1]
    if (last && last.hl === hl) last.t += text
    else arr.push({ t: text, hl })
  }
  for (const op of ops) {
    if (op.kind === 'eq') {
      pushSeg(leftSegs, a.slice(op.a0, op.a1), false)
      pushSeg(rightSegs, b.slice(op.b0, op.b1), false)
    } else if (op.kind === 'del') {
      pushSeg(leftSegs, a.slice(op.a0, op.a1), true)
    } else {
      pushSeg(rightSegs, b.slice(op.b0, op.b1), true)
    }
  }
  return { leftSegs, rightSegs }
}

function countChanged(rows: Row[]): number {
  let changed = 0
  for (const row of rows) if (row.kind === 'mod') changed++
  return changed
}

/* --------------------------------------------------------- unified diff */

/** 生成标准 unified diff 文本，便于复制到别处或存成 .patch */
export function toUnified(linesA: string[], linesB: string[], ops: EditOp[], context = 3): string {
  const out: string[] = ['--- 原始', '+++ 修改后']
  // 先按「变更点 ±context」把操作切成若干 hunk
  const hunks: EditOp[][] = []
  let current: EditOp[] = []
  let pendingEq: EditOp[] = []
  for (const op of ops) {
    if (op.kind === 'eq') {
      const len = op.a1 - op.a0
      if (current.length) {
        if (len > context * 2) {
          current.push({ ...op, a1: op.a0 + context, b1: op.b0 + context })
          hunks.push(current)
          current = []
          pendingEq = [{ ...op, a0: op.a1 - context, b0: op.b1 - context }]
        } else {
          current.push(op)
        }
      } else {
        pendingEq = [{ ...op, a0: Math.max(op.a0, op.a1 - context), b0: Math.max(op.b0, op.b1 - context) }]
      }
      continue
    }
    if (!current.length && pendingEq.length) {
      current.push(...pendingEq)
      pendingEq = []
    }
    current.push(op)
  }
  if (current.length) hunks.push(current)

  for (const hunk of hunks) {
    const aStart = hunk[0].a0
    const bStart = hunk[0].b0
    const aLen = hunk[hunk.length - 1].a1 - aStart
    const bLen = hunk[hunk.length - 1].b1 - bStart
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`)
    for (const op of hunk) {
      if (op.kind === 'eq') {
        for (let i = op.a0; i < op.a1; i++) out.push(` ${linesA[i]}`)
      } else if (op.kind === 'del') {
        for (let i = op.a0; i < op.a1; i++) out.push(`-${linesA[i]}`)
      } else {
        for (let i = op.b0; i < op.b1; i++) out.push(`+${linesB[i]}`)
      }
    }
  }
  return out.join('\n')
}
