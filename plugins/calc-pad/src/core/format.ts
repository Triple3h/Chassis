/** 消掉二进制浮点噪声（0.1 + 0.2 → 0.3）：12 位小数以内四舍五入 */
export function cleanFloat(value: number): number {
  if (!Number.isFinite(value)) return value
  if (Math.abs(value) < 1e12) return Math.round(value * 1e12) / 1e12
  return value
}

function groupInteger(intText: string): string {
  const negative = intText.startsWith('-')
  const digits = negative ? intText.slice(1) : intText
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return negative ? `-${grouped}` : grouped
}

/** 展示用：千分位 + 最多 12 位小数（尾零去掉）；极大/极小数走科学计数法 */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞'
  const cleaned = cleanFloat(value)
  const abs = Math.abs(cleaned)
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) {
    return cleaned.toExponential(6).replace(/\.?0+e/, 'e')
  }
  const [intPart = '0', decPart = ''] = cleaned.toFixed(12).split('.')
  const decimals = decPart.replace(/0+$/, '')
  return decimals ? `${groupInteger(intPart)}.${decimals}` : groupInteger(intPart)
}

/** 复制/带进下一行用：不带千分位，避免粘回去解析不了 */
export function formatPlain(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  return cleanFloat(value).toFixed(12).replace(/\.?0+$/, '')
}

/** 解析用户输入的数字（容忍千分位与空格） */
export function parseNumber(input: string): number | null {
  const clean = input.replace(/[,，\s]/g, '')
  if (!clean) return null
  const value = Number(clean)
  return Number.isFinite(value) ? value : null
}
