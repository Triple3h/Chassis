/**
 * 行级 JSON 高亮。
 *
 * 只做「已经格式化好的 JSON」——此时字符串、数字、标量都不会跨行，
 * 因此可以按行独立着色，配合虚拟滚动只处理可视行（约 50 行 × 100 字符），
 * 比整篇 tokenize 再生成一大坨 HTML 快得多，也不会让 10MB 文本炸掉内存。
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c] as string)
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`
}

/** 超过这个长度的行放弃着色（压缩后的 JSON 就是一根超长行） */
export const HIGHLIGHT_LINE_LIMIT = 4000

export function highlightJsonLine(line: string): string {
  if (line.length > HIGHLIGHT_LINE_LIMIT) return escapeHtml(line)
  let out = ''
  let i = 0
  const n = line.length
  while (i < n) {
    const c = line.charCodeAt(i)
    // 字符串（可能是键，也可能是值）
    if (c === 34) {
      let j = i + 1
      while (j < n) {
        const d = line.charCodeAt(j)
        if (d === 92) {
          j += 2
          continue
        }
        if (d === 34) break
        j++
      }
      const lit = line.slice(i, Math.min(j + 1, n))
      // 后面跟冒号的按「键」着色
      let k = j + 1
      while (k < n && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++
      out += span(line.charCodeAt(k) === 58 ? 'sof-hl-key' : 'sof-hl-str', lit)
      i = j + 1
      continue
    }
    // 数字
    if ((c >= 48 && c <= 57) || (c === 45 && i + 1 < n && line.charCodeAt(i + 1) >= 48 && line.charCodeAt(i + 1) <= 57)) {
      let j = i + 1
      while (j < n) {
        const d = line.charCodeAt(j)
        if ((d >= 48 && d <= 57) || d === 46 || d === 45 || d === 43 || d === 101 || d === 69) j++
        else break
      }
      out += span('sof-hl-num', line.slice(i, j))
      i = j
      continue
    }
    // 关键字
    if (line.startsWith('true', i) || line.startsWith('null', i)) {
      out += span('sof-hl-kw', line.slice(i, i + 4))
      i += 4
      continue
    }
    if (line.startsWith('false', i)) {
      out += span('sof-hl-kw', line.slice(i, i + 5))
      i += 5
      continue
    }
    // 标点：整段连着输出，减少 span 数量
    let j = i
    while (j < n) {
      const d = line.charCodeAt(j)
      if (d === 34) break
      if ((d >= 48 && d <= 57)) break
      if (line.startsWith('true', j) || line.startsWith('false', j) || line.startsWith('null', j)) break
      j++
    }
    out += span('sof-hl-punc', line.slice(i, j))
    i = j
  }
  return out
}
