import assert from 'node:assert/strict'
import {
  appendEntries,
  diffLines,
  findConflicts,
  findEntry,
  ipWarning,
  isDirty,
  isProtectedEntry,
  isValidHostname,
  looksLikeIp,
  parseHosts,
  parseImportText,
  removeEntry,
  replaceAll,
  restoreLine,
  serializeHosts,
  splitLines,
  statsOf,
  updateEntry,
  type EntryLine,
} from '../src/core/hosts'

/**
 * hosts 解析 / 序列化 / 编辑操作的测试。
 * 重中之重是「无损往返」：解析再序列化必须和原文逐字节一致，
 * 否则用户那些手写注释和空格对齐会被插件悄悄改掉。
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

/* ------------------------------------------------------------ 样本文件 */

const MAC_HOSTS = `##
# Host Database
#
# localhost is used to configure the loopback interface
# when the system is booting.  Do not change this entry.
##
127.0.0.1	localhost
255.255.255.255	broadcasthost
::1             localhost

# 开发环境
10.0.0.1  dev.example.com   # 主站
10.0.0.2\tapi.dev.example.com
# 10.0.0.3  old.example.com
`

const LINUX_HOSTS = `127.0.0.1	localhost
127.0.1.1	my-box

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
`

const WINDOWS_HOSTS = `# Copyright (c) 1993-2009 Microsoft Corp.\r
#\r
#      102.54.94.97     rhino.acme.com          # source server\r
#       38.25.63.10     x.acme.com              # x client host\r
\r
# localhost name resolution is handled within DNS itself.\r
#\t127.0.0.1       localhost\r
#\t::1             localhost\r
`

const ROUND_TRIP_SAMPLES: Array<[string, string]> = [
  ['macOS 默认', MAC_HOSTS],
  ['Linux 默认', LINUX_HOSTS],
  ['Windows 默认（CRLF）', WINDOWS_HOSTS],
  ['空文件', ''],
  ['只有换行', '\n'],
  ['无末尾换行', 'a.example.com'],
  ['末尾多空行', '1.1.1.1 a.com\n\n\n'],
  ['混合换行', '1.1.1.1 a.com\r\n2.2.2.2 b.com\n3.3.3.3 c.com'],
  ['只有注释', '# just a note\n# another\n'],
  ['制表符对齐', '1.1.1.1\t\t\tfoo.bar\t# tabbed\n'],
  ['认不出的行', 'this line is not a hosts entry\n1.1.1.1 ok.com\n'],
  ['通配与下划线', '1.1.1.1 *.example.com _dmarc.example.com\n'],
]

console.log('无损往返')

for (const [label, text] of ROUND_TRIP_SAMPLES) {
  test(`${label}：解析后序列化与原文逐字节一致`, () => {
    const doc = parseHosts(text)
    assert.equal(serializeHosts(doc), text)
  })
}

console.log('解析')

test('macOS 样本的条目识别', () => {
  const doc = parseHosts(MAC_HOSTS)
  const entries = doc.lines.filter((l): l is EntryLine => l.kind === 'entry')
  assert.equal(entries.length, 6)
  // 回环行
  assert.equal(entries[0].ip, '127.0.0.1')
  assert.deepEqual(entries[0].names, ['localhost'])
  assert.equal(entries[0].disabled, false)
  assert.ok(isProtectedEntry(entries[0]))
  // 分隔符沿用原文
  assert.equal(entries[0].sep, '\t')
  assert.equal(entries[2].sep, '             ')
  // 行尾注释
  const dev = entries[3]
  assert.equal(dev.ip, '10.0.0.1')
  assert.deepEqual(dev.names, ['dev.example.com'])
  assert.equal(dev.comment, '主站')
  assert.equal(dev.sep, '  ')
  // 被注释掉的行识别成「禁用条目」
  assert.equal(entries[5].ip, '10.0.0.3')
  assert.equal(entries[5].disabled, true)
})

