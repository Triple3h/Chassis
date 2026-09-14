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

const VALUE_PREVIEW = 300
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
  let maxDepth = 0
  let truncated = false

  function push(k: number, label: string, val: string, par: number, dep: number): number {
    if (kind.length >= maxNodes) throw new JsonError(`节点数超过 ${maxNodes}，请改用文本视图`, 0)
    kind.push(k)
    key.push(label)
    value.push(val)
    preview.push('')
    firstChild.push(-1)
    nextSibling.push(-1)
    parent.push(par)
    count.push(0)
    depth.push(dep)
    if (dep > maxDepth) maxDepth = dep
    return kind.length - 1
  }

  function linkChild(par: number, child: number, last: number): number {
    if (last === -1) firstChild[par] = child
    else nextSibling[last] = child
    count[par]++
    return child
  }

  function parseValue(from: number, dep: number, label: string, par: number): { end: number; idx: number } {
    if (dep > MAX_DEPTH) throw new JsonError(`嵌套层级超过 ${MAX_DEPTH} 层`, from)
    let i = skipWs(text, from, lenient)
    if (i >= text.length) throw new JsonError('内容意外结束：这里需要一个值', i)
    const c = text.charCodeAt(i)

    if (c === 123 || c === 91) {
      const isObj = c === 123
      const idx = push(isObj ? KIND.object : KIND.array, label, '', par, dep)
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
        if (isObj) {
          const kc = text.charCodeAt(i)
          if (kc === 34 || ((kc === 39 || kc === 96) && lenient)) {
            const r = scanString(text, i, lenient)
            childLabel = decodeString(r.raw)
            i = r.end
          } else if (lenient) {
            const b = scanBareKey(text, i)
            if (!b) throw new JsonError('对象的键必须是字符串', i)
            childLabel = b
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
        const child = parseValue(i, dep + 1, childLabel, idx)
        i = child.end
        last = linkChild(idx, child.idx, last)
        k++
      }
      preview[idx] = isObj ? `{…} ${k} 个键` : `[…] ${k} 项`
      return { end: i, idx }
    }

    if (c === 34 || ((c === 39 || c === 96) && lenient)) {
      const r = scanString(text, i, lenient)
      const decoded = decodeString(r.raw)
      if (decoded.length > VALUE_PREVIEW) truncated = true
      const idx = push(KIND.string, label, decoded.length > VALUE_PREVIEW ? decoded.slice(0, VALUE_PREVIEW) : decoded, par, dep)
      return { end: r.end, idx }
    }

    if (c === 45 || (c >= 48 && c <= 57)) {
      const r = scanNumber(text, i)
      return { end: r.end, idx: push(KIND.number, label, r.raw, par, dep) }
    }

    const rest = text.slice(i, i + 12)
    if (rest.startsWith('true') || rest.startsWith('false')) {
      const lit = rest.startsWith('true') ? 'true' : 'false'
      return { end: i + lit.length, idx: push(KIND.boolean, label, lit, par, dep) }
    }
    if (rest.startsWith('null')) {
      return { end: i + 4, idx: push(KIND.null, label, 'null', par, dep) }
    }
    if (lenient) {
      const m = /^[A-Za-z_$][\w$.\- ]*/.exec(rest)
      if (m) {
        const raw = m[0].trimEnd()
        return { end: i + raw.length, idx: push(KIND.string, label, raw, par, dep) }
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
 * 把树投影成「当前可见的行」。
 * @param expanded 已展开的容器节点
 * @param visible  过滤命中的节点集合（含祖先），null 表示不过滤
 */
export function projectRows(tree: FlatTree, expanded: Set<number>, visible: Set<number> | null): Int32Array {
  const out: number[] = []
  const { kind, firstChild, nextSibling } = tree

  function walk(idx: number) {
    out.push(idx)
    if (!isContainerKind(kind[idx]) || !expanded.has(idx)) return
    for (let c = firstChild[idx]; c !== -1; c = nextSibling[c]) {
      if (visible && !visible.has(c)) continue
      walk(c)
    }
  }

  if (!visible || visible.has(0)) walk(0)
  return Int32Array.from(out)
}

/** 键值模糊匹配：命中节点 + 其祖先 + 其后代（用于只显示命中的分支） */
export function matchNodes(tree: FlatTree, query: string): { visible: Set<number>; matched: Set<number> } {
  const q = query.toLowerCase()
  const matched = new Set<number>()
  const visible = new Set<number>()
  for (let i = 0; i < tree.nodeCount; i++) {
    const inKey = tree.key[i].toLowerCase().includes(q)
    const inValue = !inKey && !!tree.value[i] && tree.value[i].toLowerCase().includes(q)
    if (!inKey && !inValue) continue
    matched.add(i)
    visible.add(i)
    let p = tree.parent[i]
    while (p >= 0 && !visible.has(p)) {
      visible.add(p)
      p = tree.parent[p]
    }
  }
  // 命中容器的后代也要显示，否则展开后是空的
  for (const m of matched) {
    if (!isContainerKind(tree.kind[m])) continue
    const stack = [m]
    while (stack.length) {
      const cur = stack.pop() as number
      for (let c = tree.firstChild[cur]; c !== -1; c = tree.nextSibling[c]) {
        visible.add(c)
        if (isContainerKind(tree.kind[c])) stack.push(c)
      }
    }
  }
  return { visible, matched }
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
