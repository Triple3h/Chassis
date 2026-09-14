import { base32Decode } from './base32'
import type { Algorithm } from './types'

/**
 * TOTP / HOTP（RFC 4226 / 6238），底层用 WebCrypto 的原生 HMAC。
 *
 * 性能要点：
 *  - CryptoKey 按「密钥+算法」缓存，避免每次生成都做一次 importKey（这是最贵的一步）；
 *  - 生成的验证码按「账户 + 时间步」缓存，同一窗口内重复读取不重新计算，
 *    界面每秒刷新时只有跨过窗口边界的那一次会真正算一遍。
 */

const HASH_MAP: Record<Algorithm, string> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
}

const keyCache = new Map<string, Promise<CryptoKey>>()
const MAX_KEY_CACHE = 256

/** counter 是 64 位大端整数，这里用两个 32 位半区拼出来，避免 JS 位移溢出 */
function counterToBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8)
  let high = Math.floor(counter / 0x1_0000_0000)
  let low = counter % 0x1_0000_0000
  for (let i = 3; i >= 0; i--) {
    bytes[i] = high & 0xff
    bytes[4 + i] = low & 0xff
    high = Math.floor(high / 256)
    low = Math.floor(low / 256)
  }
  return bytes
}

async function importKey(algorithm: Algorithm, secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: HASH_MAP[algorithm] }, false, [
    'sign',
  ])
}

function getKey(algorithm: Algorithm, secret: Uint8Array): Promise<CryptoKey> {
  let cacheKey = algorithm + ':'
  for (let i = 0; i < secret.length; i++) cacheKey += String.fromCharCode(secret[i])
  const hit = keyCache.get(cacheKey)
  if (hit) return hit
  const promise = importKey(algorithm, secret)
  if (keyCache.size >= MAX_KEY_CACHE) {
    // 简单淘汰：清掉最早的一批，避免无限增长
    const drop = keyCache.size - MAX_KEY_CACHE + 32
    let n = 0
    for (const k of keyCache.keys()) {
      keyCache.delete(k)
      if (++n >= drop) break
    }
  }
  keyCache.set(cacheKey, promise)
  return promise
}

/** RFC 4226 动态截断 */
function truncate(signature: Uint8Array, digits: number): string {
  const offset = signature[signature.length - 1] & 0x0f
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff)
  const mod = 10 ** digits
  return (binary % mod).toString().padStart(digits, '0')
}

export interface OtpParams {
  /** Base32 密钥 */
  secret: string
  algorithm?: Algorithm
  digits?: number
  period?: number
}

/** 计算 HOTP（counter 为计数器值） */
export async function hotp(params: OtpParams, counter: number): Promise<string> {
  const algorithm = params.algorithm ?? 'SHA1'
  const digits = params.digits ?? 6
  const key = await getKey(algorithm, base32Decode(params.secret))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterToBytes(counter) as BufferSource))
  return truncate(signature, digits)
}

export interface TotpResult {
  code: string
  /** 当前时间步序号 */
  step: number
  /** 当前验证码剩余有效毫秒 */
  remainingMs: number
  /** 进度 0~1（1 表示刚刚进入新窗口） */
  progress: number
}

/** 计算指定时刻的 TOTP */
export async function totpAt(params: OtpParams, timeMs: number = Date.now()): Promise<TotpResult> {
  const period = params.period ?? 30
  const periodMs = period * 1000
  const step = Math.floor(timeMs / periodMs)
  const code = await hotp(params, step)
  const elapsed = timeMs - step * periodMs
  return {
    code,
    step,
    remainingMs: periodMs - elapsed,
    progress: 1 - elapsed / periodMs,
  }
}

/** 带窗口缓存的批量生成器 */
export class TotpCache {
  private cache = new Map<string, { step: number; code: string }>()

  async code(id: string, params: OtpParams, timeMs: number = Date.now()): Promise<{ code: string; step: number }> {
    const period = params.period ?? 30
    const step = Math.floor(timeMs / (period * 1000))
    const hit = this.cache.get(id)
    if (hit && hit.step === step) return hit
    const code = await hotp(params, step)
    this.cache.set(id, { step, code })
    return { code, step }
  }

  /** HOTP 需要按计数器取值，不进缓存 */
  invalidate(id: string) {
    this.cache.delete(id)
  }

  clear() {
    this.cache.clear()
  }
}

/** 秒级倒计时文案 */
export function secondsLeft(period: number, timeMs: number = Date.now()): number {
  const periodMs = period * 1000
  return Math.ceil((periodMs - (timeMs % periodMs)) / 1000)
}
