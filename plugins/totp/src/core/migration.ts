import { base32Encode } from './base32'
import type { Account, Algorithm } from './types'

/**
 * Google Authenticator 迁移二维码解析。
 *
 * 导出格式为 `otpauth-migration://offline?data=<base64>`，data 是 Protobuf：
 *   message MigrationPayload {
 *     repeated OtpParameters otp_parameters = 1;   // secret/name/issuer/algorithm/digits/type/counter
 *     int32 version = 2;  int32 batch_size = 3;    // 账户多时 GA 会拆成多张二维码
 *     int32 batch_index = 4;  int32 batch_id = 5;
 *   }
 *
 * 只解析用到的字段，手写最小 Protobuf 读取器（约 60 行），
 * 相比引入 protobufjs 省下 ~200KB 体积，解析速度也更快（纯位运算 + subarray）。
 */

class Reader {
  private buf: Uint8Array
  pos = 0

  constructor(buf: Uint8Array) {
    this.buf = buf
  }

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  varint(): number {
    let result = 0
    let shift = 0
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++]
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return result
      shift += 7
      if (shift > 63) throw new Error('Protobuf varint 超出范围')
    }
    throw new Error('Protobuf 数据被截断')
  }

  bytes(): Uint8Array {
    const len = this.varint()
    const end = this.pos + len
    if (end > this.buf.length) throw new Error('Protobuf 长度越界')
    const out = this.buf.subarray(this.pos, end)
    this.pos = end
    return out
  }

  text(): string {
    return new TextDecoder().decode(this.bytes())
  }

  skip(wire: number) {
    switch (wire) {
      case 0:
        this.varint()
        break
      case 1:
        this.pos += 8
        break
      case 2:
        this.bytes()
        break
      case 5:
        this.pos += 4
        break
      default:
        throw new Error(`不支持的 Protobuf 类型：${wire}`)
    }
  }
}

export interface MigrationOtp {
  secret: Uint8Array
  name: string
  issuer: string
  algorithm: number
  digits: number
  type: number
  counter: number
}

export interface MigrationPayload {
  otps: MigrationOtp[]
  version: number
  batchSize: number
  batchIndex: number
  batchId: number
}

function parseOtp(buf: Uint8Array): MigrationOtp {
  const r = new Reader(buf)
  const otp: MigrationOtp = { secret: new Uint8Array(), name: '', issuer: '', algorithm: 0, digits: 0, type: 0, counter: 0 }
  while (!r.done) {
    const tag = r.varint()
    const field = tag >>> 3
    const wire = tag & 7
    switch (field) {
      case 1:
        otp.secret = r.bytes().slice()
        break
      case 2:
        otp.name = r.text()
        break
      case 3:
        otp.issuer = r.text()
        break
      case 4:
        otp.algorithm = r.varint()
        break
      case 5:
        otp.digits = r.varint()
        break
      case 6:
        otp.type = r.varint()
        break
      case 7:
        otp.counter = r.varint()
        break
      default:
        r.skip(wire)
        break
    }
  }
  return otp
}

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/\s/g, '')
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** 解析 otpauth-migration 链接里的 base64 数据 */
export function decodeMigration(base64: string): MigrationPayload {
  const bytes = base64ToBytes(base64)
  const r = new Reader(bytes)
  const payload: MigrationPayload = { otps: [], version: 0, batchSize: 0, batchIndex: 0, batchId: 0 }
  while (!r.done) {
    const tag = r.varint()
    const field = tag >>> 3
    const wire = tag & 7
    if (field === 1 && wire === 2) payload.otps.push(parseOtp(r.bytes()))
    else if (field === 2 && wire === 0) payload.version = r.varint()
    else if (field === 3 && wire === 0) payload.batchSize = r.varint()
    else if (field === 4 && wire === 0) payload.batchIndex = r.varint()
    else if (field === 5 && wire === 0) payload.batchId = r.varint()
    else r.skip(wire)
  }
  return payload
}

/** 从完整链接里取出 data 参数（不能用 URLSearchParams，`+` 会被当成空格） */
export function extractMigrationData(uri: string): string {
  const at = uri.indexOf('data=')
  if (at < 0) throw new Error('链接里没有 data 参数')
  let raw = uri.slice(at + 5)
  const amp = raw.indexOf('&')
  if (amp >= 0) raw = raw.slice(0, amp)
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* 已是明文 */
  }
  // URL 里可能被编码成空格，还原成标准 base64
  return raw.replace(/ /g, '+')
}

const ALGORITHM_MAP: Record<number, Algorithm> = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }

export interface MigrationResult {
  accounts: Partial<Account>[]
  batchSize: number
  batchIndex: number
  batchId: number
  /** 不支持的算法 / 类型被跳过的数量 */
  skipped: number
}

/** 把迁移数据转成账户草稿 */
export function migrationToAccounts(payload: MigrationPayload): MigrationResult {
  const accounts: Partial<Account>[] = []
  let skipped = 0
  for (const otp of payload.otps) {
    // 4 = MD5，几乎见不到，且 WebCrypto 不支持
    if (otp.algorithm === 4 || otp.type === 0) {
      skipped++
      continue
    }
    let issuer = otp.issuer
    let name = otp.name
    // 有些实现把 "issuer:account" 塞进 name
    if (!issuer && name.includes(':')) {
      const [head, ...rest] = name.split(':')
      issuer = head.trim()
      name = rest.join(':').trim()
    }
    accounts.push({
      type: otp.type === 1 ? 'hotp' : 'totp',
      secret: base32Encode(otp.secret),
      issuer: issuer.trim(),
      name: name.trim(),
      algorithm: ALGORITHM_MAP[otp.algorithm] ?? 'SHA1',
      digits: otp.digits === 2 ? 8 : 6,
      period: 30,
      counter: otp.counter || 0,
    })
  }
  return {
    accounts,
    batchSize: payload.batchSize,
    batchIndex: payload.batchIndex,
    batchId: payload.batchId,
    skipped,
  }
}

/** 一步到位：链接 → 账户草稿 */
export function parseMigrationUri(uri: string): MigrationResult {
  return migrationToAccounts(decodeMigration(extractMigrationData(uri)))
}
