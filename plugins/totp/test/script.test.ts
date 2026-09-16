import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultScanDirs,
  isSupportedExt,
  mimeFromExt,
  normalizePathInput,
  readImageFile,
  scanRecentImages,
  sniffMime,
  MAX_BYTES,
} from '../src/no-view/find-image'

/**
 * script 命令（read-image）的核心逻辑测试。
 * 直接在临时目录里造真实文件，验证扫描 / 过滤 / 魔数校验 / base64 读取。
 */

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'totp-scan-'))

/** 最小的合法文件头（内容不重要，只要前若干字节能被识别） */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3)])
const TEXT = Buffer.from('这不是图片，只是碰巧改名成了 png')

function write(name: string, data: Buffer, ageMinutes = 0): string {
  const full = path.join(tmp, name)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, data)
  if (ageMinutes > 0) {
    const when = new Date(Date.now() - ageMinutes * 60_000)
    utimesSync(full, when, when)
  }
  return full
}

const freshPng = write('shot-new.png', PNG)
const freshJpg = write('shot-old.jpg', JPEG, 5)
const staleGif = write('stale.gif', GIF, 180)
const disguised = write('fake.png', TEXT)
const readme = write('notes.txt', Buffer.from('hello'))
write('empty.png', Buffer.alloc(0))
write('.hidden.png', PNG)

console.log('文件头识别')

test('sniffMime 认得出 PNG / JPEG / GIF', () => {
  assert.equal(sniffMime(PNG), 'image/png')
  assert.equal(sniffMime(JPEG), 'image/jpeg')
  assert.equal(sniffMime(GIF), 'image/gif')
  assert.equal(sniffMime(TEXT), null)
  assert.equal(sniffMime(Buffer.alloc(4)), null)
})

test('扩展名白名单', () => {
  assert.equal(isSupportedExt('/a/b.PNG'), true)
  assert.equal(isSupportedExt('/a/b.jpeg'), true)
  assert.equal(isSupportedExt('/a/b.txt'), false)
  assert.equal(isSupportedExt('/a/b'), false)
  assert.equal(mimeFromExt('/a/b.webp'), 'image/webp')
  assert.equal(mimeFromExt('/a/b.unknown'), 'application/octet-stream')
})

console.log('目录扫描')

test('只返回近期、合法、非空的图片', () => {
  const found = scanRecentImages({ dirs: [tmp], withinMinutes: 60, limit: 10 })
  const names = found.map((f) => f.name)
  assert.ok(names.includes('shot-new.png'))
  assert.ok(names.includes('shot-old.jpg'))
  // 3 小时前的被时间窗过滤
  assert.ok(!names.includes('stale.gif'))
  // 非图片扩展名被过滤
  assert.ok(!names.includes('notes.txt'))
  // 隐藏文件被过滤
  assert.ok(!names.includes('.hidden.png'))
  // 空文件被过滤
  assert.ok(!names.includes('empty.png'))
  // 伪装成 png 的文本会在读取阶段被拦下，扫描阶段放行（只看元信息）
  assert.ok(names.includes('fake.png'))
})

test('按修改时间倒序、limit 生效、结果可复现', () => {
  const found = scanRecentImages({ dirs: [tmp], withinMinutes: 60, limit: 10 })
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].mtime >= found[i].mtime, '应按时间倒序')
  }
  // 最新那张必定排在最前
  assert.equal(found[0].mtime, Math.max(...found.map((f) => f.mtime)))
  assert.equal(scanRecentImages({ dirs: [tmp], withinMinutes: 60, limit: 1 }).length, 1)
  // 同一毫秒写入多张时，顺序也不能抖
  const again = scanRecentImages({ dirs: [tmp], withinMinutes: 60, limit: 10 })
  assert.deepEqual(
    again.map((f) => f.name),
    found.map((f) => f.name),
  )
})

test('目录不存在时安静跳过', () => {
  const found = scanRecentImages({ dirs: ['/definitely/not/here', tmp], withinMinutes: 60, limit: 5 })
  assert.ok(found.length >= 2)
  assert.equal(scanRecentImages({ dirs: ['/definitely/not/here'] }).length, 0)
})

test('默认扫描目录是绝对路径且不重复', () => {
  const dirs = defaultScanDirs()
  assert.ok(dirs.length > 0)
  for (const dir of dirs) assert.ok(path.isAbsolute(dir), `${dir} 应该是绝对路径`)
  assert.equal(new Set(dirs).size, dirs.length)
})

console.log('文件读取')

test('路径清洗：引号 / 转义空格 / ~', () => {
  assert.equal(normalizePathInput('  /a/b.png  '), '/a/b.png')
  assert.equal(normalizePathInput('"/a/b c.png"'), '/a/b c.png')
  assert.equal(normalizePathInput("'/a/b.png'"), '/a/b.png')
  assert.equal(normalizePathInput('/a/b\\ c.png'), '/a/b c.png')
  assert.equal(normalizePathInput('~/Desktop/a.png'), path.join(os.homedir(), 'Desktop/a.png'))
  assert.equal(normalizePathInput('~'), os.homedir())
})

test('读取 PNG 返回 mime + base64', () => {
  const file = readImageFile(freshPng)
  assert.equal(file.mime, 'image/png')
  assert.equal(file.name, 'shot-new.png')
  assert.equal(file.size, PNG.length)
  assert.deepEqual(Buffer.from(file.data, 'base64'), PNG)
})

test('伪装文件被魔数校验拦下', () => {
  assert.throws(() => readImageFile(disguised), /不是能被识别的图片/)
})

test('不支持的扩展名直接拒绝', () => {
  assert.throws(() => readImageFile(readme), /不支持的图片格式/)
})

test('不存在的路径给出可读提示', () => {
  assert.throws(() => readImageFile(path.join(tmp, 'nope.png')), /文件不存在/)
})

test('空文件会提示', () => {
  assert.throws(() => readImageFile(path.join(tmp, 'empty.png')), /空的/)
})

test('超过大小上限会拒绝（不读进内存）', () => {
  // 用 truncate 造一个稀疏大文件，避免真的写 20MB 内容
  const huge = path.join(tmp, 'huge.png')
  writeFileSync(huge, PNG)
  truncateSync(huge, MAX_BYTES + 1)
  assert.throws(() => readImageFile(huge), /图片太大/)
  // 扫描阶段也会跳过超大文件
  assert.ok(!scanRecentImages({ dirs: [tmp], withinMinutes: 60 }).some((f) => f.name === 'huge.png'))
  rmSync(huge, { force: true })
})

test('性能：200 个文件的目录扫描 < 200ms', () => {
  const bulk = path.join(tmp, 'bulk')
  mkdirSync(bulk, { recursive: true })
  for (let i = 0; i < 200; i++) writeFileSync(path.join(bulk, `img-${i}.png`), PNG)
  const t0 = performance.now()
  const found = scanRecentImages({ dirs: [bulk], withinMinutes: 60, limit: 8 })
  const dt = performance.now() - t0
  console.log(`    200 个文件耗时 ${dt.toFixed(1)}ms`)
  assert.equal(found.length, 8)
  assert.ok(dt < 200, `耗时 ${dt.toFixed(0)}ms`)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项`)
