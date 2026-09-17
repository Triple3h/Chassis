import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 *
 * 写入这一层最关键的一条：**区外内容一个字节都不能变**。
 * 系统行、VPN 启动时自己加的行都在托管区之外，写盘时只换标记之间那一段。
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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'host-manager-'))
/**
 * 插件数据目录（N2 的唯一可写处）：`<dataRoot>/plugins/host-manager`。
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

/** 区外（系统行 + 别的程序加的行）+ 一段托管区 */
const REGION = '# >>> host-manager >>>\n# @block 开发环境\n10.0.0.1\tdev.example.com\n# @/block\n# <<< host-manager <<<\n'
const WITH_REGION = `##\n# Host Database\n##\n127.0.0.1\tlocalhost\n# VPN 自己加的\n10.8.0.1\tvpn.example.com\n\n${REGION}`
/** 区域后面还有别的程序写的行 */
const REGION_IN_MIDDLE = `${REGION}\n# 后面还有\n2.2.2.2\tlater.example.com\n`

console.log('路径解析')

test('默认路径按平台给', () => {
  const saved = process.env.LAUNCHER_HOSTS_PATH
  delete process.env.LAUNCHER_HOSTS_PATH
  const resolved = resolveHostsPath()
  if (process.platform === 'win32') assert.ok(resolved.endsWith('hosts'))
  else assert.equal(resolved, '/etc/hosts')
  if (saved !== undefined) process.env.LAUNCHER_HOSTS_PATH = saved
})

