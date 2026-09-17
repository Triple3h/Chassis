import manifest from '../package.json'
import { ENGINES, normalizeUserUrl, parseQuery, resolveEngine } from '../src/core/parse'
import { assert, assertEqual, run, test } from '../../../tests/helpers/assert'

test('网址输入优先：域名 / localhost / IP 直接补 https', () => {
  assertEqual(normalizeUserUrl('example.com'), 'https://example.com')
  assertEqual(normalizeUserUrl('localhost:5173/x'), 'https://localhost:5173/x')
  assertEqual(normalizeUserUrl('127.0.0.1:8080'), 'https://127.0.0.1:8080')
  assertEqual(normalizeUserUrl('https://a.example.com/b?c=1'), 'https://a.example.com/b?c=1')
  assertEqual(normalizeUserUrl('mailto:a@b.com'), 'mailto:a@b.com')
  assertEqual(normalizeUserUrl('hello world'), null)
})

test('关键词只给一条搜索项（默认引擎）', () => {
  const hits = parseQuery('dee', resolveEngine('google'))
  assertEqual(hits.length, 1, '搜索结果项数量')
  assertEqual(hits[0]?.kind, 'search')
  assertEqual(hits[0]?.engine, 'google')
  assertEqual(hits[0]?.url, 'https://www.google.com/search?q=dee')
  assertEqual(hits[0]?.label, '用 Google 搜索「dee」')
})

test('设置换了引擎：URL 模板与标题跟着换', () => {
  const hits = parseQuery('dee', resolveEngine('baidu'))
  assertEqual(hits.length, 1)
  assertEqual(hits[0]?.url, 'https://www.baidu.com/s?wd=dee')
  assertEqual(hits[0]?.label, '用 百度 搜索「dee」')
})

test('未知 / 缺失的引擎 id 回落第一个（配置写错也有搜索入口）', () => {
  assertEqual(resolveEngine('nope').id, ENGINES[0]?.id)
  assertEqual(resolveEngine(undefined).id, ENGINES[0]?.id)
  assertEqual(resolveEngine(42).id, ENGINES[0]?.id)
})

test('查询串被编码；空白输入不出结果', () => {
  const hits = parseQuery('c++ & rust', resolveEngine('bing'))
  assertEqual(hits[0]?.url, 'https://www.bing.com/search?q=c%2B%2B%20%26%20rust')
  assertEqual(parseQuery('   ', resolveEngine('google')).length, 0)
})

test('网址与关键词二者只出其一', () => {
  const hits = parseQuery('example.com', resolveEngine('google'))
  assertEqual(hits.length, 1)
  assertEqual(hits[0]?.kind, 'url')
  assertEqual(hits[0]?.url, 'https://example.com')
})

// 清单 settings 的 options 与 ENGINES 必须一一对应（两处各写一份，靠这条守住）
test('清单声明的引擎选项与 ENGINES 一致', () => {
  const engineSetting = manifest.settings.find((setting) => setting.key === 'engine')
  assert(engineSetting?.options, '清单必须声明 engine 设置项')
  assertEqual(
    (engineSetting.options ?? []).map((option) => option.value).join(','),
    ENGINES.map((engine) => engine.id).join(','),
  )
})

process.exitCode = await run('web-open parse')
