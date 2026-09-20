import assert from 'node:assert/strict'
import { formatJson } from '../src/core/format'
import {
  buildTree,
  childrenOf,
  countKinds,
  jsonPath,
  matchNodes,
  nodeAtLine,
  nodeSource,
  pathOf,
  pathString,
  projectRows,
  KIND,
} from '../src/core/tree'
import { escapeUnicode, unescapeUnicode } from '../src/core/unicode'
import { indexLines, lineAt } from '../src/core/lineIndex'
import { highlightJsonLine } from '../src/core/highlight'

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

console.log('format')

test('缩进格式化', () => {
  const res = formatJson('{"a":1,"b":[1,2]}')
  assert.equal(res.ok, true)
  assert.equal(res.output, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
  assert.equal(res.stats.nodes, 5)
  assert.equal(res.stats.depth, 2)
})

test('Tab 缩进 / 4 空格', () => {
  assert.equal(formatJson('{"a":1}', { indent: 'tab' }).output, '{\n\t"a": 1\n}')
  assert.equal(formatJson('{"a":1}', { indent: 4 }).output, '{\n    "a": 1\n}')
})

test('压缩', () => {
  const res = formatJson('{\n  "a": 1,\n  "b": [1, 2]\n}', { minify: true })
  assert.equal(res.output, '{"a":1,"b":[1,2]}')
})

test('键排序', () => {
  const res = formatJson('{"b":2,"a":1,"c":{"z":0,"y":1}}', { sortKeys: true })
  assert.equal(res.output, '{\n  "a": 1,\n  "b": 2,\n  "c": {\n    "y": 1,\n    "z": 0\n  }\n}')
})

test('数字无损：大整数 / 超范围指数 / 尾随小数', () => {
  const src = '{"big":12345678901234567890,"inf":1e999,"neg":-0.30000000000000004,"zero":-0}'
  const out = formatJson(src, { minify: true }).output
  assert.equal(out, src)
  // 对比原生 JSON 的行为差异
  assert.notEqual(JSON.stringify(JSON.parse(src)), out)
})

test('字符串转义原样保留', () => {
  const src = '{"s":"a\\nb\\u00e9\\"c","emoji":"\\ud83d\\ude00"}'
  assert.equal(formatJson(src, { minify: true }).output, src)
})

test('UTF-8 字节数统计', () => {
  const res = formatJson('{"中文":"值"}', { minify: true })
  assert.equal(res.stats.outBytes, Buffer.byteLength('{"中文":"值"}'))
})

console.log('lenient 修复')

test('注释 / 尾逗号 / 单引号 / 裸键', () => {
  const src = `{
    // 行注释
    name: 'launcher',   /* 块注释 */
    tags: ["a", "b",],
    nested: { ok: true },
  }`
  const res = formatJson(src)
  assert.equal(res.ok, true)
  assert.equal(res.repaired, true)
  assert.equal(res.output, '{\n  "name": "launcher",\n  "tags": [\n    "a",\n    "b"\n  ],\n  "nested": {\n    "ok": true\n  }\n}')
  assert.equal(JSON.parse(res.output).name, 'launcher')
})

test('严格模式下同样内容报错', () => {
  const res = formatJson('{a:1}', { lenient: false })
  assert.equal(res.ok, false)
  assert.match(res.issue?.message ?? '', /键必须是双引号字符串/)
})

test('宽松模式字符串里的换行与转义', () => {
  const res = formatJson("{s:'a\\'b\\\\c'}", { minify: true })
  assert.equal(res.output, '{"s":"a\'b\\\\c"}')
})

console.log('错误定位')

test('行列号定位', () => {
  const res = formatJson('{\n  "a": 1,\n  "b": ,\n}')
  assert.equal(res.ok, false)
  assert.equal(res.issue?.line, 3)
  assert.equal(res.issue?.column, 8)
  assert.match(res.issue?.snippet ?? '', /"b": ,/)
})

test('缺少逗号', () => {
  const res = formatJson('{"a":1 "b":2}', { lenient: false })
  assert.equal(res.ok, false)
  assert.match(res.issue?.message ?? '', /缺少逗号/)
})

test('未闭合字符串', () => {
  const res = formatJson('{"a": "abc}', { lenient: false })
  assert.equal(res.ok, false)
  assert.match(res.issue?.message ?? '', /没有闭合/)
})

test('数字格式错误', () => {
  assert.equal(formatJson('[01]', { lenient: false }).ok, false)
  assert.equal(formatJson('[1.]', { lenient: false }).ok, false)
  assert.equal(formatJson('[-]', { lenient: false }).ok, false)
})

test('嵌套过深会拦截', () => {
  const deep = '['.repeat(600) + ']'.repeat(600)
  const res = formatJson(deep)
  assert.equal(res.ok, false)
  assert.match(res.issue?.message ?? '', /嵌套层级/)
})

test('空输入', () => {
  assert.equal(formatJson('   ').ok, false)
})

console.log('tree')

test('树结构与行投影', () => {
  const tree = buildTree('{"a":1,"b":[10,20],"c":{"d":"x"}}')
  assert.equal(tree.nodeCount, 7)
  assert.equal(tree.kind[0], KIND.object)
  assert.equal(tree.key[1], 'a')
  assert.equal(tree.key[2], 'b')
  assert.deepEqual(childrenOf(tree, 2), [3, 4])
  assert.equal(tree.count[2], 2)
  assert.equal(tree.depth[6], 2)
  assert.equal(tree.maxDepth, 2)
  assert.deepEqual(pathOf(tree, 6), ['c', 'd'])

  // 未展开：只剩根
  const collapsed = Array.from(projectRows(tree, new Set(), null))
  assert.deepEqual(collapsed, [0])

  // 展开根：a、b、c 可见，b 与 c 仍未展开
  const one = Array.from(projectRows(tree, new Set([0]), null))
  assert.deepEqual(one, [0, 1, 2, 5])

  // 全部展开：先序
  const all = Array.from(projectRows(tree, new Set([0, 2, 5]), null))
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6])
})

