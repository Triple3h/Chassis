import { JsonError, decodeString, scanBareKey, scanNumber, scanString, skipWs } from './scanner'

/**
 * 扁平化 JSON 树。
 *
 * 所有节点放在同一组数组里，用「长子 / 兄弟链」表达层级（firstChild + nextSibling）：
 *   1. 构建期零对象分配，比树形对象图快一个数量级、内存省一半以上；
 *   2. structured clone 回主线程开销极低（typed array 按字节复制）；
 *   3. UI 侧投影可见行不需要递归对象图，线性扫描即可。
 * 之所以不用「连续区间 + start/count」：先序遍历下嵌套容器的子节点会插在中间，
 * 兄弟节点根本不连续，链表才是可靠表达。
 */

export const KIND = {
  object: 0,
  array: 1,
  string: 2,
  number: 3,
  boolean: 4,
  null: 5,
} as const

export interface FlatTree {
  kind: Uint8Array
  /** 键名，数组元素为 [i] */
  key: string[]
  /** 标量节点的显示值（超长字符串会截断） */
  value: string[]
  /** 容器节点的概览文案 */
  preview: string[]
  firstChild: Int32Array
  nextSibling: Int32Array
  parent: Int32Array
  /** 子节点个数（仅用于展示） */
  count: Int32Array
  depth: Int32Array
  /** 值在源码中的起始偏移（容器为 `{` / `[` 的位置） */
  start: Int32Array
  /** 值在源码中的结束偏移（独占，同 slice 的 end） */
  end: Int32Array
  /** 键字面量在源码中的区间（数组元素与根节点为 -1）—— 行内改键要用它定位 */
  keyStart: Int32Array
  keyEnd: Int32Array
  /** 值起始位置所在的源码行号（1 起） */
  line: Int32Array
  nodeCount: number
  maxDepth: number
  /** 是否存在被截断的字符串值 */
  truncated: boolean
}

export interface BuildTreeOptions {
  lenient?: boolean
  /** 节点上限，超过即中止，防止超大单行 JSON 撑爆内存 */
  maxNodes?: number
}

/** 标量值在树里保留的最大字符数（超过会被截断 ⇒ 不允许行内编辑） */
export const VALUE_PREVIEW = 300
const MAX_DEPTH = 512