test('普通注释不会被误认成条目', () => {
  const doc = parseHosts(MAC_HOSTS)
  const comments = doc.lines.filter((l) => l.kind === 'comment')
  // ## / # Host Database / # / # localhost is used … / # when the system is booting … / ## / # 开发环境
  assert.equal(comments.length, 7)
  assert.equal(doc.unparsed, 0)
})

test('主机名说明里的 IP 不会把整行变成条目', () => {
  const doc = parseHosts('# 把 1.2.3.4 指向内网\n')
  assert.equal(doc.lines[0].kind, 'comment')
})

test('认不出的行归为 raw 且计入 unparsed', () => {
  const doc = parseHosts('garbage line\n1.1.1.1 ok.com\n')
  assert.equal(doc.lines[0].kind, 'raw')
  assert.equal(doc.unparsed, 1)
})

test('CRLF 文件主换行符是 \\r\\n', () => {
  assert.equal(parseHosts(WINDOWS_HOSTS).eol, '\r\n')
  assert.equal(parseHosts(MAC_HOSTS).eol, '\n')
})

test('分隔符取出现最多的那种', () => {
  assert.equal(parseHosts(LINUX_HOSTS).sep, ' ')
  assert.equal(parseHosts(MAC_HOSTS).sep, '\t')
})

test('IP / 主机名判定', () => {
  assert.ok(looksLikeIp('127.0.0.1'))
  assert.ok(looksLikeIp('::1'))
  assert.ok(looksLikeIp('fe80::1%lo0'))
  assert.ok(!looksLikeIp('localhost'))
  assert.ok(!looksLikeIp('1.2.3'))
  assert.ok(isValidHostname('a-b.example.com'))
  assert.ok(isValidHostname('*.example.com'))
  assert.ok(!isValidHostname('a b'))
  assert.ok(!isValidHostname(''))
  assert.equal(ipWarning('999.1.1.1'), 'IPv4 每段应在 0-255')
  assert.equal(ipWarning('10.0.0.1'), null)
  assert.equal(ipWarning('nope'), '不像合法的 IP 地址')
})

test('splitLines 不产生虚假的末尾空行', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('a\n\n'), ['a', ''])
})

console.log('编辑')

test('切换启用状态：只改那一行，且格式合法', () => {
  const doc = parseHosts(MAC_HOSTS)
  const target = doc.lines.find((l): l is EntryLine => l.kind === 'entry' && l.ip === '10.0.0.3')
  assert.ok(target)
  updateEntry(doc, target.id, { disabled: false })
  const out = serializeHosts(doc)
  assert.ok(out.includes('\n10.0.0.3  old.example.com\n'))
  // 其它行纹丝不动
  assert.ok(out.includes('# localhost is used to configure the loopback interface\n'))
  assert.ok(out.includes('::1             localhost\n'))
})

test('禁用一条启用中的条目会给行首加 #', () => {
  const doc = parseHosts(LINUX_HOSTS)
  const entry = doc.lines.find((l): l is EntryLine => l.kind === 'entry' && l.ip === '127.0.1.1')
  assert.ok(entry)
  updateEntry(doc, entry.id, { disabled: true })
  assert.ok(serializeHosts(doc).includes('\n# 127.0.1.1\tmy-box\n'))
})

test('改 IP 保留原有分隔符与注释', () => {
  const doc = parseHosts(MAC_HOSTS)
  const entry = doc.lines.find((l): l is EntryLine => l.kind === 'entry' && l.ip === '10.0.0.1')
  assert.ok(entry)
  updateEntry(doc, entry.id, { ip: '10.9.9.9' })
  assert.ok(serializeHosts(doc).includes('10.9.9.9  dev.example.com  # 主站\n'))
})

test('新增条目追加到末尾并自动补空行', () => {
  const doc = parseHosts(MAC_HOSTS)
  appendEntries(doc, [{ ip: '1.2.3.4', names: ['new.example.com'], comment: '新增', disabled: false }])
  const out = serializeHosts(doc)
  assert.ok(out.endsWith('\n1.2.3.4\tnew.example.com\t# 新增\n'))
})

