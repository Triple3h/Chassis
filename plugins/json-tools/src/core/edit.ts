/**
 * 文档补丁：把树上的一次编辑（改键 / 改值 / 增成员 / 删成员）翻译成对源码文本的**最小替换**。
 *
 * 树建立在「格式化输出」之上，节点自带源码偏移（start/end/keyStart/keyEnd），
 * 因此每次编辑只需换掉一段区间 —— 不必重新序列化整个文档，也不会丢数字原文
 * 与字符串里已有的转义写法（`\uXXXX` 之类原样保留）。
 *
 * 所有函数都是纯函数：文本进、文本出；非法输入返回 null，调用方保留原文并提示。
 */
import { KIND, VALUE_PREVIEW, isContainerKind, type FlatTree } from './tree'

/** JSON 数字文法（与 scanner 的宽松程度一致：不接受前导 0、`.5`、`1.`） */
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/** 该标量能否行内编辑（字符串被截断过就只能去文本视图改） */
export function canEditValue(tree: FlatTree, idx: number): boolean {
  if (isContainerKind(tree.kind[idx])) return false
  const k = tree.kind[idx]
  if (k !== KIND.string) return true
  return tree.value[idx].length < VALUE_PREVIEW
}

/** 行内编辑时显示的文本（与 bejson 一致：字符串不带引号） */
export function editText(tree: FlatTree, idx: number): string {
  return tree.value[idx]
}

/** 用户输入 → JSON 字面量；不合法返回 null */
export function encodeScalar(kind: number, input: string): string | null {
  switch (kind) {
    case KIND.string:
      return JSON.stringify(input)
    case KIND.number: {
      const t = input.trim()
      return NUMBER_RE.test(t) ? t : null
    }
    case KIND.boolean: {
      const t = input.trim()
      return t === 'true' || t === 'false' ? t : null
    }
    case KIND.null:
      return input.trim() === 'null' ? 'null' : null
    default:
      return null
  }
}

/** 改标量值 */
export function patchValue(text: string, tree: FlatTree, idx: number, input: string): string | null {
  if (!canEditValue(tree, idx)) return null
  const lit = encodeScalar(tree.kind[idx], input)
  if (lit === null) return null
  const from = tree.start[idx]
  const to = tree.end[idx]
  if (from < 0 || to <= from) return null
  return text.slice(0, from) + lit + text.slice(to)
}

/** 改对象成员的键（数组元素与根没有键） */
export function patchKey(text: string, tree: FlatTree, idx: number, input: string): string | null {
  if (idx === 0) return null
  if (tree.parent[idx] < 0 || tree.kind[tree.parent[idx]] !== KIND.object) return null
  const from = tree.keyStart[idx]
  const to = tree.keyEnd[idx]
  if (from < 0 || to <= from) return null
  return text.slice(0, from) + JSON.stringify(input) + text.slice(to)
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

/** 该偏移所在行的缩进（只取行首连续的空白） */
function lineIndentAt(text: string, at: number): string {
  let i = at
  while (i > 0 && text.charCodeAt(i - 1) !== 10) i--
  let out = ''
  while (i < at) {
    const c = text.charCodeAt(i)
    if (c !== 32 && c !== 9) break
    out += text[i]
    i++
  }
  return out
}

export interface AddChildOptions {
  /** 新成员的缩进单位（跟随当前格式化设置） */
  indent?: string
}

/**
 * 往容器里加一个成员：对象加 `"新属性": ""`、数组加 `null`。
 * 多行容器按现有缩进补行；单行（压缩过的）容器就内联追加。
 */
export function addChild(text: string, tree: FlatTree, idx: number, opts: AddChildOptions = {}): string | null {
  if (!isContainerKind(tree.kind[idx])) return null
  const isObj = tree.kind[idx] === KIND.object
  const open = tree.start[idx]
  const close = tree.end[idx] - 1
  if (open < 0 || close <= open) return null
  if (text.charCodeAt(close) !== (isObj ? 125 : 93)) return null

  // 缩进/换行跟着**整篇文档**走：多行文档就铺开成一行，压缩过的就内联追加
  const pretty = text.includes('\n')
  const hasChildren = tree.count[idx] > 0
  const entry = isObj ? `"新属性"${pretty ? ': ' : ':'}""` : 'null'
  // 收尾括号前原有的空白由我们重写 —— 退到最后一个非空字符之后，整体替换 [at, close)
  let at = close
  while (at > open + 1 && isSpace(text.charCodeAt(at - 1))) at--

  let insert: string
  if (pretty) {
    const pad = lineIndentAt(text, open) + (opts.indent ?? '  ')
    const padClose = lineIndentAt(text, open)
    insert = `${hasChildren ? ',' : ''}\n${pad}${entry}\n${padClose}`
  } else {
    insert = `${hasChildren ? ',' : ''}${entry}`
  }
  return text.slice(0, at) + insert + text.slice(close)
}

/**
 * 删掉一个成员（连同它那一侧的逗号与周边空白）。
 * 删完容器里什么都不剩时会收成 `{}` / `[]`。
 */
export function removeNode(text: string, tree: FlatTree, idx: number): string | null {
  if (idx === 0) return null
  const parent = tree.parent[idx]
  if (parent < 0) return null
  const from = tree.keyStart[idx] >= 0 ? tree.keyStart[idx] : tree.start[idx]
  const to = tree.end[idx]
  if (from < 0 || to <= from) return null

  // 后面还有成员：连「本次 + 逗号 + 空白」一路删到下一个成员开头
  const next = tree.nextSibling[idx]
  if (next !== -1) {
    const nextFrom = tree.keyStart[next] >= 0 ? tree.keyStart[next] : tree.start[next]
    return text.slice(0, from) + text.slice(nextFrom)
  }

  // 末尾成员：连上一个成员后面的逗号一起删
  let prev = -1
  for (let c = tree.firstChild[parent]; c !== -1 && c !== idx; c = tree.nextSibling[c]) prev = c
  if (prev !== -1) return text.slice(0, tree.end[prev]) + text.slice(to)

  // 唯一成员：把容器里剩下的空白也收干净
  let a = from
  while (a > 0 && isSpace(text.charCodeAt(a - 1))) a--
  let b = to
  while (b < text.length && isSpace(text.charCodeAt(b))) b++
  return text.slice(0, a) + text.slice(b)
}
