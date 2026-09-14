/**
 * 行索引：一次扫描记录每行起始偏移 + 最长行长度。
 * 避免 text.split('\n') 为百万行文本复制出百万个小字符串；
 * 同时最长行长度用于给滚动容器一个稳定的横向宽度，避免滚动条抖动。
 */
export interface LineIndex {
  starts: Int32Array
  count: number
  maxLen: number
}

export function indexLines(text: string): LineIndex {
  if (!text) return { starts: Int32Array.from([0]), count: 0, maxLen: 0 }
  const starts: number[] = [0]
  let maxLen = 0
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      const len = i - lineStart
      if (len > maxLen) maxLen = len
      starts.push(i + 1)
      lineStart = i + 1
    }
  }
  const lastLen = text.length - lineStart
  if (lastLen > maxLen) maxLen = lastLen
  return { starts: Int32Array.from(starts), count: starts.length, maxLen }
}

export function lineAt(text: string, index: LineIndex, row: number): string {
  if (row < 0 || row >= index.count) return ''
  const from = index.starts[row]
  const to = row + 1 < index.count ? index.starts[row + 1] - 1 : text.length
  return text.charCodeAt(to - 1) === 13 ? text.slice(from, to - 1) : text.slice(from, to)
}