test('删除后可原位还原', () => {
  const doc = parseHosts(MAC_HOSTS)
  const id = doc.lines.filter((l): l is EntryLine => l.kind === 'entry')[1].id
  const removed = removeEntry(doc, id)
  assert.ok(removed)
  assert.ok(!serializeHosts(doc).includes('broadcasthost'))
  restoreLine(doc, removed)
  assert.equal(serializeHosts(doc), MAC_HOSTS)
})

test('未改动的条目 isDirty 为 false，改过就为 true', () => {
  const doc = parseHosts(MAC_HOSTS)
  const entry = doc.lines.find((l): l is EntryLine => l.kind === 'entry' && l.ip === '10.0.0.1')
  assert.ok(entry)
  assert.equal(isDirty(entry), false)
  updateEntry(doc, entry.id, { comment: '改了' })
  assert.equal(isDirty(entry), true)
})

test('统计口径', () => {
  const doc = parseHosts(MAC_HOSTS)
  const s = statsOf(doc)
  assert.equal(s.total, 6)
  assert.equal(s.enabled, 5)
  assert.equal(s.disabled, 1)
  assert.equal(s.dirty, 0)
  // 新增一条后 dirty / added 都 +1
  appendEntries(doc, [{ ip: '1.2.3.4', names: ['x.com'], comment: '', disabled: false }])
  const s2 = statsOf(doc)
  assert.equal(s2.total, 7)
  assert.equal(s2.dirty, 1)
  assert.equal(s2.added, 1)
})

test('整体替换会重新解析并保留新文本', () => {
  const doc = parseHosts(MAC_HOSTS)
  replaceAll(doc, '1.1.1.1 a.com\n')
  assert.equal(serializeHosts(doc), '1.1.1.1 a.com\n')
  assert.equal(statsOf(doc).total, 1)
})

test('findEntry 找得到、找不到返回 null', () => {
  const doc = parseHosts(MAC_HOSTS)
  const first = doc.lines[0]
  assert.ok(findEntry(doc, 'nope') === null)
  if (first.kind === 'entry') assert.ok(findEntry(doc, first.id))
})

console.log('冲突与保护')

test('同一域名指向不同 IP 会被标为冲突', () => {
  const doc = parseHosts('1.1.1.1 a.com\n2.2.2.2 a.com\n3.3.3.3 b.com\n')
  const conflicts = findConflicts(doc)
  assert.deepEqual([...conflicts.keys()], ['a.com'])
  assert.equal(conflicts.get('a.com')?.length, 2)
})

test('IPv4 / IPv6 双栈的 localhost 不算冲突', () => {
  const doc = parseHosts('127.0.0.1\tlocalhost\n::1\tlocalhost\n255.255.255.255\tbroadcasthost\n')
  assert.equal(findConflicts(doc).size, 0)
})

test('同一域名重复指向同一个 IP 不算冲突', () => {
  const doc = parseHosts('1.1.1.1 a.com\n1.1.1.1 a.com\n')
  assert.equal(findConflicts(doc).size, 0)
})

test('禁用的条目不参与冲突判定', () => {
  const doc = parseHosts('1.1.1.1 a.com\n# 2.2.2.2 a.com\n')
  assert.equal(findConflicts(doc).size, 0)
})

test('系统关键行被保护，普通回环条目不算', () => {
  const doc = parseHosts(LINUX_HOSTS)
  const entries = doc.lines.filter((l): l is EntryLine => l.kind === 'entry')
  assert.ok(isProtectedEntry(entries[0])) // 127.0.0.1 localhost
  assert.ok(isProtectedEntry(entries[2])) // ::1 ip6-localhost ip6-loopback
  assert.ok(!isProtectedEntry(entries[1])) // 127.0.1.1 my-box
})