test('过滤命中并保留祖先与后代', () => {
  const tree = buildTree('{"user":{"name":"ada","tags":["dev"]},"other":1}')
  const { visible } = matchNodes(tree, 'ada')
  // 命中路径上的容器要自动展开（UI 侧同样会把 visible 里的容器都视为已展开）
  const autoExpand = new Set<number>()
  for (const i of visible) if (tree.count[i] > 0) autoExpand.add(i)
  const rows = Array.from(projectRows(tree, autoExpand, visible))
  assert.deepEqual(rows, [0, 1, 2])
  assert.equal(tree.key[2], 'name')
})

test('宽松模式建树', () => {
  const tree = buildTree("{a:1, b:[2,3,],}")
  assert.equal(tree.nodeCount, 5)
  assert.equal(tree.key[3], '[0]')
  assert.equal(tree.value[3], '2')
})

test('树里保留数字原文', () => {
  const tree = buildTree('[12345678901234567890]')
  assert.equal(tree.value[1], '12345678901234567890')
})

console.log('highlight / lineIndex')

test('行索引与取行', () => {
  const idx = indexLines('aaa\nbb\n\nccc')
  assert.equal(idx.count, 4)
  assert.equal(lineAt('aaa\nbb\n\nccc', idx, 0), 'aaa')
  assert.equal(lineAt('aaa\nbb\n\nccc', idx, 2), '')
  assert.equal(lineAt('aaa\nbb\n\nccc', idx, 3), 'ccc')
  assert.equal(idx.maxLen, 3)
})

test('高亮转义与着色', () => {
  const html = highlightJsonLine('  "a": "<img>", 1')
  assert.ok(html.includes('&lt;img&gt;'))
  assert.ok(!html.includes('<img>'))
  assert.ok(html.includes('launcher-hl-key'))
  assert.ok(html.includes('launcher-hl-num'))
})

console.log('树定位 / 路径')

test('节点带源码行号与偏移', () => {
  const src = '{\n  "a": 1,\n  "b": {\n    "c": "x"\n  }\n}'
  const tree = buildTree(src)
  // 0 根、1 a、2 b、3 c
  assert.equal(tree.line[0], 1)
  assert.equal(tree.line[1], 2)
  assert.equal(tree.line[2], 3)
  assert.equal(tree.line[3], 4)
  assert.equal(src.slice(tree.start[1], tree.end[1]), '1')
  assert.equal(src.slice(tree.start[3], tree.end[3]), '"x"')
  assert.equal(src.slice(tree.start[2], tree.end[2]), '{\n    "c": "x"\n  }')
})

test('行号在多行数组里递增', () => {
  const src = '[\n  1,\n  2,\n  [\n    3\n  ]\n]'
  const tree = buildTree(src)
  assert.deepEqual(Array.from(tree.line), [1, 2, 3, 4, 5])
})

test('路径拼接：点号 / 下标 / 特殊键', () => {
  const tree = buildTree('{"user":{"tags":["dev"],"content-type":"x"}}')
  assert.equal(pathString(tree, 3), 'user.tags[0]')
  assert.equal(jsonPath(tree, 3), '$.user.tags[0]')
  assert.equal(jsonPath(tree, 4), '$.user["content-type"]')
  assert.equal(jsonPath(tree, 0), '$')
  assert.deepEqual(pathOf(tree, 3), ['user', 'tags', '[0]'])
})

test('源码行 → 节点（文本视图反向定位）', () => {
  const tree = buildTree('{\n  "a": 1,\n  "b": [\n    10,\n    20\n  ]\n}')
  assert.equal(nodeAtLine(tree, 2), 1)
  assert.equal(nodeAtLine(tree, 4), 3)
  assert.equal(nodeAtLine(tree, 5), 4)
  // 闭合括号行没有对应节点，退回最后一个节点
  assert.equal(nodeAtLine(tree, 7), 4)
})