export function buildTree(text: string, opts: BuildTreeOptions = {}): FlatTree {
  const lenient = opts.lenient ?? true
  const maxNodes = opts.maxNodes ?? 400_000

  const kind: number[] = []
  const key: string[] = []
  const value: string[] = []
  const preview: string[] = []
  const firstChild: number[] = []
  const nextSibling: number[] = []
  const parent: number[] = []
  const count: number[] = []
  const depth: number[] = []
  const start: number[] = []
  const endAt: number[] = []
  const keyStart: number[] = []
  const keyEnd: number[] = []
  const line: number[] = []
  let maxDepth = 0
  let truncated = false

  // 源顺序不变 ⇒ 节点起始偏移单调不减，行号可以「游标向前数」地 O(n) 求出
  let lineCursorAt = 0
  let lineCursorLine = 1
  function lineOf(at: number): number {
    if (at > lineCursorAt) {
      let n = lineCursorLine
      for (let i = lineCursorAt; i < at; i++) if (text.charCodeAt(i) === 10) n++
      lineCursorAt = at
      lineCursorLine = n
    }
    return lineCursorLine
  }

  function push(
    k: number,
    label: string,
    val: string,
    par: number,
    dep: number,
    from: number, 
    keyFrom = -1,
    keyTo = -1,
  ): number {
    if (kind.length >= maxNodes) throw new JsonError(`节点数超过 ${maxNodes}，请改用文本视图`, from) 
    kind.push(k) 
    key.push(label)
    value.push(val)
    preview.push('')
    firstChild.push(-1)
    nextSibling.push(-1)
    parent.push(par)
    count.push(0)
    depth.push(dep)
    start.push(from)
    endAt.push(-1)
    keyStart.push(keyFrom)
    keyEnd.push(keyTo)
    line.push(lineOf(from))
    if (dep > maxDepth) maxDepth = dep
    return kind.length - 1
  }

  function linkChild(par: number, child: number, last: number): number { 
    if (last === -1) firstChild[par] = child
    else nextSibling[last] = child
    count[par]++
    return child
  }

  function parseValue(
    from: number,
    dep: number,
    label: string,
    par: number,
    keyFrom = -1,
    keyTo = -1,
  ): { end: number; idx: number } {
    if (dep > MAX_DEPTH) throw new JsonError(`嵌套层级超过 ${MAX_DEPTH} 层`, from)
    let i = skipWs(text, from, lenient)
    if (i >= text.length) throw new JsonError('内容意外结束：这里需要一个值', i)
    const vstart = i
    const c = text.charCodeAt(i)

    if (c === 123 || c === 91) {
      const isObj = c === 123
      const idx = push(isObj ? KIND.object : KIND.array, label, '', par, dep, vstart, keyFrom, keyTo)
      i++
      let last = -1
      let k = 0
      for (;;) {
        i = skipWs(text, i, lenient)
        if (i >= text.length) throw new JsonError(isObj ? '对象没有闭合（缺少 }）' : '数组没有闭合（缺少 ]）', i)
        const cc = text.charCodeAt(i)
        if (cc === (isObj ? 125 : 93)) {
          i++
          break
        }
        if (k > 0) {
          if (cc !== 44) throw new JsonError(isObj ? '对象的成员之间缺少逗号' : '数组元素之间缺少逗号', i)
          i++
          i = skipWs(text, i, lenient)
          if (text.charCodeAt(i) === (isObj ? 125 : 93)) {
            if (!lenient) throw new JsonError('末尾多了一个逗号', i)
            i++
            break
          }
        }
        let childLabel: string
        let keyFrom = -1
        let keyTo = -1
        if (isObj) {
          const kc = text.charCodeAt(i)
          if (kc === 34 || ((kc === 39 || kc === 96) && lenient)) {
            const r = scanString(text, i, lenient)
            childLabel = decodeString(r.raw)
            keyFrom = i
            keyTo = r.end
            i = r.end
          } else if (lenient) {
            const b = scanBareKey(text, i)
            if (!b) throw new JsonError('对象的键必须是字符串', i)
            childLabel = b
            keyFrom = i
            keyTo = i + b.length
            i += b.length
          } else {
            throw new JsonError('对象的键必须是双引号字符串', i)
          }
          i = skipWs(text, i, lenient)
          if (text.charCodeAt(i) !== 58) throw new JsonError('键后面缺少冒号', i)
          i++
        } else {
          childLabel = `[${k}]`
        }
        const child = parseValue(i, dep + 1, childLabel, idx, keyFrom, keyTo)
        i = child.end
        last = linkChild(idx, child.idx, last)
        k++
      }
      preview[idx] = isObj ? `{…} ${k} 个键` : `[…] ${k} 项`
      endAt[idx] = i
      return { end: i, idx }
    }

    function scalar(k: number, val: string, to: number): number {
      const idx = push(k, label, val, par, dep, vstart, keyFrom, keyTo)
      endAt[idx] = to
      return idx
    }

    if (c === 34 || ((c === 39 || c === 96) && lenient)) {
      const r = scanString(text, i, lenient)
      const decoded = decodeString(r.raw)
      if (decoded.length > VALUE_PREVIEW) truncated = true
      const shown = decoded.length > VALUE_PREVIEW ? decoded.slice(0, VALUE_PREVIEW) : decoded
      return { end: r.end, idx: scalar(KIND.string, shown, r.end) }
    }

    if (c === 45 || (c >= 48 && c <= 57)) {
      const r = scanNumber(text, i)
      return { end: r.end, idx: scalar(KIND.number, r.raw, r.end) }
    }

    const rest = text.slice(i, i + 12)
    if (rest.startsWith('true') || rest.startsWith('false')) {
      const lit = rest.startsWith('true') ? 'true' : 'false'
      return { end: i + lit.length, idx: scalar(KIND.boolean, lit, i + lit.length) }
    }
    if (rest.startsWith('null')) {
      return { end: i + 4, idx: scalar(KIND.null, 'null', i + 4) }
    }
    if (lenient) {
      const m = /^[A-Za-z_$][\w$.\- ]*/.exec(rest)
      if (m) {
        const raw = m[0].trimEnd()
        return { end: i + raw.length, idx: scalar(KIND.string, raw, i + raw.length) }
      }
    }
    throw new JsonError(`这里需要一个值，却读到 ${JSON.stringify(text[i])}`, i)
  }

  const root = parseValue(0, 0, 'root', -1)
  const end = skipWs(text, root.end, lenient)
  if (end < text.length) throw new JsonError('JSON 结束后还有多余内容', end)

  return {
    kind: Uint8Array.from(kind),
    key,
    value,
    preview,
    firstChild: Int32Array.from(firstChild),
    nextSibling: Int32Array.from(nextSibling),
    parent: Int32Array.from(parent),
    count: Int32Array.from(count),
    depth: Int32Array.from(depth),
    start: Int32Array.from(start),
    end: Int32Array.from(endAt),
    keyStart: Int32Array.from(keyStart),
    keyEnd: Int32Array.from(keyEnd),
    line: Int32Array.from(line),
    nodeCount: kind.length,
    maxDepth,
    truncated,
  }
}

export function isContainerKind(k: number): boolean {
  return k === KIND.object || k === KIND.array
}

export function childrenOf(tree: FlatTree, idx: number): number[] {
  const out: number[] = []
  for (let c = tree.firstChild[idx]; c !== -1; c = tree.nextSibling[c]) out.push(c)
  return out
}

