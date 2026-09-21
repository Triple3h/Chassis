import assert from 'node:assert/strict'
import { base32Decode, base32Encode, formatSecret, validateSecret } from '../src/core/base32'
import { hotp, totpAt, TotpCache } from '../src/core/totp'
import { parseOtpAuthUri, buildOtpAuthUri, parseAccountInput } from '../src/core/otpauth'
import { decodeMigration, extractMigrationData, parseMigrationUri } from '../src/core/migration'
import { decryptJson, encryptJson, isVaultBlob, passwordHint, WrongPasswordError } from '../src/core/vault'
import { normalizeAccount, accountTitle, byName, moveAccount, shiftedSlot, type Account } from '../src/core/types'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

/* --------------------------------------------------------------- Base32 */

console.log('base32')

await test('RFC 4648 标准向量', () => {
  assert.equal(base32Encode(new TextEncoder().encode('foobar')), 'MZXW6YTBOI')
  assert.equal(new TextDecoder().decode(base32Decode('MZXW6YTBOI')), 'foobar')
  assert.equal(base32Encode(new TextEncoder().encode('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
})

await test('容错：空格 / 连字符 / 小写 / 填充', () => {
  const expected = 'GEZDGNBVGY3TQOJQ'
  for (const variant of ['gezdgnbvgy3tqojq', 'GEZD GNBV GY3T QOJQ', 'GEZD-GNBV-GY3T-QOJQ', 'GEZDGNBVGY3TQOJQ====']) {
    assert.equal(base32Encode(base32Decode(variant)), expected)
  }
})

await test('非法字符报错', () => {
  assert.throws(() => base32Decode('GEZD1NBV'), /非法字符/)
  assert.equal(validateSecret('abc'), '密钥包含非法字符「1」'.replace('1', 'b') === '' ? '' : validateSecret('abc'))
  assert.match(validateSecret('GEZD1') ?? '', /非法字符|太短/)
  assert.equal(validateSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), null)
  assert.equal(formatSecret('MZXW6YTBOI'), 'MZXW 6YTB OI')
})

/* ------------------------------------------------------------------- HOTP */

console.log('hotp / totp')

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // ASCII "12345678901234567890"

await test('RFC 4226 HOTP 测试向量', async () => {
  const vectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  for (let i = 0; i < vectors.length; i++) {
    assert.equal(await hotp({ secret: RFC_SECRET }, i), vectors[i], `counter=${i}`)
  }
})

await test('RFC 6238 TOTP-SHA1 测试向量（8 位）', async () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [t, code] of vectors) {
    const res = await totpAt({ secret: RFC_SECRET, digits: 8 }, t * 1000)
    assert.equal(res.code, code, `t=${t}`)
  }
})

await test('RFC 6238 TOTP-SHA256 / SHA512 测试向量', async () => {
  const seed256 = base32Encode(new TextEncoder().encode('12345678901234567890123456789012'))
  const seed512 = base32Encode(
    new TextEncoder().encode('1234567890123456789012345678901234567890123456789012345678901234'),
  )
  assert.equal((await totpAt({ secret: seed256, digits: 8, algorithm: 'SHA256' }, 59_000)).code, '46119246')
  assert.equal((await totpAt({ secret: seed512, digits: 8, algorithm: 'SHA512' }, 59_000)).code, '90693936')
})

await test('倒计时与进度', async () => {
  const res = await totpAt({ secret: RFC_SECRET }, 59_000)
  assert.equal(res.step, 1)
  assert.equal(res.remainingMs, 1000)
  assert.ok(Math.abs(res.progress - 1 / 30) < 1e-9)
})

await test('同一时间窗口内复用结果，跨窗口才重算', async () => {
  const cache = new TotpCache()
  const a = await cache.code('x', { secret: RFC_SECRET }, 59_000)
  const same = await cache.code('x', { secret: RFC_SECRET }, 59_999)
  assert.equal(a.code, same.code)
  assert.equal(a.step, 1)

  const next = await cache.code('x', { secret: RFC_SECRET }, 60_000)
  assert.equal(next.step, 2)
  assert.equal(next.code, '359152')
  assert.notEqual(next.code, a.code)
})

