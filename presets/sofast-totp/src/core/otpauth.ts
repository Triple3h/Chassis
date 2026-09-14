import { base32Encode } from './base32'
import type { Account, Algorithm, OtpType } from './types'

/**
 * otpauth:// URI 解析与生成（Google Authenticator / Aegis / 1Password 等通用格式）：
 *   otpauth://totp/Issuer:account?secret=XXX&issuer=Issuer&algorithm=SHA1&digits=6&period=30
 */

export interface ParsedOtpAuth {
  type: OtpType
  secret: string
  issuer: string
  name: string
  algorithm: Algorithm
  digits: number
  period: number
  counter: number
}

export function isOtpAuthUri(text: string): boolean {
  return /^otpauth:\/\//i.test(text.trim())
}

export function isMigrationUri(text: string): boolean {
  return /^otpauth-migration:\/\//i.test(text.trim())
}

function toAlgorithm(v: string | null): Algorithm {
  const upper = (v ?? '').toUpperCase()
  return upper === 'SHA256' || upper === 'SHA512' ? upper : 'SHA1'
}

export function parseOtpAuthUri(uri: string): ParsedOtpAuth {
  const url = new URL(uri.trim())
  const type: OtpType = url.host.toLowerCase() === 'hotp' ? 'hotp' : 'totp'
  const params = url.searchParams

  const secret = (params.get('secret') ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!secret) throw new Error('链接里没有 secret 参数')

  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  let issuer = params.get('issuer') ?? ''
  let name = label
  const colon = label.indexOf(':')
  if (colon >= 0) {
    const labelIssuer = label.slice(0, colon).trim()
    const labelName = label.slice(colon + 1).trim()
    if (!issuer) issuer = labelIssuer
    name = labelName || labelIssuer
  }

  const digits = Number(params.get('digits'))
  const period = Number(params.get('period'))
  const counter = Number(params.get('counter'))

  return {
    type,
    secret,
    issuer: issuer.trim(),
    name: name.trim(),
    algorithm: toAlgorithm(params.get('algorithm')),
    digits: digits === 8 ? 8 : 6,
    period: Number.isFinite(period) && period > 0 ? period : 30,
    counter: Number.isFinite(counter) && counter > 0 ? counter : 0,
  }
}

export function buildOtpAuthUri(account: Pick<Account, 'type' | 'secret' | 'issuer' | 'name' | 'algorithm' | 'digits' | 'period' | 'counter'>): string {
  const label = account.issuer ? `${account.issuer}:${account.name || account.issuer}` : account.name
  const params = new URLSearchParams()
  params.set('secret', account.secret)
  if (account.issuer) params.set('issuer', account.issuer)
  if (account.type === 'hotp') {
    params.set('counter', String(account.counter || 0))
  } else {
    if (account.algorithm !== 'SHA1') params.set('algorithm', account.algorithm)
    if (account.digits !== 6) params.set('digits', String(account.digits))
    if (account.period !== 30) params.set('period', String(account.period))
  }
  return `otpauth://${account.type}/${encodeURIComponent(label)}?${params.toString()}`
}

/** 把任意字符串（链接 / 纯密钥）解析成账户草稿 */
export function parseAccountInput(text: string): Partial<Account> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (isOtpAuthUri(trimmed)) {
    const parsed = parseOtpAuthUri(trimmed)
    return { ...parsed }
  }
  // 纯 Base32 密钥：允许空格与连字符。
  // 阈值定在 16 位是刻意的——任意一句纯英文（如 HELLOWORLD）都符合 Base32 字母表，
  // 太宽松的话「把随便一段文字粘进来」就会被误当成密钥。
  const clean = trimmed.replace(/[\s-]/g, '').toUpperCase()
  if (/^[A-Z2-7]{16,}$/.test(clean)) return { secret: clean }
  return null
}

/** 导出成二维码里能放下的紧凑形式（给「分享/迁移」用） */
export function secretToBase32(bytes: Uint8Array): string {
  return base32Encode(bytes)
}
