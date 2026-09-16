const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * RFC 4648 Base32 解码。
 * 做了常见容错：忽略空格 / 连字符 / 填充符，大小写不敏感。
 * 逐字符位运算，单遍 O(n)，不产生中间数组。
 */
export function base32Decode(input: string): Uint8Array {
  const out: number[] = []
  let bits = 0
  let value = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    // 跳过空白与分隔符
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 45 || ch === 61) continue
    const idx = decodeChar(ch)
    if (idx < 0) throw new Error(`密钥包含非法字符「${input[i]}」，Base32 只允许 A-Z 与 2-7`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
      value &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(out)
}

function decodeChar(code: number): number {
  // A-Z
  if (code >= 65 && code <= 90) return code - 65
  // a-z
  if (code >= 97 && code <= 122) return code - 97
  // 2-7
  if (code >= 50 && code <= 55) return code - 50 + 26
  // 0/1/8/9 常被误输入，直接判为非法
  return -1
}

export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(value >>> bits) & 31]
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** 展示用：每 4 位一组，便于人工核对 */
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

/** 校验密钥是否可用 */
export function validateSecret(secret: string): string | null {
  const clean = secret.replace(/[\s-]/g, '')
  if (!clean) return '密钥不能为空'
  try {
    const bytes = base32Decode(clean)
    if (bytes.length < 5) return '密钥太短，至少需要 5 字节'
  } catch (err) {
    return err instanceof Error ? err.message : '密钥非法'
  }
  return null
}