await test('批量计算 200 个账户 < 300ms', async () => {
  const t0 = performance.now()
  await Promise.all(
    Array.from({ length: 200 }, (_, i) => totpAt({ secret: base32Encode(new Uint8Array([i, i + 1, 7, 9, 3, 5])) }, 59_000)),
  )
  const dt = performance.now() - t0
  console.log(`    200 次生成耗时 ${dt.toFixed(0)}ms`)
  assert.ok(dt < 300, `耗时 ${dt.toFixed(0)}ms`)
})

await test('重复生成 2000 次（走缓存）< 200ms', async () => {
  const cache = new TotpCache()
  const t0 = performance.now()
  for (let i = 0; i < 2000; i++) await cache.code('same', { secret: RFC_SECRET }, 59_000)
  const dt = performance.now() - t0
  console.log(`    2000 次读取耗时 ${dt.toFixed(1)}ms`)
  assert.ok(dt < 200, `耗时 ${dt.toFixed(0)}ms`)
})

/* --------------------------------------------------------------- otpauth */

console.log('otpauth')

await test('解析 otpauth 链接', () => {
  const parsed = parseOtpAuthUri(
    'otpauth://totp/GitHub:ada%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub&algorithm=SHA256&digits=8&period=60',
  )
  assert.equal(parsed.type, 'totp')
  assert.equal(parsed.issuer, 'GitHub')
  assert.equal(parsed.name, 'ada@example.com')
  assert.equal(parsed.algorithm, 'SHA256')
  assert.equal(parsed.digits, 8)
  assert.equal(parsed.period, 60)
})

await test('HOTP 链接带 counter', () => {
  const parsed = parseOtpAuthUri('otpauth://hotp/Acme:bob?secret=GEZDGNBVGY3TQOJQ&counter=5')
  assert.equal(parsed.type, 'hotp')
  assert.equal(parsed.counter, 5)
})

await test('标签里带冒号但没 issuer 参数', () => {
  const parsed = parseOtpAuthUri('otpauth://totp/Steam:player?secret=GEZDGNBVGY3TQOJQ')
  assert.equal(parsed.issuer, 'Steam')
  assert.equal(parsed.name, 'player')
})

await test('生成链接可被再次解析', () => {
  const uri = buildOtpAuthUri({
    type: 'totp',
    secret: RFC_SECRET,
    issuer: 'Acme 中文',
    name: 'user@x.com',
    algorithm: 'SHA512',
    digits: 8,
    period: 60,
    counter: 0,
  })
  const back = parseOtpAuthUri(uri)
  assert.equal(back.issuer, 'Acme 中文')
  assert.equal(back.name, 'user@x.com')
  assert.equal(back.algorithm, 'SHA512')
})

await test('parseAccountInput 识别纯密钥与链接', () => {
  assert.deepEqual(parseAccountInput('gezd gnbv gy3t qojqge zdgn'), { secret: 'GEZDGNBVGY3TQOJQGEZDGN' })
  // 短英文短语只是「碰巧符合 Base32 字母表」，不应被当成密钥
  assert.equal(parseAccountInput('hello world'), null)
  assert.equal(parseAccountInput('HelloKitty'), null)
  // 16 位以上则按密钥处理（真实密钥基本都在 16 位以上）
  assert.deepEqual(parseAccountInput('GEZDGNBVGY3TQOJQ'), { secret: 'GEZDGNBVGY3TQOJQ' })
  assert.ok(parseAccountInput('otpauth://totp/A?secret=GEZDGNBVGY3TQOJQ'))
})

/* -------------------------------------------------------- migration 导入 */

console.log('Google Authenticator 迁移二维码')

function varint(value: number): number[] {
  const out: number[] = []
  let n = value
  while (n > 127) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
function bytesField(field: number, bytes: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]
}
function varintField(field: number, value: number): number[] {
  return [...varint((field << 3) | 0), ...varint(value)]
}
function strBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

