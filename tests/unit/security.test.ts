import path from 'node:path'
import { assert, assertEqual, assertRejects, run, test } from '../helpers/assert'
import { resolveWithinRoot } from '../../apps/kernel/src/util/fsx'
import { truncateForAudit } from '../../apps/kernel/src/util/text'
import { assertHttpUrl } from '../../apps/kernel/src/services/shell'
import { buildPinyin, matchTarget } from '../../apps/kernel/src/pinyin'
import { CSP } from '../../apps/kernel/src/http/pluginServers'

test('静态服务路径穿越防护', () => {
  const root = '/tmp/plugin-root'
  const cases = ['../etc/passwd', '../../secret', 'a/../../b', '%2e%2e/%2e%2e/etc', '/etc/passwd', 'a/../../../x']
  for (const raw of cases) {
    const resolved = resolveWithinRoot(root, raw.replace(/^\//, ''))
    if (resolved) {
      assert(
        resolved === root || resolved.startsWith(`${root}${path.sep}`),
        `越界：${raw} → ${resolved}`,
      )
    }
  }
  assertEqual(resolveWithinRoot(root, 'assets/app.js'), path.join(root, 'assets/app.js'))
  assertEqual(resolveWithinRoot(root, 'index.html'), path.join(root, 'index.html'))
})

test('静态服务：root 为相对路径时也应解析成功（否则表现为 403）', () => {
  const resolved = resolveWithinRoot('apps/launcher-ui/dist', 'index.html')
  assert(resolved !== null, '相对 root 不应被判为越界')
  assert(resolved.endsWith(`${path.sep}index.html`) || resolved.endsWith('/index.html'), `路径异常：${resolved}`)
  assertEqual(resolveWithinRoot('apps/launcher-ui/dist', '../secret'), null)
  assertEqual(resolveWithinRoot('apps/launcher-ui/dist', '../../etc/passwd'), null)
})

test('审计参数打码与截断', () => {
  const text = truncateForAudit({ token: 'abc123', password: 'p@ss', nested: { secret: 'x' }, keep: 'ok' })
  assert(!text.includes('abc123'), `token 未打码：${text}`)
  assert(!text.includes('p@ss'), `password 未打码：${text}`)
  assert(text.includes('***'), '应出现打码占位')
  assert(text.includes('ok'), '普通字段保留')

  const long = truncateForAudit({ text: 'x'.repeat(500) })
  assert(long.length <= 201, `应当截断到 200 字符，实际 ${long.length}`)
})

test('open.url 只接受 http/https/mailto', async () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:1/x', 'mailto:a@b.c']) {
    assertHttpUrl(url)
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) {
    await assertRejects(async () => {
      assertHttpUrl(url)
    }, 'BAD_ARGS', `应当拒绝：${url}`)
  }
})

test('拼音索引：全拼与首字母都能命中', () => {
  const forms = buildPinyin('应用启动器')
  assert(forms.full.includes('yingyong'), `全拼异常：${forms.full}`)
  assertEqual(forms.first, 'yyqdq')

  assertEqual(matchTarget('应', { title: '应用启动器' }).score, 1)
  assert(matchTarget('应用启动器', { title: '应用启动器' }).score >= 0.9, '精确命中应当最高')
  assert(matchTarget('yingyong', { title: '应用启动器' }).score >= 0.5, '全拼应当命中')
  assert(matchTarget('yyqdq', { title: '应用启动器' }).score >= 0.4, '首字母应当命中')
  assertEqual(matchTarget('zzzz', { title: '应用启动器' }).score, -1)
})

test('插件页 CSP：放行随包 wasm 的编译，但不放行 JS 的 eval', () => {
  const scriptSrc = CSP.split('; ').find((d) => d.startsWith('script-src'))
  assert(scriptSrc !== undefined, `CSP 缺少 script-src：${CSP}`)
  const tokens = scriptSrc.split(' ')
  assert(tokens.includes("'wasm-unsafe-eval'"), `插件页 wasm 未放行（totp 扫码会报 CompileError）：${scriptSrc}`)
  assert(!tokens.includes("'unsafe-eval'"), `不得放行 JS 的 eval：${scriptSrc}`)
  assert(CSP.includes("object-src 'none'"), `object-src 应保持关闭：${CSP}`)
})

const failed = await run('安全与匹配')
if (failed > 0) process.exit(1)
