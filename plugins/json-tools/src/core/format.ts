import {
  JsonError,
  decodeString,
  encodeJsonString,
  locate,
  scanBareKey,
  scanBareValue,
  scanNumber,
  scanString,
  skipWs,
} from './scanner'
import type { KindCounts } from './tree'

/** 缩进：1–4 空格或 Tab（对齐 bejson 的缩进下拉） */
export type IndentOption = 1 | 2 | 3 | 4 | 'tab'

export interface FormatOptions {
  /** 缩进：2 / 4 空格或 Tab */
  indent?: IndentOption
  /** 压缩成一行 */
  minify?: boolean
  /** 对象键排序 */
  sortKeys?: boolean
  /** 宽松模式：允许注释、尾逗号、单引号、裸键 */
  lenient?: boolean
}

export interface JsonIssue {
  message: string
  index: number
  line: number
  column: number
  snippet: string
}

export interface JsonStats {
  /** 输入字符数 */
  inChars: number
  /** 输出字节数（UTF-8） */
  outBytes: number
  /** 输出行数 */
  outLines: number
  /** 节点数（键值对 / 数组元素 / 标量都算一个） */
  nodes: number
  /** 最大嵌套深度 */
  depth: number
  /** 按类型分布的节点数 */
  kinds: KindCounts
}

export interface FormatResult {
  ok: boolean
  output: string
  issue?: JsonIssue
  stats: JsonStats
  /** 严格模式解析失败、但宽松模式能修好 */
  repaired?: boolean
  /** 宽松修复过程中做的处理说明 */
  notes?: string[]
}

const MAX_DEPTH = 512

interface Entry {
  /** 用于排序比较的键（已解码） */
  key: string
  /** 实际输出的键字面量（含引号） */
  raw: string
  /** 值的输出文本 */
  value: string
}

class Emitter {
  private s: string
  private i = 0
  private len: number
  private indentUnit: string
  private nl: string
  private sortKeys: boolean
  private lenient: boolean

  nodes = 0
  maxDepth = 0
  kinds: KindCounts = { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 }

  constructor(text: string, opts: FormatOptions) {
    this.s = text
    this.len = text.length
    this.lenient = opts.lenient ?? false
    this.sortKeys = opts.sortKeys ?? false
    const minify = opts.minify ?? false
    this.nl = minify ? '' : '\n'
    this.indentUnit = minify
      ? ''
      : (opts.indent ?? 2) === 'tab'
        ? '\t'
        : ' '.repeat((opts.indent ?? 2) as number)
  }

  run(): string {
    const out = this.value(0)
    this.i = skipWs(this.s, this.i, this.lenient)
    if (this.i < this.len) {
      throw new JsonError('JSON 结束后还有多余内容', this.i)
    }
    return out
  }

  private value(depth: number): string {
    this.i = skipWs(this.s, this.i, this.lenient)
    if (this.i >= this.len) throw new JsonError('内容意外结束：这里需要一个值', this.i)
    const c = this.s.charCodeAt(this.i)
    if (c === 123) return this.object(depth)
    if (c === 91) return this.array(depth)
    if (c === 34 || ((c === 39 || c === 96) && this.lenient)) return this.string()
    if (c === 45 || (c >= 48 && c <= 57)) return this.number()
    if (this.s.startsWith('true', this.i) && this.boundary(this.i + 4)) {
      this.i += 4
      this.tick('boolean')
      return 'true'
    }
    if (this.s.startsWith('false', this.i) && this.boundary(this.i + 5)) {
      this.i += 5
      this.tick('boolean')
      return 'false'
    }
    if (this.s.startsWith('null', this.i) && this.boundary(this.i + 4)) {
      this.i += 4
      this.tick('null')
      return 'null'
    }
    if (this.lenient) {
      if (this.s.startsWith('NaN', this.i) || this.s.startsWith('Infinity', this.i)) {
        this.i += this.s.startsWith('NaN', this.i) ? 3 : 8
        this.tick('null')
        return 'null'
      }
      if (this.s.startsWith('-Infinity', this.i)) {
        this.i += 9
        this.tick('null')
        return 'null'
      }
      const bare = scanBareValue(this.s, this.i)
      if (bare) {
        this.i += bare.length
        this.tick('string')
        return encodeJsonString(bare)
      }
    }
    throw new JsonError(`这里需要一个值，却读到 ${JSON.stringify(this.s[this.i])}`, this.i)
  }

