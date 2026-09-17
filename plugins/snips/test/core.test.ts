import assert from 'node:assert/strict'
import {
  applyEdit,
  createSnip,
  defaultTitle,
  filterSnips,
  guessLang,
  looksLikeCode,
  relativeTime,
  sortSnips,
  summarize,
  touch,
} from '../src/core/snips'
import type { Snip } from '../src/core/types'

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

console.log('类型判定')

test('普通中文文本不算代码', () => {
  assert.equal(looksLikeCode('这是一段常用回复，随时复制粘贴给同事'), false)
})

test('JSON 片段算代码', () => {
  assert.equal(looksLikeCode('{\n  "name": "launcher",\n  "version": "0.1.0"\n}'), true)
})

test('带分号与缩进的 JS 片段算代码', () => {
  const code = 'const total = items.reduce((sum, item) => {\n  return sum + item.price;\n}, 0);'
  assert.equal(looksLikeCode(code), true)
})

test('短文本不会被当成代码', () => {
  assert.equal(looksLikeCode('好的;'), false)
})

test('语言猜测覆盖常见几类', () => {
  assert.equal(guessLang('{"a": 1}'), 'json')
  assert.equal(guessLang('SELECT * FROM users'), 'sql')
  assert.equal(guessLang('#!/bin/bash\nsudo apt update'), 'bash')
  assert.equal(guessLang('def hello():\n    print(1)'), 'python')
})

console.log('摘要与标题')

test('summarize 取首个非空行并压平空白', () => {
  assert.equal(summarize('\n\n  第一行   内容  \n第二行'), '第一行 内容')
})

test('summarize 超长截断', () => {
  const text = 'a'.repeat(120)
  const out = summarize(text, 20)
  assert.equal(out.length, 20)
  assert.ok(out.endsWith('…'))
})

test('标题为空时按类型兜底', () => {
  assert.equal(defaultTitle('   ', 'text'), '未命名快贴')
  assert.equal(defaultTitle('data:image/png;base64,xx', 'image'), '图片快贴')
  assert.equal(defaultTitle('复制粘贴的常用地址', 'text'), '复制粘贴的常用地址')
})

console.log('增删改')

test('createSnip 生成 id / 时间戳 / 默认字段', () => {
  const snip = createSnip({ kind: 'code', title: '', content: 'const a = 1', lang: 'javascript' }, 1000)
  assert.equal(snip.createdAt, 1000)
  assert.equal(snip.updatedAt, 1000)
  assert.equal(snip.uses, 0)
  assert.equal(snip.pinned, false)
  assert.equal(snip.lang, 'javascript')
  assert.ok(snip.id.startsWith('s'))
  assert.equal(snip.title, 'const a = 1')
})

test('applyEdit 改类型时同步摘掉语言标签', () => {
  const snip = createSnip({ kind: 'code', title: 'a', content: 'const a = 1', lang: 'javascript' }, 1000)
  const edited = applyEdit(snip, { kind: 'text', title: 'a', content: 'const a = 1' }, 2000)
  assert.equal(edited.lang, undefined)
  assert.equal(edited.updatedAt, 2000)
})

test('touch 只加使用次数，不动 updatedAt', () => {
  const snip = createSnip({ kind: 'text', title: 'a', content: 'b' }, 1000)
  const used = touch(snip, 5000)
  assert.equal(used.uses, 1)
  assert.equal(used.usedAt, 5000)
  assert.equal(used.updatedAt, 1000)
})

console.log('排序与过滤')

const pool: Snip[] = [
  { id: '1', kind: 'text', title: '地址', content: '北京市朝阳区', createdAt: 1, updatedAt: 100, usedAt: 0, uses: 0, pinned: false },
  { id: '2', kind: 'code', title: 'curl', content: 'curl -X POST', createdAt: 1, updatedAt: 300, usedAt: 0, uses: 0, pinned: false },
  { id: '3', kind: 'text', title: '邮箱', content: 'me@example.com', createdAt: 1, updatedAt: 200, usedAt: 0, uses: 0, pinned: true },
]

test('置顶优先，其余按最近改动', () => {
  assert.deepEqual(
    sortSnips(pool).map((item) => item.id),
    ['3', '2', '1'],
  )
})

test('按类型过滤', () => {
  assert.deepEqual(
    filterSnips(pool, '', 'code').map((item) => item.id),
    ['2'],
  )
})

test('搜索命中标题与正文（图片只匹配标题）', () => {
  assert.deepEqual(
    filterSnips(pool, 'example', 'all').map((item) => item.id),
    ['3'],
  )
  assert.deepEqual(filterSnips(pool, 'CURL', 'all').map((item) => item.id), ['2'])
})

console.log('相对时间')

test('分钟 / 今天 / 昨天 / 更早', () => {
  const now = new Date('2026-09-17T15:04:00').getTime()
  assert.equal(relativeTime(now - 30_000, now), '刚刚')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(relativeTime(new Date('2026-09-17T09:30:00').getTime(), now), '今天 09:30')
  assert.equal(relativeTime(new Date('2026-09-16T22:10:00').getTime(), now), '昨天 22:10')
  assert.equal(relativeTime(new Date('2026-09-01T09:00:00').getTime(), now), '09-01 09:00')
  assert.equal(relativeTime(new Date('2025-12-31T09:00:00').getTime(), now), '2025-12-31')
  assert.equal(relativeTime(0, now), '从未使用')
})

console.log(`\n通过 ${passed} 项`)
