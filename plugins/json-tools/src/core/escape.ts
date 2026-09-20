/**
 * 整篇文本的「添加 \ 转义 / 去除 \ 转义」。
 *
 * 用途：把一份 JSON 塞进别处的字符串里（接口调试、测试夹具、代码里的字符串常量）。
 *
 * 与 bejson 同名功能的差别（有意为之）：bejson 只给 `"` 前面补一个反斜杠，
 * `\` 与换行原样保留 —— 那样贴进字符串后 `\\` 会被吃掉一层、换行会把字符串截断。
 * 这里按 **JSON 字符串字面量**的规则完整转义（`\` → `\\`、引号 → `\"`、
 * 控制字符 → `\n` / `\t` / `\uXXXX`），保证「去除」能一个字符不差地还原回去；
 * 对不含反斜杠与控制字符的单行 JSON，两种做法的结果完全一致。
 */

export interface EscapeResult {
  text: string
  /** 实际改动的字符个数，0 表示无需处理 */
  changed: number
}

/** 控制字符的短转义写法（JSON 允许的五个） */
const SHORT: Record<number, string> = {
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r',
}

/** 还原时的短转义映射 */
const SHORT_BACK: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/** 转义：把整篇文本变成可以放进字符串字面量里的形式 */
export function addEscape(text: string): EscapeResult {
  let out = ''
  let changed = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 92) {
      out += '\\\\'
      changed++
      continue
    }
    if (c === 34) {
      out += '\\"'
      changed++
      continue
    }
    if (c < 32) {
      out += SHORT[c] ?? '\\u' + c.toString(16).padStart(4, '0')
      changed++
      continue
    }
    out += text[i]
  }
  return { text: out, changed }
}

/** 还原：只认标准转义序列，认不出来的（如 `\q`）原样保留，绝不丢字符 */
export function removeEscape(text: string): EscapeResult {
  let out = ''
  let changed = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = text[i + 1]
    if (next === undefined) {
      out += ch
      continue
    }
    const short = SHORT_BACK[next]
    if (short !== undefined) {
      out += short
      changed++
      i++
      continue
    }
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        changed++
        i += 5
        continue
      }
    }
    out += ch
  }
  return { text: out, changed }
}