  private tick(kind: keyof KindCounts) {
    this.nodes++
    this.kinds[kind]++
  }

  /** 关键字边界检查，避免 `truex` 被当成 `true` */
  private boundary(at: number): boolean {
    if (at >= this.len) return true
    const c = this.s.charCodeAt(at)
    return !((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36)
  }

  private string(): string {
    const res = scanString(this.s, this.i, this.lenient)
    this.i = res.end
    this.tick('string')
    if (!this.lenient || res.raw.charCodeAt(0) === 34) return res.raw
    return encodeJsonString(decodeString(res.raw))
  }

  private number(): string {
    const res = scanNumber(this.s, this.i)
    this.i = res.end
    this.tick('number')
    return res.raw
  }

  private object(depth: number): string {
    this.touch(depth + 1)
    this.i++ // {
    const entries: Entry[] = []
    for (;;) {
      const before = this.i
      this.i = skipWs(this.s, this.i, this.lenient)
      if (this.i >= this.len) throw new JsonError('对象没有闭合（缺少 }）', before)
      const c = this.s.charCodeAt(this.i)
      if (c === 125) {
        this.i++
        break
      }
      if (entries.length > 0) {
        if (c !== 44) throw new JsonError('对象的成员之间缺少逗号', this.i)
        this.i++
        this.i = skipWs(this.s, this.i, this.lenient)
        if (this.s.charCodeAt(this.i) === 125) {
          if (!this.lenient) throw new JsonError('对象末尾多了一个逗号', this.i)
          this.i++
          break
        }
      }
      // 键
      const kc = this.s.charCodeAt(this.i)
      let key: string
      let raw: string
      if (kc === 34 || ((kc === 39 || kc === 96) && this.lenient)) {
        const r = scanString(this.s, this.i, this.lenient)
        const decoded = decodeString(r.raw)
        key = decoded
        raw = this.lenient && kc !== 34 ? encodeJsonString(decoded) : r.raw
        this.i = r.end
      } else if (this.lenient) {
        const bare = scanBareKey(this.s, this.i)
        if (!bare) throw new JsonError('对象的键必须是字符串', this.i)
        key = bare
        raw = encodeJsonString(bare)
        this.i += bare.length
      } else {
        throw new JsonError('对象的键必须是双引号字符串', this.i)
      }
      this.i = skipWs(this.s, this.i, this.lenient)
      if (this.s.charCodeAt(this.i) !== 58) throw new JsonError('键后面缺少冒号', this.i)
      this.i++
      const value = this.value(depth + 1)
      entries.push({ key, raw, value })
    }
    this.tick('object')
    if (entries.length === 0) return '{}'
    if (this.sortKeys) entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    if (this.nl === '') {
      let out = '{'
      for (let k = 0; k < entries.length; k++) {
        out += (k ? ',' : '') + entries[k].raw + ':' + entries[k].value
      }
      return out + '}'
    }
    const pad = this.indentUnit.repeat(depth + 1)
    let out = '{\n'
    for (let k = 0; k < entries.length; k++) {
      out += pad + entries[k].raw + ': ' + entries[k].value + (k < entries.length - 1 ? ',\n' : '\n')
    }
    return out + this.indentUnit.repeat(depth) + '}'
  }

  private array(depth: number): string {
    this.touch(depth + 1)
    this.i++ // [
    const items: string[] = []
    for (;;) {
      const before = this.i
      this.i = skipWs(this.s, this.i, this.lenient)
      if (this.i >= this.len) throw new JsonError('数组没有闭合（缺少 ]）', before)
      const c = this.s.charCodeAt(this.i)
      if (c === 93) {
        this.i++
        break
      }
      if (items.length > 0) {
        if (c !== 44) throw new JsonError('数组元素之间缺少逗号', this.i)
        this.i++
        this.i = skipWs(this.s, this.i, this.lenient)
        if (this.s.charCodeAt(this.i) === 93) {
          if (!this.lenient) throw new JsonError('数组末尾多了一个逗号', this.i)
          this.i++
          break
        }
      }
      items.push(this.value(depth + 1))
    }
    this.tick('array')
    if (items.length === 0) return '[]'
    if (this.nl === '') return '[' + items.join(',') + ']'
    const pad = this.indentUnit.repeat(depth + 1)
    let out = '[\n'
    for (let k = 0; k < items.length; k++) {
      out += pad + items[k] + (k < items.length - 1 ? ',\n' : '\n')
    }
    return out + this.indentUnit.repeat(depth) + ']'
  }

  private touch(depth: number) {
    if (depth > MAX_DEPTH) throw new JsonError(`嵌套层级超过 ${MAX_DEPTH} 层`, this.i)
    if (depth > this.maxDepth) this.maxDepth = depth
  }
}

function zeroKinds(): KindCounts {
  return { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 }
}

function countLines(s: string): number {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

function byteSize(s: string): number {
  try {
    return new Blob([s]).size
  } catch {
    return s.length
  }
}

function toIssue(text: string, err: unknown): JsonIssue {
  if (err instanceof JsonError) {
    const pos = locate(text, err.index)
    return { message: err.message, index: err.index, line: pos.line, column: pos.column, snippet: pos.snippet }
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    index: 0,
    line: 1,
    column: 1,
    snippet: '',
  }
}

/**
 * 格式化 / 压缩 / 排序。
 * 严格模式失败时会自动再试一次宽松模式，成功则标记 `repaired`（UI 上提示用户）。
 */
export function formatJson(text: string, opts: FormatOptions = {}): FormatResult {
  const emptyStats: JsonStats = {
    inChars: text.length,
    outBytes: 0,
    outLines: 0,
    nodes: 0,
    depth: 0,
    kinds: zeroKinds(),
  }
  if (!text.trim()) {
    return { ok: false, output: '', issue: { message: '内容为空', index: 0, line: 1, column: 1, snippet: '' }, stats: emptyStats }
  }

  const strictOpts: FormatOptions = { ...opts, lenient: false }
  try {
    const em = new Emitter(text, strictOpts)
    const output = em.run()
    return {
      ok: true,
      output,
      stats: {
        inChars: text.length,
        outBytes: byteSize(output),
        outLines: countLines(output),
        nodes: em.nodes,
        depth: em.maxDepth,
        kinds: em.kinds,
      },
    }
  } catch (err) {
    const strictIssue = toIssue(text, err)
    if (opts.lenient === false) return { ok: false, output: '', issue: strictIssue, stats: emptyStats }
    // 宽松模式兜底：注释、尾逗号、单引号、裸键都能救回来
    try {
      const em = new Emitter(text, { ...opts, lenient: true })
      const output = em.run()
      return {
        ok: true,
        output,
        repaired: true,
        notes: ['已按宽松模式修复：注释被丢弃，单引号 / 裸键 / 尾逗号按 JSON 规范重写'],
        stats: {
          inChars: text.length,
          outBytes: byteSize(output),
          outLines: countLines(output),
          nodes: em.nodes,
          depth: em.maxDepth,
          kinds: em.kinds,
        },
      }
    } catch {
      return { ok: false, output: '', issue: strictIssue, stats: emptyStats }
    }
  }
}

/** 只校验不产出（输入很大的时候比 formatJson 省一半内存） */
export function checkJson(text: string, opts: FormatOptions = {}): JsonIssue | null {
  const res = formatJson(text, { ...opts, minify: true })
  return res.ok ? null : (res.issue ?? null)
}
