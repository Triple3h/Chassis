/**
 * 可选的口令加密。
 *
 * 宿主的插件存储是明文 JSON（如快：`<插件目录>/data/storage.json`；
 * 启动台：`<dataRoot>/plugins/sofast-totp/storage.json`），
 * 密钥落在明文里等于把 2FA 的所有权一起交出去。开启口令后：
 *   PBKDF2-SHA256(250k) 派生密钥 → AES-GCM-256 加密整份账户表
 * 存储里只留 salt / iv / 密文，口令本身永不落盘。
 */

const ITERATIONS = 250_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface VaultBlob {
  v: 1
  salt: string
  iv: string
  data: string
  /** 创建时间，便于 UI 展示 */
  createdAt: number
}

export class WrongPasswordError extends Error {
  constructor() {
    super('口令不正确')
    this.name = 'WrongPasswordError'
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJson(password: string, value: unknown): Promise<VaultBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plaintext = encoder.encode(JSON.stringify(value))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
  )
  return {
    v: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(cipher),
    createdAt: Date.now(),
  }
}

export async function decryptJson<T>(password: string, blob: VaultBlob): Promise<T> {
  try {
    const key = await deriveKey(password, fromBase64(blob.salt))
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(blob.iv) as BufferSource },
      key,
      fromBase64(blob.data) as BufferSource,
    )
    return JSON.parse(decoder.decode(plain)) as T
  } catch {
    throw new WrongPasswordError()
  }
}

export function isVaultBlob(value: unknown): value is VaultBlob {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<VaultBlob>
  return v.v === 1 && typeof v.salt === 'string' && typeof v.iv === 'string' && typeof v.data === 'string'
}

/** 口令强度提示（不阻塞使用，仅提示） */
export function passwordHint(password: string): string | null {
  if (password.length < 8) return '口令至少 8 位'
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (kinds < 2) return '建议混合大小写、数字或符号'
  return null
}
