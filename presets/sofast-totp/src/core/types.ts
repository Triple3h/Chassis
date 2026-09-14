export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512'
export type OtpType = 'totp' | 'hotp'

export interface Account {
  id: string
  type: OtpType
  /** Base32 密钥，去掉了空格与填充 */
  secret: string
  /** 服务名 / 发行方 */
  issuer: string
  /** 账号名 */
  name: string
  algorithm: Algorithm
  digits: number
  /** 秒；仅 TOTP 有效 */
  period: number
  /** 仅 HOTP 有效 */
  counter: number
  group: string
  note: string
  createdAt: number
}

export interface Settings {
  /** 复制后自动清空剪贴板的秒数，0 表示不自动清空 */
  clearClipboardAfter: number
  /** 是否显示倒计时圆环 */
  showRing: boolean
  /** 隐私模式：只显示选中行的验证码，其余打点（防录屏/旁观） */
  hideCodes: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  clearClipboardAfter: 0,
  showRing: true,
  hideCodes: false,
}

export const ALGORITHMS: Algorithm[] = ['SHA1', 'SHA256', 'SHA512']

export function newId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** 规整账户字段，保证外部导入的数据也能安全落库 */
export function normalizeAccount(input: Partial<Account>): Account {
  const digits = Number(input.digits)
  const period = Number(input.period)
  return {
    id: input.id || newId(),
    type: input.type === 'hotp' ? 'hotp' : 'totp',
    secret: (input.secret || '').replace(/[\s=]/g, '').toUpperCase(),
    issuer: input.issuer || '',
    name: input.name || '',
    algorithm: ALGORITHMS.includes(input.algorithm as Algorithm) ? (input.algorithm as Algorithm) : 'SHA1',
    digits: digits === 8 ? 8 : 6,
    period: Number.isFinite(period) && period > 0 ? period : 30,
    counter: Number.isFinite(Number(input.counter)) ? Number(input.counter) : 0,
    group: input.group || '',
    note: input.note || '',
    createdAt: input.createdAt || Date.now(),
  }
}

/** 用于列表展示与搜索的标题 */
export function accountTitle(a: Account): string {
  if (a.issuer && a.name) return a.name
  return a.name || a.issuer || '未命名账户'
}
