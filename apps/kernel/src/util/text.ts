import { createHash } from 'node:crypto'

/** 稳定 JSON 序列化（键排序），用于 args → 稳定 key */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function shortHash(input: string, len = 8): string {
  return createHash('sha1').update(input).digest('hex').slice(0, len)
}

/** 历史/固定的稳定 key（绝不使用下标） */
export function itemKey(pluginId: string, command: string, args?: unknown): string {
  return `${pluginId}:${command}:${shortHash(stableStringify(args ?? null))}`
}

const SENSITIVE_KEY_RE = /(token|key|secret|password|passwd|pwd|authorization|credential|otp|totp)/i

/** 审计用：截断到 200 字符，敏感字段打码 */
export function truncateForAudit(value: unknown, limit = 200): string {
  const masked = maskSensitive(value, 0)
  let text: string
  try {
    text = typeof masked === 'string' ? masked : JSON.stringify(masked)
  } catch {
    text = String(masked)
  }
  if (text === undefined) text = ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function maskSensitive(value: unknown, depth: number): unknown {
  if (depth > 4) return '…'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => maskSensitive(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '***' : maskSensitive(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 120) return `${value.slice(0, 120)}…`
  return value
}

/** 拼音/英文搜索归一化：小写 + 去空格 */
export function normalizeQuery(input: string): string {
  return input.trim().toLowerCase()
}
