import assert from 'node:assert/strict'
import { formatJson } from '../src/core/format'
import {
  buildTree,
  childrenOf,
  closeRowNode,
  countKinds,
  indexInParent,
  jsonPath,
  lastChildOf,
  nodeAtLine,
  nodeSource,
  pathOf,
  pathString,
  projectRows,
  KIND,
} from '../src/core/tree'
import { addChild, canEditValue, encodeScalar, patchKey, patchValue, removeNode } from '../src/core/edit'
import { addEscape, removeEscape } from '../src/core/escape'
import { escapeUnicode, unescapeUnicode } from '../src/core/unicode'
import { indexLines, lineAt } from '../src/core/lineIndex'
import { highlightJsonLine } from '../src/core/highlight'
import { computeFolds, foldLayout } from '../src/core/fold'
import {
  dedentBlock,
  enterBlock,
  indentBlock,
  lineEndOffset,
  lineOfOffset,
} from '../src/core/editorOps'
import {
  addHistoryEntry,
  HISTORY_LIMIT,
  HISTORY_MAX_ENTRY_BYTES,
  previewOf,
  sanitizeHistory,
  type HistoryEntry,
} from '../src/core/history'

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

  // 未展开：只剩根（收尾行只在展开时才出现）
  const collapsed = Array.from(projectRows(tree, new Set()))
  assert.deepEqual(collapsed, [0])

  // 展开根：a、b、c 可见，b 与 c 仍未展开；根后面补一行收尾括号（-1 = 根）
  const one = Array.from(projectRows(tree, new Set([0])))
  assert.deepEqual(one, [0, 1, 2, 5, -1])

  // 全部展开：先序 + 每个展开容器各一行收尾括号
  const all = Array.from(projectRows(tree, new Set([0, 2, 5])))
  assert.deepEqual(all, [0, 1, 2, 3, 4, -3, 5, 6, -6, -1])
})

