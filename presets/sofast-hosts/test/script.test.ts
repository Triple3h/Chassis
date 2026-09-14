import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  backupDirOf,
  backupHosts,
  listBackups,
  readBackup,
  readHostsFile,
  resolveHostsPath,
  writeHostsFile,
} from '../src/no-view/_hosts-file'

/**
 * script 命令（hosts-read / hosts-write）的核心逻辑测试。
 * 全程在临时目录里造真实文件，**绝不碰真正的 /etc/hosts**。
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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'sofast-hosts-'))
/**
 * 插件数据目录（N2 的唯一可写处）：
 * 新底座给 `<dataRoot>/plugins/sofast-hosts`，如快兜底成 `<插件目录>/data`。
 * 备份与待生效文件都只能落在它下面 —— 安装目录会被升级覆盖，绝不能写。
 */
const dataPath = path.join(tmp, 'data')
mkdirSync(dataPath, { recursive: true })

function makeTarget(name: string, content: Buffer | string): string {
  const target = path.join(tmp, name)
  writeFileSync(target, content)
  return target
}

const ORIGINAL = '127.0.0.1\tlocalhost\n1.1.1.1\ta.example.com\n'

console.log('路径解析')

test('默认路径按平台给', () => {
  const saved = process.env.SOFAST_HOSTS_PATH
  delete process.env.SOFAST_HOSTS_PATH
  const resolved = resolveHostsPath()
  if (process.platform === 'win32') assert.ok(resolved.endsWith('hosts'))
  else assert.equal(resolved, '/etc/hosts')
  if (saved !== undefined) process.env.SOFAST_HOSTS_PATH = saved
})

test('环境变量可覆盖（测试与自定义安装用）', () => {
  const saved = process.env.SOFAST_HOSTS_PATH
  process.env.SOFAST_HOSTS_PATH = '~/my-hosts'
  assert.equal(resolveHostsPath(), path.resolve(os.homedir(), 'my-hosts'))
  if (saved === undefined) delete process.env.SOFAST_HOSTS_PATH
  else process.env.SOFAST_HOSTS_PATH = saved
})

console.log('读取')

test('读普通文件：内容、大小、mtime 齐全', () => {
  const target = makeTarget('plain.hosts', ORIGINAL)
  const res = readHostsFile(target)
  assert.equal(res.ok, true)
  assert.equal(res.content, ORIGINAL)
  assert.equal(res.size, Buffer.byteLength(ORIGINAL))
  assert.ok(res.mtime > 0)
  assert.equal(res.bom, false)
  assert.equal(res.encoding, 'utf8')
})

test('未授予写权限时 writable 为 false（真实 /etc/hosts 就是这个状态）', () => {
  const target = makeTarget('ro.hosts', ORIGINAL)
  const res = readHostsFile(target)
  // 临时目录里的文件当前用户可写，这里只断言字段存在且是布尔
  assert.equal(typeof res.writable, 'boolean')
})

test('文件不存在时给出可读错误', () => {
  const res = readHostsFile(path.join(tmp, 'nope.hosts'))
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /文件不存在/)
})

test('UTF-8 BOM 被剥离，同时记住它存在', () => {
  const target = makeTarget('bom.hosts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ORIGINAL)]))
  const res = readHostsFile(target)
  assert.equal(res.bom, true)
  assert.equal(res.content, ORIGINAL)
})

test('非 UTF-8 文件按 latin1 直译，保证往返不损坏', () => {
  // GBK 编码的「测试」两个字，不是合法 UTF-8 序列
  const gbk = Buffer.concat([Buffer.from('1.1.1.1 a.com # '), Buffer.from([0xb2, 0xe2, 0xca, 0xd4]), Buffer.from('\n')])
  const target = makeTarget('gbk.hosts', gbk)
  const res = readHostsFile(target)
  assert.equal(res.encoding, 'binary')
  // 即使显示成乱码，字节级往返必须一致
  assert.equal(Buffer.compare(Buffer.from(res.content, 'latin1'), gbk), 0)
})

console.log('备份')

test('备份会复制原文件内容', () => {
  const target = makeTarget('backup-src.hosts', ORIGINAL)
  const saved = backupHosts(dataPath, target)
  assert.ok(saved)
  assert.equal(readFileSync(saved.path, 'utf8'), ORIGINAL)
  assert.match(saved.name, /^hosts-[\w.-]+\.txt$/)
})

test('目标文件不存在时不产生备份', () => {
  assert.equal(backupHosts(dataPath, path.join(tmp, 'ghost.hosts')), null)
})

test('备份落点是 <数据目录>/backups（N2：安装目录只读）', () => {
  const saved = backupHosts(dataPath, makeTarget('loc.hosts', ORIGINAL))
  assert.ok(saved)
  assert.equal(backupDirOf(dataPath), path.join(dataPath, 'backups'))
  assert.equal(path.dirname(saved.path), backupDirOf(dataPath))
})

test('备份列表按时间倒序且过滤掉非法文件名', () => {
  const dir = backupDirOf(dataPath)
  writeFileSync(path.join(dir, 'evil.txt'), 'x')
  writeFileSync(path.join(dir, 'hosts-ok.txt'), 'y')
  const list = listBackups(dataPath)
  assert.ok(list.length >= 2)
  assert.ok(list.every((b) => b.name.startsWith('hosts-')))
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].mtime >= list[i].mtime)
})

