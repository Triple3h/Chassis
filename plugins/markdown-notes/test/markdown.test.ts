import assert from 'node:assert/strict'
import { escapeHtml, headings, renderInline, renderMarkdown, safeUrl } from '../src/core/markdown'

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

console.log('安全')

test('用户写的标签被转义，不会进到 HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script>')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('javascript: 链接被丢掉，只留文字', () => {
  assert.equal(safeUrl('javascript:alert(1)', true), null)
  const html = renderMarkdown('[点我](javascript:alert(1))')
  assert.ok(!html.includes('<a '))
  assert.ok(html.includes('点我'))
})

test('图片只放行 http(s) 与 data:image', () => {
  assert.equal(safeUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA')
  assert.equal(safeUrl('data:text/html,<b>x</b>'), null)
  assert.equal(safeUrl('https://example.com/a.png'), 'https://example.com/a.png')
})

test('escapeHtml 处理五个字符', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
})

console.log('块级元素')

test('标题 1~6 级', () => {
  assert.equal(renderMarkdown('# 标题'), '<h1>标题</h1>')
  assert.equal(renderMarkdown('### 小标题'), '<h3>小标题</h3>')
})

test('段落与软换行', () => {
  assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行<br />第二行</p>')
})

test('围栏代码块里的 Markdown 不被解析', () => {
  const html = renderMarkdown('```js\nconst a = "**not bold**"\n```')
  assert.ok(html.includes('md-pre'))
  assert.ok(html.includes('const a = &quot;**not bold**&quot;'))
  assert.ok(!html.includes('<strong>'))
})

test('引用块内部继续解析', () => {
  const html = renderMarkdown('> 引用里的 **重点**')
  assert.ok(html.startsWith('<blockquote>'))
  assert.ok(html.includes('<strong>重点</strong>'))
})

test('无序 / 有序 / 两级嵌套列表', () => {
  const ul = renderMarkdown('- 甲\n- 乙')
  assert.equal(ul, '<ul><li>甲</li><li>乙</li></ul>')
  const ol = renderMarkdown('1. 甲\n2. 乙')
  assert.equal(ol, '<ol><li>甲</li><li>乙</li></ol>')
  const nested = renderMarkdown('- 甲\n  - 甲一\n- 乙')
  assert.equal(nested, '<ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>')
})

test('任务列表渲染成勾选框', () => {
  const html = renderMarkdown('- [x] 已完成\n- [ ] 待办')
  assert.ok(html.includes('checked'))
  assert.ok(html.includes('待办'))
})

test('表格带表头与分隔行', () => {
  const html = renderMarkdown('| 项目 | 值 |\n| --- | --- |\n| 内存 | 13MB |')
  assert.ok(html.includes('<th>项目</th>'))
  assert.ok(html.includes('<td>13MB</td>'))
})

test('分割线', () => {
  assert.equal(renderMarkdown('---'), '<hr />')
})

console.log('行内元素')

test('粗体 / 斜体 / 删除线', () => {
  assert.equal(renderInline('**粗**'), '<strong>粗</strong>')
  assert.equal(renderInline('*斜*'), '<em>斜</em>')
  assert.equal(renderInline('~~删~~'), '<del>删</del>')
})

test('行内代码优先于强调', () => {
  assert.equal(renderInline('`**x**`'), '<code>**x**</code>')
})

test('链接与图片', () => {
  assert.equal(renderInline('[官网](https://example.com)'), '<a href="https://example.com" target="_blank" rel="noreferrer noopener">官网</a>')
  assert.equal(renderInline('![图](https://example.com/a.png)'), '<img src="https://example.com/a.png" alt="图" />')
})

test('下划线在单词内部不触发斜体', () => {
  assert.equal(renderInline('snake_case_name'), 'snake_case_name')
})

console.log('目录提取')

test('headings 跳过代码块里的井号', () => {
  const list = headings('# 一\n\n```\n# 不是标题\n```\n## 二')
  assert.deepEqual(list, [
    { level: 1, text: '一' },
    { level: 2, text: '二' },
  ])
})

console.log(`\n通过 ${passed} 项`)
