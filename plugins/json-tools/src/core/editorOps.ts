/**
 * 编辑器块操作：Tab 缩进 / Shift+Tab 反缩进 / Enter 自动缩进。
 *
 * 全是纯函数：文本 + 选区进，「替换哪一段、换成什么、选区落在哪」出。
 * 编辑器拿这个结果去调 `execCommand('insertText')`，因此每次操作只产生
 * **一步**撤销记录（而不是逐行改 N 次）。
 */
export interface BlockEdit {
  /** 被替换的区间（通常扩到整行范围） */
  from: number
  to: number
  /** 替换文本 */
  text: string
  /** 替换后应设置的选区（绝对偏移） */
  selStart: number
  selEnd: number
}

/** 偏移 → 行号（0 起；空文档返回 0） */
export function lineOfOffset(starts: Int32Array, count: number, offset: number): number {
  let lo = 0
  let hi = count - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 该行内容的结束偏移（独占，不含换行符与行尾的 `\r`） */
export function lineEndOffset(text: string, starts: Int32Array, count: number, line: number): number {
  if (line < 0) return 0
  const to = line + 1 < count ? starts[line + 1] - 1 : text.length
  return to > 0 && text.charCodeAt(to - 1) === 13 ? to - 1 : to
}

/** 该行行首缩进（连续空格 / 制表符）的长度 */
export function lineIndentLength(text: string, from: number, to: number): number {
  let n = 0
  while (from + n < to) {
    const c = text.charCodeAt(from + n)
    if (c !== 32 && c !== 9) break
    n++
  }
  return n
}

interface Splice {
  from: number
  to: number
  text: string
}

/**
 * 在 `[from, to)` 上应用一串**升序、互不重叠**的替换，
 * 并给出「旧偏移 → 新偏移」的映射（用于把选区跟着挪过去）。
 */
function applySplices(text: string, from: number, to: number, sps: Splice[]) {
  let block = ''
  let cursor = from
  for (const s of sps) {
    block += text.slice(cursor, s.from) + s.text
    cursor = s.to
  }
  block += text.slice(cursor, to)

  function map(p: number): number {
    let delta = 0
    for (const s of sps) {
      if (p >= s.to) delta += s.to - s.from - s.text.length
      else if (p > s.from) {
        delta += p - s.from - s.text.length
        break
      } else break
    }
    return p - delta
  }

  return { block, map }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 选区覆盖到的行范围（末尾正好落在行首时，不把那一行算进来） */
function touchedLines(
  starts: Int32Array,
  count: number,
  selStart: number,
  selEnd: number,
): [number, number] {
  const first = lineOfOffset(starts, count, selStart)
  const last = selEnd > selStart ? lineOfOffset(starts, count, selEnd - 1) : first
  return [Math.min(first, last), Math.max(first, last)]
}

/** Tab：选区跨行就整行缩进，否则在光标处插入一个缩进单位 */
export function indentBlock(
  text: string,
  starts: Int32Array,
  count: number,
  selStart: number,
  selEnd: number,
  unit: string,
): BlockEdit {
  if (selEnd <= selStart) {
    const at = selStart + unit.length
    return { from: selStart, to: selEnd, text: unit, selStart: at, selEnd: at }
  }
  const [first, last] = touchedLines(starts, count, selStart, selEnd)
  const from = starts[first]
  const to = lineEndOffset(text, starts, count, last)
  const sps: Splice[] = []
  for (let l = first; l <= last; l++) sps.push({ from: starts[l], to: starts[l], text: unit })
  const { block, map } = applySplices(text, from, to, sps)
  const hi = from + block.length
  return { from, to, text: block, selStart: clamp(map(selStart), from, hi), selEnd: clamp(map(selEnd), from, hi) }
}

/** Shift+Tab：每行吃掉一份缩进；一行都吃不掉时返回 null（不产生编辑） */
export function dedentBlock(
  text: string,
  starts: Int32Array,
  count: number,
  selStart: number,
  selEnd: number,
  unit: string,
): BlockEdit | null {
  const [first, last] = touchedLines(starts, count, selStart, selEnd)
  const from = starts[first]
  const to = lineEndOffset(text, starts, count, last)
  const sps: Splice[] = []
  for (let l = first; l <= last; l++) {
    const ls = starts[l]
    const cut = indentWidthToRemove(text, ls, lineEndOffset(text, starts, count, l), unit)
    if (cut > 0) sps.push({ from: ls, to: ls + cut, text: '' })
  }
  if (sps.length === 0) return null
  const { block, map } = applySplices(text, from, to, sps)
  const hi = from + block.length
  return { from, to, text: block, selStart: clamp(map(selStart), from, hi), selEnd: clamp(map(selEnd), from, hi) }
}

/** 这一行行首能吃掉几个字符的缩进（有制表符就吃制表符；否则最多吃一份空格） */
function indentWidthToRemove(text: string, from: number, to: number, unit: string): number {
  if (from >= to) return 0
  if (text.charCodeAt(from) === 9) return 1
  if (unit.charCodeAt(0) === 9) return 0
  let n = 0
  while (n < unit.length && from + n < to && text.charCodeAt(from + n) === 32) n++
  return n
}

/**
 * Enter：换行 + 沿用当前行缩进；上一行停在 `{` / `[` 后面时再进一级。
 */
export function enterBlock(
  text: string,
  starts: Int32Array,
  count: number,
  selStart: number,
  selEnd: number,
  unit: string,
): BlockEdit {
  const offset = selStart
  const line = lineOfOffset(starts, count, offset)
  const ls = starts[line]
  let leadEnd = ls
  while (leadEnd < text.length) {
    const c = text.charCodeAt(leadEnd)
    if (c !== 32 && c !== 9) break
    leadEnd++
  }
  // 光标停在缩进中间时只用光标前面那一段
  const pad = text.slice(ls, Math.min(leadEnd, offset))

  let k = offset - 1
  while (k >= ls && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k--
  const prev = k >= ls ? text.charCodeAt(k) : 0
  const extra = prev === 123 || prev === 91 ? unit : ''

  const insert = `\n${pad}${extra}`
  const at = offset + insert.length
  return { from: selStart, to: selEnd, text: insert, selStart: at, selEnd: at }
}