test('收尾行与下标工具', () => {
  // 0 根、1 数组 a、2 数组元素 10、3 空对象 b
  const tree = buildTree('{"a":[10],"b":{}}')
  const rows = Array.from(projectRows(tree, new Set([0, 1])))
  assert.deepEqual(rows, [0, 1, 2, -2, 3, -1])
  assert.equal(closeRowNode(-2), 1)
  assert.equal(closeRowNode(2), -1)
  assert.equal(indexInParent(tree, 2), 0)
  assert.equal(indexInParent(tree, 3), 1)
  assert.equal(indexInParent(tree, 0), -1)
  assert.equal(lastChildOf(tree, 1), 2)
  assert.equal(lastChildOf(tree, 3), -1)
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

console.log('树上编辑（文档补丁）')

test('改值：字符串 / 数字 / 布尔 / null', () => {
  const src = '{\n  "s": "a",\n  "n": 1,\n  "b": true,\n  "z": null\n}'
  const tree = buildTree(src)
  assert.equal(patchValue(src, tree, 1, 'x'), '{\n  "s": "x",\n  "n": 1,\n  "b": true,\n  "z": null\n}')
  assert.equal(patchValue(src, tree, 2, '2.5'), '{\n  "s": "a",\n  "n": 2.5,\n  "b": true,\n  "z": null\n}')
  assert.equal(patchValue(src, tree, 3, 'false'), '{\n  "s": "a",\n  "n": 1,\n  "b": false,\n  "z": null\n}')
  assert.equal(patchValue(src, tree, 4, 'null'), src)
})

test('改值：非法输入被拒绝（调用方保留原文）', () => {
  const src = '{"n":1,"b":true,"z":null,"s":"x"}'
  const tree = buildTree(src)
  assert.equal(patchValue(src, tree, 1, '1.2.3'), null)
  assert.equal(patchValue(src, tree, 1, '01'), null)
  assert.equal(patchValue(src, tree, 1, ''), null)
  assert.equal(patchValue(src, tree, 2, 'yes'), null)
  assert.equal(patchValue(src, tree, 3, 'nil'), null)
  // 容器不能当标量改
  assert.equal(patchValue(src, tree, 0, '1'), null)
  // 字符串永远合法：交给 JSON.stringify 转义
  assert.equal(patchValue(src, tree, 4, 'a"b\\c'), '{"n":1,"b":true,"z":null,"s":"a\\"b\\\\c"}')
})

test('标量编码 / 可编辑判定', () => {
  assert.equal(encodeScalar(KIND.number, ' -0.5e3 '), '-0.5e3')
  assert.equal(encodeScalar(KIND.number, '1.'), null)
  assert.equal(encodeScalar(KIND.boolean, ' true '), 'true')
  assert.equal(encodeScalar(KIND.null, 'null'), 'null')
  const tree = buildTree('{"s":"x","n":1}')
  assert.equal(canEditValue(tree, 1), true)
  assert.equal(canEditValue(tree, 2), true)
  assert.equal(canEditValue(tree, 0), false)
  // 超长字符串在树里被截断 ⇒ 不允许行内编辑（否则会把值写坏）
  const long = buildTree(JSON.stringify({ s: 'x'.repeat(400) }))
  assert.equal(canEditValue(long, 1), false)
})

test('改键：对象成员可以改，数组元素与根不行', () => {
  const src = '{\n  "a": 1,\n  "b": 2\n}'
  const tree = buildTree(src)
  assert.equal(patchKey(src, tree, 1, 'x'), '{\n  "x": 1,\n  "b": 2\n}')
  assert.equal(patchKey(src, tree, 2, ''), '{\n  "a": 1,\n  "": 2\n}')
  assert.equal(patchKey(src, tree, 1, '中 文'), '{\n  "中 文": 1,\n  "b": 2\n}')
  assert.equal(patchKey(src, tree, 0, 'x'), null)
  const arr = buildTree('{"a":[1]}')
  assert.equal(patchKey('{"a":[1]}', arr, 2, 'x'), null)
})

test('新增成员：多行 / 空容器 / 数组 / 压缩过的文档', () => {
  const src = '{\n  "a": 1\n}'
  assert.equal(addChild(src, buildTree(src), 0, { indent: '  ' }), '{\n  "a": 1,\n  "新属性": ""\n}')
  // 空对象：多行文档里铺开成一行（贴着它所在行的缩进）
  assert.equal(
    addChild('{\n  "a": {}\n}', buildTree('{\n  "a": {}\n}'), 1, { indent: '  ' }),
    '{\n  "a": {\n    "新属性": ""\n  }\n}',
  )
  const arr = '[\n  1\n]'
  assert.equal(addChild(arr, buildTree(arr), 0), '[\n  1,\n  null\n]')
  const deep = '{\n  "a": {\n    "b": 1\n  }\n}'
  assert.equal(
    addChild(deep, buildTree(deep), 1, { indent: '  ' }),
    '{\n  "a": {\n    "b": 1,\n    "新属性": ""\n  }\n}',
  )
  // 压缩过的文档：内联追加，不引入换行
  assert.equal(addChild('{}', buildTree('{}'), 0), '{"新属性":""}')
  assert.equal(addChild('{"a":1}', buildTree('{"a":1}'), 0), '{"a":1,"新属性":""}')
  assert.equal(addChild('[1]', buildTree('[1]'), 0), '[1,null]')
  // 标量节点加不了
  assert.equal(addChild(src, buildTree(src), 1), null)
})

test('删成员：开头 / 中间 / 末尾 / 唯一成员 / 数组', () => {
  const src = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}'
  const tree = buildTree(src)
  assert.equal(removeNode(src, tree, 1), '{\n  "b": 2,\n  "c": 3\n}')
  assert.equal(removeNode(src, tree, 2), '{\n  "a": 1,\n  "c": 3\n}')
  assert.equal(removeNode(src, tree, 3), '{\n  "a": 1,\n  "b": 2\n}')
  assert.equal(removeNode('{\n  "a": 1\n}', buildTree('{\n  "a": 1\n}'), 1), '{}')
  assert.equal(removeNode('[1, 2, 3]', buildTree('[1, 2, 3]'), 2), '[1, 3]')
  assert.equal(removeNode('{"a":1}', buildTree('{"a":1}'), 1), '{}')
  assert.equal(removeNode(src, tree, 0), null)
})

test('连改几次后文档仍合法，且格式化幂等', () => {
  let src = '{\n  "a": "x"\n}'
  src = addChild(src, buildTree(src), 0, { indent: '  ' }) as string
  src = patchValue(src, buildTree(src), 1, 'hello') as string
  src = patchKey(src, buildTree(src), 2, 'name') as string
  assert.deepEqual(JSON.parse(src), { a: 'hello', name: '' })
  const res = formatJson(src)
  assert.equal(res.ok, true)
  assert.equal(res.output, src)
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

console.log('整篇 \\ 转义')

test('添加 \\ 转义：引号 / 反斜杠 / 换行 / 制表符', () => {
  const raw = 'A"B\\C\nD\tE'
  const esc = addEscape(raw)
  assert.equal(esc.text, 'A\\"B\\\\C\\nD\\tE')
  assert.equal(esc.changed, 4)
  // 结果是合法的「字符串字面量内容」：包一层引号就能解析回原文
  assert.equal(JSON.parse(`"${esc.text}"`), raw)
})

test('去除 \\ 转义：与添加互为逆操作，认不出来的序列原样保留', () => {
  const raw = '{"p":"C:\\dir","m":"a\nb"}'
  assert.equal(removeEscape(addEscape(raw).text).text, raw)
  assert.equal(removeEscape('a\\qb').text, 'a\\qb')
  assert.equal(removeEscape('a\\qb').changed, 0)
  assert.equal(removeEscape('\\u4e2d').text, '中')
  assert.equal(removeEscape('\\n\\t\\"\\\\').text, '\n\t"\\')
  // 结尾孤零零的反斜杠不吞字符
  assert.equal(removeEscape('x\\').text, 'x\\')
})

test('中文转Unicode：只转汉字，emoji / 重音字母不动（与 bejson 同范围）', () => {
  const r = escapeUnicode('{"中":"文😀é"}', { only: 'cjk' })
  assert.equal(r.text, '{"\\u4e2d":"\\u6587😀é"}')
  assert.equal(r.changed, 2)
  // 边界：U+4E00–U+9FA5 内才转
  const probe = [0x4dff, 0x4e00, 0x9fa5, 0x9fa6, 0x9fff].map((c) => String.fromCharCode(c)).join('')
  const edge = escapeUnicode(`"${probe}"`, { only: 'cjk' })
  assert.equal(
    edge.text,
    `"${String.fromCharCode(0x4dff)}\\u4e00\\u9fa5${String.fromCharCode(0x9fa6, 0x9fff)}"`,
  )
  assert.equal(edge.changed, 2)
  // 默认仍是「所有非 ASCII（含 emoji）」的彻底版本
  assert.equal(escapeUnicode('{"中":"文😀"}').text, '{"\\u4e2d":"\\u6587\\ud83d\\ude00"}')
})

test('中文转Unicode 与 Unicode转中文 互逆', () => {
  const src = '{"中":"文😀"}'
  const esc = escapeUnicode(src, { only: 'cjk' })
  assert.equal(unescapeUnicode(esc.text).text, src)
})

console.log('折叠（编辑器）')

test('括号配对 → 记到起始行上', () => {
  const src = '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": 1\n  }\n}'
  const info = computeFolds(src)
  assert.deepEqual(Array.from(info.lines), [0, 1, 5])
  assert.equal(info.ends[0], 8)
  assert.equal(info.cols[0], 0)
  assert.equal(info.closers[0], 125)
  assert.equal(info.ends[1], 4)
  assert.equal(info.cols[1], 7)
  assert.equal(info.closers[1], 93)
  assert.equal(info.ends[5], 7)
  assert.equal(info.closers[5], 125)
})

test('字符串里的括号不参与配对；同行开闭不算折叠', () => {
  const src = '{\n  "a": "{[(", \n  "b": [\n    1\n  ]\n}'
  const info = computeFolds(src)
  assert.deepEqual(Array.from(info.lines), [0, 2])
  assert.equal(info.ends[1], -1)
  assert.equal(computeFolds('{"a":1}').lines.length, 0)
  assert.equal(computeFolds('').lines.length, 0)
})

test('foldLayout：折叠的行从可见行里消失', () => {
  const src = '{\n  "a": [\n    1,\n    2\n  ]\n}'
  const info = computeFolds(src)

  // 折根：只剩第 0 行
  const all = foldLayout(new Set([0]), info.ends, 6)
  assert.equal(all.count, 1)
  assert.equal(all.rowOf(0), 0)
  assert.equal(all.rowOf(3), -1)

  // 只折数组：0、1、5 可见
  const arr = foldLayout(new Set([1]), info.ends, 6)
  assert.equal(arr.count, 3)
  assert.deepEqual([0, 1, 2].map((r) => arr.lineOf(r)), [0, 1, 5])
  assert.equal(arr.rowOf(5), 2)
  assert.equal(arr.rowOf(2), -1)

  // 没有折叠 = 恒等映射
  const none = foldLayout(new Set(), info.ends, 6)
  assert.equal(none.count, 6)
  assert.equal(none.rowOf(4), 4)
  assert.equal(none.lineOf(4), 4)
})

console.log('编辑器块操作')

test('偏移 ↔ 行：二分定位与行尾', () => {
  const text = '{\n  "a": 1\n}'
  const idx = indexLines(text)
  assert.deepEqual(Array.from(idx.starts), [0, 2, 11])
  assert.equal(lineOfOffset(idx.starts, idx.count, 0), 0)
  assert.equal(lineOfOffset(idx.starts, idx.count, 1), 0)
  assert.equal(lineOfOffset(idx.starts, idx.count, 2), 1)
  assert.equal(lineOfOffset(idx.starts, idx.count, 10), 1)
  assert.equal(lineOfOffset(idx.starts, idx.count, 11), 2)
  assert.equal(lineEndOffset(text, idx.starts, idx.count, 1), 10)
  assert.equal(lineEndOffset(text, idx.starts, idx.count, 2), 12)
})

test('Tab：光标处插入缩进单位', () => {
  const text = '{\n  "a": 1\n}'
  const idx = indexLines(text)
  assert.deepEqual(indentBlock(text, idx.starts, idx.count, 0, 0, '  '), {
    from: 0,
    to: 0,
    text: '  ',
    selStart: 2,
    selEnd: 2,
  })
})

test('Tab：选区跨行时整行缩进，选区跟着右移', () => {
  const text = '{\n  "a": 1\n}'
  const idx = indexLines(text)
  const edit = indentBlock(text, idx.starts, idx.count, 3, 9, '  ')
  assert.equal(edit.from, 2)
  assert.equal(edit.to, 10)
  assert.equal(edit.text, '    "a": 1')
  assert.equal(edit.selStart, 5)
  assert.equal(edit.selEnd, 11)
  const out = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
  assert.equal(out, '{\n    "a": 1\n}')
})

test('Shift+Tab：每行吃掉一份缩进；吃不掉时不产生编辑', () => {
  const text = '{\n    "a": 1,\n  "b": 2\n}'
  const idx = indexLines(text)
  const from = idx.starts[1]
  const to = lineEndOffset(text, idx.starts, idx.count, 2)
  const edit = dedentBlock(text, idx.starts, idx.count, from, to, '  ')
  assert.ok(edit)
  assert.equal(edit.from, from)
  // 每行只吃掉**一份**缩进：四空格变两空格、两空格变没有
  assert.equal(edit.text, '  "a": 1,\n"b": 2')
  assert.equal(edit.selStart, from)
  assert.equal(edit.selEnd, from + edit.text.length)
  assert.equal(text.slice(0, edit.from) + edit.text + text.slice(edit.to), '{\n  "a": 1,\n"b": 2\n}')

  // 没缩进 / 单元是空格但行首是制表符（反过来也一样）
  assert.equal(dedentBlock('{"a":1}', indexLines('{"a":1}').starts, 1, 0, 0, '  '), null)
  const tabs = '{\n\t"a": 1\n}'
  const ti = indexLines(tabs)
  const te = dedentBlock(tabs, ti.starts, ti.count, ti.starts[1], ti.starts[1], '\t')
  assert.ok(te)
  assert.equal(te.text, '"a": 1')
})

test('Enter：沿用行首缩进，上一行停在 { / [ 后面时再进一级', () => {
  const arr = '{\n  "a": [\n'
  const ai = indexLines(arr)
  const e1 = enterBlock(arr, ai.starts, ai.count, 10, 10, '  ')
  assert.equal(e1.text, '\n    ')
  assert.equal(e1.selStart, 15)
  assert.equal(e1.selEnd, 15)

  const obj = '{\n  "a": 1\n}'
  const oi = indexLines(obj)
  assert.equal(enterBlock(obj, oi.starts, oi.count, 10, 10, '  ').text, '\n  ')
  // 光标停在缩进中间时只用光标前面那一段
  assert.equal(enterBlock(obj, oi.starts, oi.count, 3, 3, '  ').text, '\n ')
  // 有选区时 Enter 覆盖选区
  const e4 = enterBlock(obj, oi.starts, oi.count, 4, 7, '  ')
  assert.equal(e4.from, 4)
  assert.equal(e4.to, 7)
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

console.log('历史记录')

test('上限 20 条：超出的从最旧开始丢', () => {
  let list: HistoryEntry[] = []
  for (let i = 1; i <= 25; i++) {
    list = addHistoryEntry(list, { id: `e${i}`, owner: `t${i}`, at: i, text: `{"i":${i}}` })
  }
  assert.equal(list.length, HISTORY_LIMIT)
  assert.equal(list[0].text, '{"i":25}')
  assert.equal(list.at(-1)?.text, '{"i":6}')
})

test('同一标签页的内容变化是 upsert，不是新记录', () => {
  let list: HistoryEntry[] = []
  list = addHistoryEntry(list, { id: 'a', owner: 't1', at: 1, text: '{"a":1}' })
  list = addHistoryEntry(list, { id: 'b', owner: 't1', at: 2, text: '{"a":2}' })
  assert.equal(list.length, 1)
  assert.equal(list[0].text, '{"a":2}')
  // 内容没变 ⇒ 返回原数组（调用方可据此跳过落盘）
  assert.equal(addHistoryEntry(list, { id: 'c', owner: 't1', at: 3, text: '{"a":2}' }), list)
})

test('别处的同一份内容不会重复留两条', () => {
  let list: HistoryEntry[] = []
  list = addHistoryEntry(list, { id: 'a', owner: 't1', at: 1, text: '{"a":1}' })
  list = addHistoryEntry(list, { id: 'b', owner: 't2', at: 2, text: '{"a":1}' })
  assert.equal(list.length, 1)
  assert.equal(list[0].owner, 't2')
})

test('空白与超大内容不入库', () => {
  let list: HistoryEntry[] = addHistoryEntry([], { id: 'a', owner: 't1', at: 1, text: '   ' })
  assert.equal(list.length, 0)
  const huge = 'x'.repeat(HISTORY_MAX_ENTRY_BYTES + 1)
  assert.equal(addHistoryEntry([], { id: 'b', owner: 't2', at: 2, text: huge }).length, 0)
})

test('总量预算：从最旧一端淘汰到装得下', () => {
  const chunk = 'y'.repeat(300_000)
  let list: HistoryEntry[] = []
  for (let i = 1; i <= 5; i++) {
    list = addHistoryEntry(list, { id: `e${i}`, owner: `t${i}`, at: i, text: `${chunk}${i}` })
  }
  // 每条约 300KB，1MB 预算下只装得下 3 条
  assert.equal(list.length, 3)
  assert.equal(list[0].at, 5)
  assert.equal(list.at(-1)?.at, 3)
})

test('脏数据清洗：非数组 / 缺字段 / 超量', () => {
  assert.deepEqual(sanitizeHistory(null), [])
  assert.deepEqual(sanitizeHistory([{ text: '  ' }, 7, { text: '{"a":1}', at: '9' }]), [
    { id: '', owner: '', at: 9, text: '{"a":1}' },
  ])
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, owner: '', at: i, text: `{"i":${i}}` }))
  assert.equal(sanitizeHistory(many).length, HISTORY_LIMIT)
})

test('摘要压平空白并截断', () => {
  assert.equal(previewOf('{\n  "a": 1,\n  "b": 2\n}'), '{ "a": 1, "b": 2 }')
  assert.equal(previewOf('x'.repeat(200)).length, 91)
})

console.log(`\n通过 ${passed} 项`)