/**
 * 把树投影成「当前可见的行」（先序）。
 *
 * 展开的容器在子节点之后追加一行**收尾括号**——行与节点不是一一对应，
 * 所以编码进同一个 Int32Array：`>= 0` 是节点下标，`< 0` 是收尾行（对应容器 = `-row - 1`）。
 * 这样一次投影仍是零对象分配，虚拟滚动只按行数算高度即可。
 *
 * @param expanded 已展开的容器节点
 */
export function projectRows(tree: FlatTree, expanded: Set<number>): Int32Array {
  const out: number[] = []
  const { kind, firstChild, nextSibling } = tree

  function walk(idx: number) {
    out.push(idx)
    if (!isContainerKind(kind[idx]) || !expanded.has(idx)) return
    for (let c = firstChild[idx]; c !== -1; c = nextSibling[c]) walk(c)
    out.push(-idx - 1)
  }

  walk(0)
  return Int32Array.from(out)
}

/** 收尾行 → 容器节点下标（普通行返回 -1） */
export function closeRowNode(row: number): number {
  return row < 0 ? -row - 1 : -1
}

/** 容器里最后一个成员（空容器返回 -1） */
export function lastChildOf(tree: FlatTree, idx: number): number {
  let last = -1
  for (let c = tree.firstChild[idx]; c !== -1; c = tree.nextSibling[c]) last = c
  return last
}

/** 节点在父容器里的序号（数组下标 / 第几个成员）；根返回 -1 */
export function indexInParent(tree: FlatTree, idx: number): number {
  const parent = tree.parent[idx]
  if (parent < 0) return -1
  let n = 0
  for (let c = tree.firstChild[parent]; c !== -1 && c !== idx; c = tree.nextSibling[c]) n++
  return n
}

/** 从根到该节点的祖先链（不含自身） */
export function ancestorsOf(tree: FlatTree, idx: number): number[] {
  const out: number[] = []
  let p = tree.parent[idx]
  while (p >= 0) {
    out.push(p)
    p = tree.parent[p]
  }
  return out
}

/** 该节点的完整键路径，如 user.tags[0] */
export function pathOf(tree: FlatTree, idx: number): string[] {
  const parts: string[] = []
  let cur = idx
  while (cur >= 0) {
    const label = tree.key[cur]
    if (cur > 0 || label !== 'root') parts.push(label)
    cur = tree.parent[cur]
  }
  return parts.reverse()
}

const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/

/**
 * 把路径拼成可直接复制的写法：合法标识符走点号，其余走 `["键"]`（数组元素原样 `[i]`）。
 * 例：`data.items[0].name`、`headers["content-type"]`
 */
export function pathString(tree: FlatTree, idx: number): string {
  let out = ''
  for (const part of pathOf(tree, idx)) {
    if (part.startsWith('[') && part.endsWith(']')) {
      out += part
    } else if (!out) {
      out = SIMPLE_KEY.test(part) ? part : `[${JSON.stringify(part)}]`
    } else {
      out += SIMPLE_KEY.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`
    }
  }
  return out
}

/** JSONPath 写法：`$.data.items[0].name`、根节点为 `$` */
export function jsonPath(tree: FlatTree, idx: number): string {
  const body = pathString(tree, idx)
  if (!body) return '$'
  return body.startsWith('[') ? `$${body}` : `$.${body}`
}

/** 节点值在源码里的原始片段（`withKey` 时补上 `"键": ` 前缀） */
export function nodeSource(tree: FlatTree, text: string, idx: number, withKey = false): string {
  const from = tree.start[idx]
  const to = tree.end[idx]
  const raw = from >= 0 && to > from ? text.slice(from, to) : ''
  if (!withKey || idx === 0) return raw
  const label = tree.key[idx]
  if (label.startsWith('[') && label.endsWith(']')) return raw
  return `${JSON.stringify(label)}: ${raw}`
}

/**
 * 源码行 → 节点（文本视图点某行时反向定位）。
 * 先序遍历下节点起始行单调不减，取「起始行 ≤ 目标行」的最后一个即可。
 */
export function nodeAtLine(tree: FlatTree, line: number): number {
  let best = 0
  for (let i = 0; i < tree.nodeCount; i++) {
    if (tree.line[i] <= line) best = i
    else break
  }
  return best
}

/** 类型分布统计（树视图徽标 / 状态栏共用） */
export interface KindCounts {
  object: number
  array: number
  string: number
  number: number
  boolean: number
  null: number
}

export function countKinds(tree: FlatTree): KindCounts {
  const out: KindCounts = { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 }
  const { kind } = tree
  for (let i = 0; i < tree.nodeCount; i++) {
    switch (kind[i]) {
      case KIND.object:
        out.object++
        break
      case KIND.array:
        out.array++
        break
      case KIND.string:
        out.string++
        break
      case KIND.number:
        out.number++
        break
      case KIND.boolean:
        out.boolean++
        break
      default:
        out.null++
        break
    }
  }
  return out
}