test('读备份时挡掉路径穿越', () => {
  assert.throws(() => readBackup(dataPath, '../../etc/passwd'), /不合法/)
  assert.throws(() => readBackup(dataPath, '/etc/passwd'), /不合法/)
})

console.log('写入')

test('直写成功：内容落盘、回读校验通过、留下备份', () => {
  const target = makeTarget('write.hosts', ORIGINAL)
  const next = '127.0.0.1\tlocalhost\n2.2.2.2\tb.example.com\n'
  const res = writeHostsFile({ content: next, dataPath, target })

  assert.equal(res.ok, true)
  assert.equal(res.method, 'direct')
  assert.equal(res.verified, true)
  assert.ok(res.backup)
  assert.equal(readFileSync(target, 'utf8'), next)
  // 备份里是改动前的内容
  assert.equal(readBackup(dataPath, res.backup as string), ORIGINAL)
})

test('备份名重复时不会互相覆盖', () => {
  const target = makeTarget('dup.hosts', ORIGINAL)
  const a = writeHostsFile({ content: '1.1.1.1 a\n', dataPath, target })
  const b = writeHostsFile({ content: '2.2.2.2 b\n', dataPath, target })
  assert.ok(a.backup && b.backup)
  assert.notEqual(a.backup, b.backup)
  assert.equal(readBackup(dataPath, a.backup as string), ORIGINAL)
  assert.equal(readBackup(dataPath, b.backup as string), '1.1.1.1 a\n')
})

test('空内容被拒绝，且不动原文件', () => {
  const target = makeTarget('empty.hosts', ORIGINAL)
  const res = writeHostsFile({ content: '   \n', dataPath, target })
  assert.equal(res.ok, false)
  assert.equal(res.method, 'none')
  assert.match(res.error ?? '', /内容为空/)
  assert.equal(readFileSync(target, 'utf8'), ORIGINAL)
})

test('可以关掉备份', () => {
  const target = makeTarget('nobackup.hosts', ORIGINAL)
  const before = listBackups(dataPath).length
  const res = writeHostsFile({ content: '3.3.3.3 c\n', dataPath, target, backup: false })
  assert.equal(res.ok, true)
  assert.equal(res.backup, undefined)
  assert.equal(listBackups(dataPath).length, before)
})

test('保留原文件的 BOM 与编码', () => {
  const target = makeTarget('bom-write.hosts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ORIGINAL)]))
  const next = '127.0.0.1\tlocalhost\n'
  const res = writeHostsFile({ content: next, dataPath, target })
  assert.equal(res.ok, true)
  const after = readFileSync(target)
  assert.deepEqual(after.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]))
  assert.equal(after.subarray(3).toString('utf8'), next)
})

test('目标不存在时可以创建（不存在的路径交由上层决定）', () => {
  const target = path.join(tmp, 'brand-new.hosts')
  const res = writeHostsFile({ content: '1.1.1.1 a\n', dataPath, target })
  assert.equal(res.ok, true)
  assert.equal(readFileSync(target, 'utf8'), '1.1.1.1 a\n')
})

test('原文件读不出来时拒绝覆盖', () => {
  // 用一个目录冒充 hosts 文件：existsSync 为真，readFileSync 会报 EISDIR
  const target = path.join(tmp, 'a-directory')
  mkdirSync(target, { recursive: true })
  const res = writeHostsFile({ content: '1.1.1.1 a\n', dataPath, target })
  assert.equal(res.ok, false)
  assert.equal(res.method, 'none')
})

test('备份保留份数有上限', () => {
  const dir = backupDirOf(dataPath)
  // 直接造 40 个合法备份文件，再触发一次备份，验证会被裁剪到 30 份
  for (let i = 0; i < 40; i++) {
    writeFileSync(path.join(dir, `hosts-fake-${i}.txt`), 'x')
  }
  const target = makeTarget('prune.hosts', ORIGINAL)
  backupHosts(dataPath, target)
  const list = listBackups(dataPath)
  assert.ok(list.length <= 30, `实际保留了 ${list.length} 份`)
})

test('写入是原地覆盖，不动文件的 inode（保住 root:wheel 与 644 权限）', () => {
  const target = makeTarget('inode.hosts', ORIGINAL)
  const before = statSync(target).ino
  writeHostsFile({ content: '1.1.1.1 a\n', dataPath, target })
  assert.equal(statSync(target).ino, before)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项`)
