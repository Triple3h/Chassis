import assert from 'node:assert/strict'
import { HIGHLIGHT_LIMIT, canHighlight, highlightCode, normalizeLang } from '../src/core/highlight'

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

console.log('语言归一化')

test('常见别名都能认', () => {
  assert.equal(normalizeLang('TS'), 'typescript')
  assert.equal(normalizeLang('jsx'), 'javascript')
  assert.equal(normalizeLang('yml'), 'yaml')
  assert.equal(normalizeLang('c++'), 'cpp')
  assert.equal(normalizeLang('bash'), 'shell')
  assert.equal(normalizeLang(' rs '), 'rust')
})

test('不认识的标记当纯文本', () => {
  assert.equal(normalizeLang('brainfuck'), 'text')
  assert.equal(normalizeLang(''), 'text')
  assert.equal(canHighlight('py'), true)
  assert.equal(canHighlight('nope'), false)
})

console.log('通用扫描')

test('关键字 / 字符串 / 注释 / 数字分色', () => {
  const html = highlightCode('const a = 1 // 注释', 'js')
  assert.ok(html.includes('md-hl-kw">const<'))
  assert.ok(html.includes('md-hl-num">1<'))
  assert.ok(html.includes('md-hl-com">// 注释<'))
})

test('字符串整体成段，内部符号不被当成注释', () => {
  const html = highlightCode('const s = "a /* b */ c"', 'js')
  assert.ok(html.includes('md-hl-str">&quot;a /* b */ c&quot;<'))
  assert.ok(!html.includes('md-hl-com'))
})

test('模板串可以跨行', () => {
  const html = highlightCode('const t = `line1\nline2`\nconst x = 1', 'js')
  assert.ok(html.includes('line2`</span>'))
  assert.equal(html.match(/md-hl-kw">const</g)?.length, 2)
})

test('块注释跨行吃掉中间的关键字', () => {
  const html = highlightCode('/* const\nconst */ const y', 'js')
  assert.equal(html.match(/md-hl-kw/g)?.length, 1)
})

test('函数名与类名分色', () => {
  const html = highlightCode('foo(1) new Date()', 'js')
  assert.ok(html.includes('md-hl-fn">foo<'))
  assert.ok(html.includes('md-hl-fn">Date<'))
})

test('HTML 里的 & 与 < 都被转义', () => {
  const html = highlightCode('<p>a & b</p>', 'markup')
  assert.ok(html.includes('a &amp; b'))
  assert.ok(!html.includes('<p>'))
})

test('JSON 键与值分色', () => {
  const html = highlightCode('{"name": "chassis", "n": 3}', 'json')
  assert.ok(html.includes('md-hl-key">&quot;name&quot;<'))
  assert.ok(html.includes('md-hl-str">&quot;chassis&quot;<'))
  assert.ok(html.includes('md-hl-num">3<'))
})

test('CSS 选择器与属性名分色', () => {
  const html = highlightCode('.btn { color: #fff; margin: 0 auto }', 'css')
  assert.ok(html.includes('md-hl-tag">btn<'))
  assert.ok(html.includes('md-hl-key">color<'))
  assert.ok(html.includes('md-hl-key">margin<'))
})

test('shell 注释与内建命令', () => {
  const html = highlightCode('# 构建\nnpm run build', 'bash')
  assert.ok(html.includes('md-hl-com"># 构建<'))
  assert.ok(html.includes('md-hl-kw">npm<'))
})

test('diff 增删行色带', () => {
  const html = highlightCode('@@ -1 +1 @@\n-old\n+new\n keep', 'diff')
  assert.ok(html.includes('md-hl-meta">@@ -1 +1 @@<'))
  assert.ok(html.includes('md-hl-del">-old<'))
  assert.ok(html.includes('md-hl-add">+new<'))
  assert.ok(html.includes('\n keep'))
})

test('SQL 关键字大小写不敏感', () => {
  const html = highlightCode('SELECT id FROM t WHERE a IS null', 'sql')
  assert.equal(html.match(/md-hl-kw/g)?.length, 5)
})

console.log('兜底')

test('未知语言只转义', () => {
  assert.equal(highlightCode('<b>hi</b>', 'brainfuck'), '&lt;b&gt;hi&lt;/b&gt;')
  assert.equal(highlightCode('<x>', undefined), '&lt;x&gt;')
})

test('超长代码只转义，不做着色', () => {
  const huge = 'const a = 1\n'.repeat(Math.ceil(HIGHLIGHT_LIMIT / 10))
  const html = highlightCode(huge, 'js')
  assert.ok(!html.includes('<span'))
  assert.ok(html.startsWith('const a = 1'))
})

console.log(`\n通过 ${passed} 项`)
