/**
 * 手写 JSON 词法扫描。
 *
 * 为什么不直接用 JSON.parse：
 *  - 格式化必须“无损”：`1e999`、`12345678901234567890` 这类数字经过
 *    parse → stringify 会丢精度或被改写成科学计数法。手写扫描只搬字节，不动数值。
 *  - 需要精确的错误位置（行列）来给用户定位。
 *  - 需要宽松模式（注释 / 尾逗号 / 单引号 / 裸键），修复那些“不是标准 JSON”的配置。
 *
 * 全部是 O(n) 单遍扫描、零正则回溯、零中间对象。
 */

export class JsonError extends Error {
  index: number
  line: number
  column: number

  constructor(message: string, index: number) {
    super(message)
    this.name = 'JsonError'
    this.index = index
    this.line = 1
    this.column = 1
  }
}

/** 把字符下标换算成行列（错误路径上才调用，不影响正常性能） */
export function locate(text: string, index: number): { line: number; column: number; snippet: string } {
  const i = Math.max(0, Math.min(index, text.length))
  let line = 1
  let lineStart = 0
  for (let k = 0; k < i; k++) {
    if (text.charCodeAt(k) === 10) {
      line++
      lineStart = k + 1
    }
  }
  const column = i - lineStart + 1
  const rawLine = text.slice(lineStart, text.indexOf('\n', lineStart) === -1 ? text.length : text.indexOf('\n', lineStart))
  const snippet = rawLine.length > 160 ? rawLine.slice(Math.max(0, column - 40), column + 120) : rawLine
  return { line, column, snippet }
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/** 跳过空白（宽松模式下顺带跳过注释） */
export function skipWs(s: string, i: number, lenient: boolean): number {
  const n = s.length
  while (i < n) {
    const c = s.charCodeAt(i)
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++
      continue
    }
    if (lenient && c === 47) {
      const c2 = s.charCodeAt(i + 1)
      if (c2 === 47) {
        i += 2
        while (i < n && s.charCodeAt(i) !== 10) i++
        continue
      }
      if (c2 === 42) {
        i += 2
        while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) i++
        i = Math.min(n, i + 2)
        continue
      }
    }
    break
  }
  return i
}

export interface ScanResult {
  end: number
  raw: string
}

/** 扫描一个字符串字面量，返回原始片段（含引号） */
export function scanString(s: string, i: number, lenient: boolean): ScanResult {
  const n = s.length
  const quote = s.charCodeAt(i)
  let j = i + 1
  while (j < n) {
    const c = s.charCodeAt(j)
    if (c === 92) {
      j += 2
      continue
    }
    if (c === quote) return { end: j + 1, raw: s.slice(i, j + 1) }
    if (!lenient && (c < 32 || c === 127)) {
      throw new JsonError('字符串里出现了未转义的控制字符', j)
    }
    j++
  }
  throw new JsonError('字符串没有闭合（缺少结束引号）', i)
}

/** 扫描一个数字字面量，保留原始写法 */
export function scanNumber(s: string, i: number): ScanResult {
  const n = s.length
  let j = i
  if (s.charCodeAt(j) === 45) j++
  if (!isDigit(s.charCodeAt(j))) throw new JsonError('数字格式不正确', i)
  if (s.charCodeAt(j) === 48) {
    j++
    if (isDigit(s.charCodeAt(j))) throw new JsonError('数字不能有多余的前导 0', i)
  } else {
    while (isDigit(s.charCodeAt(j))) j++
  }
  if (s.charCodeAt(j) === 46) {
    j++
    if (!isDigit(s.charCodeAt(j))) throw new JsonError('小数点后面需要数字', j)
    while (isDigit(s.charCodeAt(j))) j++
  }
  const e = s.charCodeAt(j)
  if (e === 101 || e === 69) {
    j++
    const sign = s.charCodeAt(j)
    if (sign === 43 || sign === 45) j++
    if (!isDigit(s.charCodeAt(j))) throw new JsonError('指数部分需要数字', j)
    while (isDigit(s.charCodeAt(j))) j++
  }
  if (j > n) throw new JsonError('数字没有结束', i)
  return { end: j, raw: s.slice(i, j) }
}

/** 把 JSON 字符串字面量解码成 JS 字符串（宽松模式修复引号时用） */
export function decodeString(raw: string): string {
  const body = raw.slice(1, -1)
  if (body.indexOf('\\') < 0 && raw.charCodeAt(0) === 34) return body
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    if (c !== 92) {
      out += body[i]
      continue
    }
    const e = body.charCodeAt(++i)
    switch (e) {
      case 110:
        out += '\n'
        break
      case 116:
        out += '\t'
        break
      case 114:
        out += '\r'
        break
      case 98:
        out += '\b'
        break
      case 102:
        out += '\f'
        break
      case 117: {
        const hex = body.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        }
        break
      }
      case 34:
        out += '"'
        break
      case 39:
        out += "'"
        break
      case 96:
        out += '`'
        break
      case 47:
        out += '/'
        break
      default:
        if (Number.isFinite(e)) out += body[i]
        break
    }
  }
  return out
}

/** 编码成标准 JSON 字符串字面量（含引号） */
export function encodeJsonString(v: string): string {
  let out = '"'
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]
    const c = v.charCodeAt(i)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (c === 10) out += '\\n'
    else if (c === 13) out += '\\r'
    else if (c === 9) out += '\\t'
    else if (c === 8) out += '\\b'
    else if (c === 12) out += '\\f'
    else if (c < 32) out += '\\u' + c.toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

/** 裸标识符（宽松模式的键），最多向前探测 128 字符 */
const BARE_KEY = /^[A-Za-z_$][\w$.\-]*/
const BARE_VALUE = /^[A-Za-z_$][\w$.\- ]*/

export function scanBareKey(s: string, i: number): string | null {
  const m = BARE_KEY.exec(s.slice(i, i + 128))
  return m ? m[0] : null
}

export function scanBareValue(s: string, i: number): string | null {
  const m = BARE_VALUE.exec(s.slice(i, i + 128))
  if (!m) return null
  return m[0].trimEnd()
}