console.log('粘贴导入')

test('批量文本解析：三种写法都能吃下', () => {
  const res = parseImportText(`
1.2.3.4  a.com b.com   # 两个域名
# 5.6.7.8  off.example.com
::1  v6.example.com

这不是一行 hosts
  `)
  assert.equal(res.entries.length, 3)
  assert.deepEqual(res.entries[0].names, ['a.com', 'b.com'])
  assert.equal(res.entries[0].comment, '两个域名')
  assert.equal(res.entries[1].disabled, true)
  assert.equal(res.entries[2].ip, '::1')
  assert.deepEqual(res.skipped, ['这不是一行 hosts'])
})

console.log('差分')

test('改一行 → 一增一删，顺序正确', () => {
  const { rows, added, removed } = diffLines('a\nb\nc\n', 'a\nx\nc\n')
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ['same:a', 'add:x', 'del:b', 'same:c'],
  )
  assert.equal(added, 1)
  assert.equal(removed, 1)
})

test('纯新增', () => {
  const { rows, added, removed } = diffLines('a\nc\n', 'a\nx\nc\n')
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['same', 'add', 'same'],
  )
  assert.equal(added, 1)
  assert.equal(removed, 0)
})

test('纯删除', () => {
  const { rows, added, removed } = diffLines('a\nb\nc\n', 'a\nc\n')
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['same', 'del', 'same'],
  )
  assert.equal(added, 0)
  assert.equal(removed, 1)
})

test('重复行按先到先得配对，不虚报', () => {
  const { added, removed } = diffLines('a\n\nb\n', 'a\nb\n')
  assert.equal(added, 0)
  assert.equal(removed, 1)
})

test('内容完全相同 → 全 same', () => {
  const { rows, added, removed } = diffLines(MAC_HOSTS, MAC_HOSTS)
  assert.equal(added, 0)
  assert.equal(removed, 0)
  assert.ok(rows.every((r) => r.kind === 'same'))
  assert.equal(rows.length, splitLines(MAC_HOSTS).length)
})

test('末尾新增一行能被识别', () => {
  const { added, rows } = diffLines('1.1.1.1 a.com\n', '1.1.1.1 a.com\n2.2.2.2 b.com\n')
  assert.equal(added, 1)
  assert.equal(rows[rows.length - 1].kind, 'add')
  assert.equal(rows[rows.length - 1].no, 2)
})

test('大文件差分保持线性（2 万行 < 300ms）', () => {
  const a = Array.from({ length: 20000 }, (_, i) => `10.0.${(i / 256) | 0}.${i % 256}\thost-${i}.example.com`).join('\n')
  const b = a.replace('host-100.example.com', 'host-100-changed.example.com') + '\n10.9.9.9\tbrand-new.example.com'
  const t0 = performance.now()
  const { added, removed } = diffLines(a, b)
  const dt = performance.now() - t0
  console.log(`    2 万行差分耗时 ${dt.toFixed(1)}ms`)
  // 改掉的那行算「一删一增」，再加上末尾追加的一行
  assert.equal(added, 2)
  assert.equal(removed, 1)
  assert.ok(dt < 300, `耗时 ${dt.toFixed(0)}ms`)
})

test('大文件解析 + 序列化保持线性（2 万行 < 500ms）', () => {
  const text = Array.from({ length: 20000 }, (_, i) => `10.0.${(i / 256) | 0}.${i % 256}\thost-${i}.example.com`).join('\n')
  const t0 = performance.now()
  const doc = parseHosts(text)
  const out = serializeHosts(doc)
  const dt = performance.now() - t0
  console.log(`    2 万行解析 + 序列化耗时 ${dt.toFixed(1)}ms`)
  assert.equal(out, text)
  assert.equal(statsOf(doc).total, 20000)
  assert.ok(dt < 500, `耗时 ${dt.toFixed(0)}ms`)
})

console.log(`\n通过 ${passed} 项`)