test('取节点的原文片段（含键）', () => {
  const src = '{\n  "a": [1, 2]\n}'
  const tree = buildTree(src)
  assert.equal(nodeSource(tree, src, 1), '[1, 2]')
  assert.equal(nodeSource(tree, src, 1, true), '"a": [1, 2]')
  // 数组元素不带键
  assert.equal(nodeSource(tree, src, 2, true), '1')
})

test('树的类型统计', () => {
  const tree = buildTree('{"a":1,"b":[true,null,"s"]}')
  assert.deepEqual(countKinds(tree), { object: 1, array: 1, string: 1, number: 1, boolean: 1, null: 1 })
})

console.log('类型分布（格式化路径）')

test('stats.kinds 与树统计一致', () => {
  const res = formatJson('{"a":1,"b":[true,null,"s"]}')
  assert.deepEqual(res.stats.kinds, { object: 1, array: 1, string: 1, number: 1, boolean: 1, null: 1 })
  assert.deepEqual(res.stats.kinds, countKinds(buildTree(res.output)))
})

test('失败时 stats.kinds 归零', () => {
  const res = formatJson('{"a":}')
  assert.deepEqual(res.stats.kinds, { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 })
})

console.log('unicode 转义 / 还原')

test('转义非 ASCII（含代理对）', () => {
  const r = escapeUnicode('{"n":"中","e":"😀"}')
  assert.equal(r.text, '{"n":"\\u4e2d","e":"\\ud83d\\ude00"}')
  assert.equal(r.changed, 3)
})

test('转义跳过已有的转义序列', () => {
  const r = escapeUnicode('{"a":"\\\\u4e2d","b":"中"}')
  assert.equal(r.text, '{"a":"\\\\u4e2d","b":"\\u4e2d"}')
  assert.equal(r.changed, 1)
})

test('还原 \\uXXXX（连写的代理对会合成 emoji）', () => {
  const r = unescapeUnicode('{"n":"\\u4e2d","e":"\\ud83d\\ude00"}')
  assert.equal(r.text, '{"n":"中","e":"😀"}')
  assert.equal(r.changed, 3)
})

test('还原不动会破坏结构的转义（引号 / 反斜杠 / 控制字符）', () => {
  const r = unescapeUnicode('{"q":"\\u0022","b":"\\\\u0041","c":"\\u0001"}')
  assert.equal(r.text, '{"q":"\\u0022","b":"\\\\u0041","c":"\\u0001"}')
  assert.equal(r.changed, 0)
})

test('转义与还原互为逆操作', () => {
  const src = '{"中文":"值 😀","emoji":"👍"}'
  const esc = escapeUnicode(src)
  assert.ok(esc.changed > 0)
  assert.equal(unescapeUnicode(esc.text).text, src)
})

console.log('性能')

test('8MB JSON 格式化 < 3s', () => {
  const items: string[] = []
  for (let i = 0; i < 110_000; i++) {
    items.push(`{"id":${i},"name":"用户${i}","score":${(i * 1.5).toFixed(2)},"tags":["a","b"],"ok":true}`)
  }
  const big = `[${items.join(',')}]`
  assert.ok(big.length > 7_000_000, `输入 ${big.length} 字符`)
  const t0 = performance.now()
  const res = formatJson(big)
  const dt = performance.now() - t0
  assert.equal(res.ok, true)
  assert.ok(res.stats.nodes > 480_000)
  console.log(`    输入 ${(big.length / 1048576).toFixed(1)}MB → 输出 ${(res.stats.outBytes / 1048576).toFixed(1)}MB，耗时 ${dt.toFixed(0)}ms`)
  assert.ok(dt < 3000, `耗时 ${dt.toFixed(0)}ms`)
})

test('紧凑输入压缩 < 800ms', () => {
  const big = `[${Array.from({ length: 60_000 }, (_, i) => `{"i":${i}}`).join(',')}]`
  const t0 = performance.now()
  const res = formatJson(big, { minify: true })
  const dt = performance.now() - t0
  assert.equal(res.ok, true)
  console.log(`    压缩 ${(big.length / 1048576).toFixed(1)}MB，耗时 ${dt.toFixed(0)}ms`)
  assert.ok(dt < 800, `耗时 ${dt.toFixed(0)}ms`)
})

test('20 万节点建树 < 1.5s', () => {
  const big = `[${Array.from({ length: 40_000 }, (_, i) => `{"i":${i},"n":"x${i}"}`).join(',')}]`
  const t0 = performance.now()
  const tree = buildTree(big)
  const dt = performance.now() - t0
  console.log(`    ${tree.nodeCount} 节点，耗时 ${dt.toFixed(0)}ms`)
  assert.ok(dt < 1500, `耗时 ${dt.toFixed(0)}ms`)
})

console.log(`\n通过 ${passed} 项`)