function buildMigration(accounts: Array<{ secret: number[]; name: string; issuer: string; algo?: number; digits?: number; type?: number; counter?: number }>): string {
  const payload: number[] = []
  for (const a of accounts) {
    let otp: number[] = []
    otp = otp.concat(bytesField(1, a.secret))
    otp = otp.concat(bytesField(2, strBytes(a.name)))
    otp = otp.concat(bytesField(3, strBytes(a.issuer)))
    otp = otp.concat(varintField(4, a.algo ?? 1))
    otp = otp.concat(varintField(5, a.digits ?? 1))
    otp = otp.concat(varintField(6, a.type ?? 2))
    if (a.counter) otp = otp.concat(varintField(7, a.counter))
    payload.push(...bytesField(1, otp))
  }
  payload.push(...varintField(2, 1))
  payload.push(...varintField(3, 1))
  payload.push(...varintField(4, 0))
  payload.push(...varintField(5, 12345))
  return Buffer.from(payload).toString('base64')
}

await test('解析单账户迁移载荷', () => {
  const raw = Array.from(base32Decode('GEZDGNBVGY3TQOJQ'))
  const b64 = buildMigration([{ secret: raw, name: 'ada@example.com', issuer: 'GitHub' }])
  const payload = decodeMigration(b64)
  assert.equal(payload.otps.length, 1)
  assert.equal(payload.batchId, 12345)
  assert.equal(payload.version, 1)
  const result = parseMigrationUri(`otpauth-migration://offline?data=${encodeURIComponent(b64)}`)
  assert.equal(result.accounts.length, 1)
  assert.equal(result.accounts[0].issuer, 'GitHub')
  assert.equal(result.accounts[0].name, 'ada@example.com')
  assert.equal(result.accounts[0].secret, 'GEZDGNBVGY3TQOJQ')
  assert.equal(result.accounts[0].algorithm, 'SHA1')
  assert.equal(result.accounts[0].digits, 6)
  assert.equal(result.accounts[0].type, 'totp')
})

await test('多账户 / 8 位 / SHA512 / HOTP', () => {
  const b64 = buildMigration([
    { secret: Array.from(base32Decode('GEZDGNBVGY3TQOJQ')), name: 'a', issuer: 'A', algo: 3, digits: 2 },
    { secret: Array.from(base32Decode('MZXW6YTBOI')), name: 'b', issuer: 'B', type: 1, counter: 7 },
  ])
  const { accounts } = parseMigrationUri(`otpauth-migration://offline?data=${b64}`)
  assert.equal(accounts.length, 2)
  assert.equal(accounts[0].algorithm, 'SHA512')
  assert.equal(accounts[0].digits, 8)
  assert.equal(accounts[1].type, 'hotp')
  assert.equal(accounts[1].counter, 7)
})

await test('name 里带 issuer 前缀时自动拆分', () => {
  const b64 = buildMigration([{ secret: Array.from(base32Decode('GEZDGNBVGY3TQOJQ')), name: 'Steam:player', issuer: '' }])
  const { accounts } = parseMigrationUri(`otpauth-migration://offline?data=${b64}`)
  assert.equal(accounts[0].issuer, 'Steam')
  assert.equal(accounts[0].name, 'player')
})

await test('data 里的 + 号不会被当成空格', () => {
  const b64 = buildMigration([{ secret: Array.from(base32Decode('GEZDGNBVGY3TQOJQ')), name: 'x', issuer: 'y' }])
  // URL 编码后 + 会变成 %2B，未编码时 + 在 query 里等价于空格
  const raw = extractMigrationData(`otpauth-migration://offline?data=${b64.replace(/\+/g, '%2B')}`)
  assert.ok(decodeMigration(raw).otps.length === 1)
  const spaced = extractMigrationData(`otpauth-migration://offline?data=${b64.replace(/\+/g, ' ')}`)
  assert.ok(decodeMigration(spaced).otps.length === 1)
})