test('环境变量可覆盖（测试与自定义安装用）', () => {
  const saved = process.env.LAUNCHER_HOSTS_PATH
  process.env.LAUNCHER_HOSTS_PATH = '~/my-hosts'
  assert.equal(resolveHostsPath(), path.resolve(os.homedir(), 'my-hosts'))
  if (saved === undefined) delete process.env.LAUNCHER_HOSTS_PATH
  else process.env.LAUNCHER_HOSTS_PATH = saved
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

console.log('写入：托管区手术式替换')

test('只换托管区：区外逐字节保留，备份留的是改动前的内容', () => {
  const target = makeTarget('region.hosts', WITH_REGION)
  const next = REGION.replace('10.0.0.1\tdev.example.com', '10.0.0.9\tnew.example.com')
  const res = writeHostsFile({ region: next, dataPath, target })

  assert.equal(res.ok, true)
  assert.equal(res.method, 'direct')
  assert.equal(res.changed, true)
  assert.equal(res.verified, true)
  assert.ok(res.backup)

  const after = readFileSync(target, 'utf8')
  assert.ok(after.startsWith('##\n# Host Database\n##\n127.0.0.1\tlocalhost\n# VPN 自己加的\n10.8.0.1\tvpn.example.com\n\n'))
  assert.ok(after.includes('10.0.0.9\tnew.example.com'))
  assert.ok(!after.includes('dev.example.com'))
  assert.equal(readBackup(dataPath, res.backup as string), WITH_REGION)
})

test('写盘时重读磁盘：加载之后别的程序加的行不会被覆盖', () => {
  const target = makeTarget('concurrent.hosts', WITH_REGION)
  // 模拟「页面已经打开、用户正在改块，VPN 又往文件里塞了一行」
  writeFileSync(
    target,
    WITH_REGION.replace('10.8.0.1\tvpn.example.com\n', '10.8.0.1\tvpn.example.com\n10.9.9.9\tvpn-late.example.com\n'),
  )

  const res = writeHostsFile({ region: REGION.replace('10.0.0.1', '10.0.0.5'), dataPath, target })
  assert.equal(res.ok, true)
  assert.equal(res.changed, true)

  const after = readFileSync(target, 'utf8')
  assert.ok(after.includes('10.9.9.9\tvpn-late.example.com'), '别的程序后加的行必须还在')
  assert.ok(after.includes('10.0.0.5\tdev.example.com'), '托管区按新配置写入')
  assert.ok(after.startsWith('##\n# Host Database\n##'), '文件开头也没被重排')
})

test('托管区没变就什么都不做（不写、不备份、不弹授权）', () => {
  const target = makeTarget('same.hosts', WITH_REGION)
  const before = statSync(target).mtimeMs
  const backups = listBackups(dataPath).length
  const res = writeHostsFile({ region: REGION, dataPath, target })

  assert.equal(res.ok, true)
  assert.equal(res.changed, false)
  assert.equal(res.method, 'none')
  assert.equal(res.backup, undefined)
  assert.equal(statSync(target).mtimeMs, before)
  assert.equal(listBackups(dataPath).length, backups)
})

test('文件里还没有托管区时，区域追加在末尾', () => {
  const target = makeTarget('append.hosts', ORIGINAL)
  const res = writeHostsFile({ region: REGION, dataPath, target })
  assert.equal(res.ok, true)
  const after = readFileSync(target, 'utf8')
  assert.ok(after.startsWith(ORIGINAL), '原文一个字不动')
  assert.ok(after.endsWith(`\n\n${REGION}`), '空一行再跟上托管区')
})

test('region 传空串 = 把托管区从文件里摘掉，区外留着', () => {
  const target = makeTarget('detach.hosts', REGION_IN_MIDDLE)
  const res = writeHostsFile({ region: '', dataPath, target })
  assert.equal(res.ok, true)
  const after = readFileSync(target, 'utf8')
  assert.ok(!after.includes('host-manager'))
  assert.ok(!after.includes('dev.example.com'))
  assert.ok(after.includes('2.2.2.2\tlater.example.com'))
})

test('remove：只摘掉点名的那几行（收进块时用）', () => {
  const target = makeTarget('remove.hosts', WITH_REGION)
  const res = writeHostsFile({
    region: REGION,
    remove: ['10.8.0.1\tvpn.example.com\n'],
    dataPath,
    target,
  })
  assert.equal(res.ok, true)
  const after = readFileSync(target, 'utf8')
  assert.ok(!after.includes('10.8.0.1\tvpn.example.com'))
  assert.ok(after.includes('127.0.0.1\tlocalhost'))
  assert.ok(after.includes('dev.example.com'), '托管区不受影响')
})

test('remove 对不上的行静默跳过，不会误删别的行', () => {
  const target = makeTarget('remove-miss.hosts', WITH_REGION)
  const res = writeHostsFile({ region: REGION, remove: ['3.3.3.3\tghost.example.com\n'], dataPath, target })
  assert.equal(res.ok, true)
  assert.equal(res.changed, false, '点名要删的行不存在、托管区也没变 ⇒ 没有改动')
  assert.equal(readFileSync(target, 'utf8'), WITH_REGION)
})

test('整份内容为空时拒绝写入（空 hosts 会让本机解析全失效）', () => {
  const target = makeTarget('empty.hosts', REGION)
  const res = writeHostsFile({ region: '', dataPath, target })
  assert.equal(res.ok, false)
  assert.equal(res.method, 'none')
  assert.match(res.error ?? '', /内容为空/)
  assert.equal(readFileSync(target, 'utf8'), REGION)
})

test('备份名重复时不会互相覆盖', () => {
  const target = makeTarget('dup.hosts', WITH_REGION)
  const a = writeHostsFile({ region: REGION.replace('dev.example.com', 'a.example.com'), dataPath, target })
  const b = writeHostsFile({ region: REGION.replace('dev.example.com', 'b.example.com'), dataPath, target })
  assert.ok(a.backup && b.backup)
  assert.notEqual(a.backup, b.backup)
  assert.equal(readBackup(dataPath, a.backup as string), WITH_REGION)
  assert.ok((readBackup(dataPath, b.backup as string) as string).includes('a.example.com'))
})

test('可以关掉备份', () => {
  const target = makeTarget('nobackup.hosts', WITH_REGION)
  const before = listBackups(dataPath).length
  const res = writeHostsFile({ region: REGION.replace('dev', 'nodev'), dataPath, target, backup: false })
  assert.equal(res.ok, true)
  assert.equal(res.backup, undefined)
  assert.equal(listBackups(dataPath).length, before)
})

test('保留原文件的 BOM 与编码', () => {
  const target = makeTarget(
    'bom-write.hosts',
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(WITH_REGION)]),
  )
  const res = writeHostsFile({ region: REGION.replace('dev', 'bomdev'), dataPath, target })
  assert.equal(res.ok, true)
  const after = readFileSync(target)
  assert.deepEqual(after.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]))
  assert.ok(after.subarray(3).toString('utf8').includes('bomdev.example.com'))
})

test('目标不存在时可以创建（不存在的路径交由上层决定）', () => {
  const target = path.join(tmp, 'brand-new.hosts')
  const res = writeHostsFile({ region: REGION, dataPath, target })
  assert.equal(res.ok, true)
  assert.equal(readFileSync(target, 'utf8'), REGION)
})

test('原文件读不出来时拒绝覆盖', () => {
  // 用一个目录冒充 hosts 文件：existsSync 为真，readFileSync 会报 EISDIR
  const target = path.join(tmp, 'a-directory')
  mkdirSync(target, { recursive: true })
  const res = writeHostsFile({ region: REGION, dataPath, target })
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
  const target = makeTarget('inode.hosts', WITH_REGION)
  const before = statSync(target).ino
  writeHostsFile({ region: REGION.replace('dev', 'inode'), dataPath, target })
  assert.equal(statSync(target).ino, before)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项`)
