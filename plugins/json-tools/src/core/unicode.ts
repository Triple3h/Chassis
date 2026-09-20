/**
 * Unicode 转义 / 还原。
 *
 * 只处理 JSON 字符串内部：字符串以外的非 ASCII 字符在 JSON 里本来就不合法，
 * 而 `\uXXXX` 也只可能出现在字符串里。两条规则：
 *   1. 已有转义序列（`\\` 开头）原样保留 —— 否则 `"\\u4e2d"` 这种字面量会被改坏；
 *   2. 还原时跳过会破坏结构的码点（`"` / `\`）与控制字符 —— 否则字符串会提前闭合。
 */

export interface UnicodeResult {
  text: string
  /** 实际改动的字符个数，0 表示无需处理 */
  changed: number
}

export interface EscapeOptions {
  /**
   * 转义范围：
   * - `nonAscii`（默认）所有非 ASCII 与裸控制字符，最彻底（含 emoji / 重音字母）；
   * - `cjk` 只转 `[\u4e00-\u9fa5]` 汉字 —— 与 bejson 的「中文转Unicode」逐字一致。
   */
  only?: 'nonAscii' | 'cjk'
}

function hex4(code: number): string {
  return '\\u' + code.toString(16).padStart(4, '0')
}

/** 把字符串内部的非 ASCII（含裸控制字符）转成 `\uXXXX`；代理对按两个 code unit 各自转义 */
export function escapeUnicode(text: string, opts: EscapeOptions = {}): UnicodeResult {
  const only = opts.only ?? 'nonAscii'
  const hit = (c: number) => (only === 'cjk' ? c >= 0x4e00 && c <= 0x9fa5 : c > 126 || c < 32)
  let out = ''
  let changed = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const c = text.charCodeAt(i)
    if (!inString) {
      out += ch
      if (c === 34) inString = true
      continue
    }
    if (c === 92) {
      // 反斜杠：整个转义序列原样搬
      const next = text[i + 1]
      if (next === undefined) {
        out += ch
        continue
      }
      out += ch + next
      i++
      continue
    }
    if (c === 34) {
      inString = false
      out += ch
      continue
    }
    if (hit(c)) {
      out += hex4(c)
      changed++
      continue
    }
    out += ch
  }
  return { text: out, changed }
}

/** 把字符串内部的 `\uXXXX` 还原成字符（`\ud83d\ude00` 这样连着写会自然还原成 emoji） */
export function unescapeUnicode(text: string): UnicodeResult {
  let out = ''
  let changed = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const c = text.charCodeAt(i)
    if (!inString) {
      out += ch
      if (c === 34) inString = true
      continue
    }
    if (c === 34) {
      inString = false
      out += ch
      continue
    }
    if (c === 92) {
      const next = text[i + 1]
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          const code = parseInt(hex, 16)
          // 引号 / 反斜杠 / 控制字符还原后会破坏 JSON 结构，保持转义形式
          if (code >= 32 && code !== 34 && code !== 92 && code !== 127) {
            out += String.fromCharCode(code)
            changed++
            i += 5
            continue
          }
          out += ch + 'u' + hex
          i += 5
          continue
        }
      }
      if (next === undefined) {
        out += ch
        continue
      }
      out += ch + next
      i++
      continue
    }
    out += ch
  }
  return { text: out, changed }
}
