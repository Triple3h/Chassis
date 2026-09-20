/**
 * 行级折叠：扫一遍文本，把配对的 `{` / `[` 记到**起始行**上。
 *
 * 编辑器是「固定行高 + 虚拟滚动」的，所以折叠只要行级信息就够：
 * 折叠第 L 行 = 隐藏 `L+1 .. 收尾括号所在行`。字符串里的括号会被跳过，
 * 所以 `"a{b"` 不会把后面的结构带歪；严格 / 宽松 JSON 都能用。
 */
export interface FoldInfo {
  /** 行 → 折叠终点行（0 起）；不可折叠为 -1 */
  ends: Int32Array
  /** 行 → 折叠起点在该行里的列（`{` / `[` 的下标）；不可折叠为 -1 */
  cols: Int32Array
  /** 行 → 收尾括号字符码（125 = `}` / 93 = `]`）；不可折叠为 0 */
  closers: Int32Array
  /** 可折叠的行号（升序） */
  lines: Int32Array
}

const NONE = new Int32Array(0)

export const EMPTY_FOLDS: FoldInfo = {
  ends: NONE,
  cols: NONE,
  closers: NONE,
  lines: NONE,
}

function countLines(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * 逐个字符扫描，用栈配对括号。
 * 同一行里有多个开括号时取**最外层**那个（收尾最晚的），折叠一行就收掉整块。
 */
export function computeFolds(text: string): FoldInfo {
  if (!text) return EMPTY_FOLDS
  const lineCount = countLines(text)
  const ends = new Int32Array(lineCount).fill(-1)
  const cols = new Int32Array(lineCount).fill(-1)
  const closers = new Int32Array(lineCount)

  const stackCh: number[] = []
  const stackLine: number[] = []
  const stackCol: number[] = []

  let line = 0
  let col = 0
  let inStr = false
  let esc = false

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inStr) {
      if (esc) esc = false
      else if (c === 92) esc = true
      else if (c === 34) inStr = false
    } else if (c === 34) {
      inStr = true
    } else if (c === 123 || c === 91) {
      stackCh.push(c)
      stackLine.push(line)
      stackCol.push(col)
    } else if ((c === 125 || c === 93) && stackCh.length > 0) {
      const open = stackCh.pop() as number
      const at = stackLine.pop() as number
      const oc = stackCol.pop() as number
      const paired = (open === 123 && c === 125) || (open === 91 && c === 93)
      // 同一行开、同一行闭不算折叠；`>=` 让后闭合的外层覆盖内层
      if (paired && line > at && line >= ends[at]) {
        ends[at] = line
        cols[at] = oc
        closers[at] = c
      }
    }
    if (c === 10) {
      line++
      col = 0
    } else {
      col++
    }
  }

  const lines: number[] = []
  for (let l = 0; l < lineCount; l++) if (ends[l] >= 0) lines.push(l)
  return { ends, cols, closers, lines: Int32Array.from(lines) }
}

/**
 * 折叠集合 → 可见行映射。
 *
 * 没有折叠时返回**恒等映射**（不分配任何数组，大文档也不吃亏）；
 * 有折叠时给出 `行号 ↔ 行下标` 双向查询，供虚拟滚动与光标定位用。
 */
export interface FoldLayout {
  /** 可见行数（虚拟滚动的 count） */
  count: number
  /** 行号 → 可见行下标（被折叠隐藏时 -1） */
  rowOf: (line: number) => number
  /** 可见行下标 → 行号（越界返回 -1） */
  lineOf: (row: number) => number
}

function identityLayout(lineCount: number): FoldLayout {
  return {
    count: lineCount,
    rowOf: (line) => (line >= 0 && line < lineCount ? line : -1),
    lineOf: (row) => (row >= 0 && row < lineCount ? row : -1),
  }
}

export function foldLayout(folds: Iterable<number>, ends: Int32Array, lineCount: number): FoldLayout {
  const heads: number[] = []
  for (const l of folds) {
    if (l < 0 || l >= lineCount || l >= ends.length) continue
    if (ends[l] > l) heads.push(l)
  }
  if (heads.length === 0) return identityLayout(lineCount)

  const hidden = new Uint8Array(lineCount)
  for (const l of heads) {
    const end = Math.min(ends[l], lineCount - 1)
    for (let x = l + 1; x <= end; x++) hidden[x] = 1
  }

  const lines: number[] = []
  for (let i = 0; i < lineCount; i++) if (!hidden[i]) lines.push(i)
  const rows = new Int32Array(lineCount).fill(-1)
  for (let r = 0; r < lines.length; r++) rows[lines[r]] = r

  return {
    count: lines.length,
    rowOf: (line) => (line >= 0 && line < lineCount ? rows[line] : -1),
    lineOf: (row) => (row >= 0 && row < lines.length ? lines[row] : -1),
  }
}