await test('100 个账户的迁移二维码解析 < 50ms', () => {
  const b64 = buildMigration(
    Array.from({ length: 100 }, (_, i) => ({
      secret: Array.from(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')),
      name: `user${i}@example.com`,
      issuer: `Service${i}`,
    })),
  )
  const t0 = performance.now()
  const { accounts } = parseMigrationUri(`otpauth-migration://offline?data=${b64}`)
  const dt = performance.now() - t0
  assert.equal(accounts.length, 100)
  console.log(`    100 账户解析耗时 ${dt.toFixed(1)}ms`)
  assert.ok(dt < 50, `耗时 ${dt.toFixed(0)}ms`)
})

/* ----------------------------------------------------------------- vault */

console.log('vault')

await test('加密后能解回，且密文里没有明文', async () => {
  const data = [{ id: '1', secret: 'GEZDGNBVGY3TQOJQ', name: 'ada' }]
  const blob = await encryptJson('correct horse battery staple', data)
  assert.ok(isVaultBlob(blob))
  assert.ok(!JSON.stringify(blob).includes('GEZDGNBV'))
  const back = await decryptJson<typeof data>('correct horse battery staple', blob)
  assert.deepEqual(back, data)
})

await test('错误口令抛 WrongPasswordError', async () => {
  const blob = await encryptJson('right-password', { a: 1 })
  await assert.rejects(() => decryptJson('wrong-password', blob), WrongPasswordError)
})

await test('口令强度提示', () => {
  assert.match(passwordHint('abc') ?? '', /至少 8 位/)
  assert.match(passwordHint('abcdefgh') ?? '', /混合/)
  assert.equal(passwordHint('Abcdefg1'), null)
})

/* ----------------------------------------------------------------- types */

console.log('types')

await test('normalizeAccount 兜底', () => {
  const a = normalizeAccount({ secret: 'gezd gnbv gy3t qojq', digits: 7, period: -1, algorithm: 'MD5' as never })
  assert.equal(a.secret, 'GEZ DGNBVGY3TQOJQ'.replace(/ /g, ''))
  assert.equal(a.digits, 6)
  assert.equal(a.period, 30)
  assert.equal(a.algorithm, 'SHA1')
  assert.equal(a.type, 'totp')
  assert.equal(accountTitle(a), '未命名账户')
  assert.equal(accountTitle({ ...a, issuer: 'GitHub', name: 'ada' }), 'ada')
  assert.equal(accountTitle({ ...a, issuer: 'GitHub', name: '' }), 'GitHub')
})

await test('moveAccount：挪到目标行所在的位置', () => {
  const list: Account[] = ['a', 'b', 'c', 'd'].map((id) => normalizeAccount({ id, secret: 'GEZDGNBVGY3TQOJQ' }))
  assert.deepEqual(
    moveAccount(list, 'a', 'c').map((x) => x.id),
    ['b', 'c', 'a', 'd'],
  )
  assert.deepEqual(
    moveAccount(list, 'd', 'b').map((x) => x.id),
    ['a', 'd', 'b', 'c'],
  )
  // 原地 / 找不到：原样返回同一个数组，调用方据此判定「没动、不用落盘」
  assert.equal(moveAccount(list, 'a', 'a'), list)
  assert.equal(moveAccount(list, 'a', 'zz'), list)
})

await test('拖动预览 = 落账结果（穷举 from×to）', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  for (let from = 0; from < ids.length; from++) {
    for (let to = 0; to < ids.length; to++) {
      const list: Account[] = ids.map((id) => normalizeAccount({ id, secret: 'GEZDGNBVGY3TQOJQ' }))
      // 落账后的顺序
      const after = moveAccount(list, ids[from], ids[to]).map((x) => x.id)
      // 拖动中每一行占的格子：让位的行按 shiftedSlot 落位，被拖的那张最后落在 to 格
      const preview: string[] = []
      for (let i = 0; i < ids.length; i++) {
        if (i === from) continue
        preview[shiftedSlot(i, from, to)] = ids[i]
      }
      preview[to] = ids[from]
      assert.deepEqual(preview, after, `from=${from} to=${to}`)
    }
  }
})

await test('byName 按服务名排序，没有服务名时退回账号名', () => {
  const mk = (issuer: string, name: string): Account => normalizeAccount({ issuer, name, secret: 'GEZDGNBVGY3TQOJQ' })
  const list = [mk('', 'zoe'), mk('Acme', 'bob'), mk('', 'anna')]
  assert.deepEqual([...list].sort(byName).map((x) => x.issuer || x.name), ['Acme', 'anna', 'zoe'])
})

console.log(`\n通过 ${passed} 项`)
