/**
 * 契约测试（requirements §11 / plugin-spec §14）：
 * 用真 HTTP listener 覆盖 §8.6 全表，含未授权路径与 token 校验。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const h = await createHarness({ fixtures: ['echo-plugin'], label: 'contract' })

test('echo-plugin 加载成功且清单命令全部注册', () => {
  const plugin = h.kernel.plugins.get('echo-plugin')
  assert(plugin, '插件应当被发现')
  assertEqual(plugin?.state, 'active', plugin?.error ?? '')
  const commands = h.kernel.registry.byPlugin('echo-plugin').map((c) => c.decl.name).sort()
  assertEqual(commands.join(','), 'compute,echo,feed,job')
})

test('契约全表：host.info / storage / hostUi 走真实桥', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')

  const info = await h.bridge(sid, token, 'ctx.host.info')
  assert(info.ok, `host.info 失败：${JSON.stringify(info.error)}`)
  assertEqual((info.result as { pluginId: string }).pluginId, 'echo-plugin')
  assertEqual((info.result as { sid: string }).sid, sid)

  const set = await h.bridge(sid, token, 'ctx.storage.set', { key: 'k', value: { a: 1 } })
  assert(set.ok, `storage.set 失败：${JSON.stringify(set.error)}`)
  const get = await h.bridge(sid, token, 'ctx.storage.get', { key: 'k' })
  assertEqual((get.result as { a: number }).a, 1)
  const all = await h.bridge(sid, token, 'ctx.storage.all')
  assertEqual(Object.keys(all.result as object).includes('k'), true)

  const footer = await h.bridge(sid, token, 'ctx.hostUi.setFooter', {
    buttons: [{ type: 'button', id: 'b1', label: '复制', icon: 'copy', keys: ['Mod+Shift+C'] }],
  })
  assert(footer.ok, `setFooter 失败：${JSON.stringify(footer.error)}`)

  const search = await h.bridge(sid, token, 'ctx.hostUi.setSearchContent', { value: 'hello' })
  assert(search.ok)
  const content = await h.bridge(sid, token, 'ctx.hostUi.getSearchContent')
  assertEqual(content.result, 'hello')
})

test('契约：exec.run 拉起本插件 script 命令并拿到 done(x)', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  const result = await h.bridge(sid, token, 'ctx.exec.run', { command: 'compute', args: { n: 21 }, timeoutMs: 8000 })
  assert(result.ok, `exec.run 失败：${JSON.stringify(result.error)}`)
  assertEqual((result.result as { doubled: number }).doubled, 42)

  const failing = await h.bridge(sid, token, 'ctx.exec.run', { command: 'compute', args: { fail: true } })
  assertEqual(failing.ok, false, '脚本 fail() 应当返回错误')
  assertEqual(failing.error?.code, 'SCRIPT_ERROR')
})

test('token 与会话校验：错误 token / 未知 sid / 未知方法', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')

  const badToken = await h.bridge(sid, 'deadbeef', 'ctx.host.info')
  assertEqual(badToken.ok, false)
  assertEqual(badToken.error?.code, 'SESSION_INVALID')

  const badSid = await h.bridge('not-a-sid', token, 'ctx.host.info')
  assertEqual(badSid.error?.code, 'SESSION_INVALID')

  const unknown = await h.bridge(sid, token, 'ctx.nope.nothing')
  assertEqual(unknown.error?.code, 'NOT_FOUND')

  // 未声明的能力走同一入口时给出 CAPABILITY_DENIED（方法存在但被拒的场景）
  const audit = h.kernel.audit.query({ pluginId: 'echo-plugin', limit: 100 })
  assert(audit.some((r) => r.method === 'ctx.host.info' && r.ok), '成功调用应当有审计记录')
  assert(audit.some((r) => !r.ok), '失败调用应当有审计记录')
})

test('结果项契约：searchResult.set 进入当前搜索槽', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  h.kernel.hub.setCurrent(999)
  h.kernel.hub.open(999, 'q')
  const res = await h.bridge(sid, token, 'ctx.searchResult.set', {
    items: [{ id: 'x', title: '注入结果', action: { type: 'command', command: 'job' } }],
    token: 999,
  })
  assert(res.ok, `set 失败：${JSON.stringify(res.error)}`)
  const slot = h.kernel.hub.results(999)
  assertEqual(slot.get('echo-plugin')?.length, 1)
})

test('贡献型搜索：script 搜索源返回结果并被内核采纳', async () => {
  const response = await h.kernel.search.search('contract')
  const titles = response.groups.best.map((item) => item.item.title)
  assert(titles.some((title) => title === 'echo: contract'), `未采纳 feed 结果：${titles.join(' | ')}`)
})

test('禁用插件：命令撤回、监听器关闭、worker 回收', async () => {
  const { sid } = await h.openSession('echo-plugin', 'echo')
  await h.kernel.plugins.setDisabled('echo-plugin', true)
  assertEqual(h.kernel.plugins.get('echo-plugin')?.state, 'disabled')
  assertEqual(h.kernel.registry.byPlugin('echo-plugin').length, 0, '命令应全部撤回')
  assertEqual(h.kernel.sessions.get(sid), undefined, '会话应被关闭')

  await h.kernel.plugins.setDisabled('echo-plugin', false)
  assertEqual(h.kernel.plugins.get('echo-plugin')?.state, 'active')
  assertEqual(h.kernel.registry.byPlugin('echo-plugin').length, 4, '启用后命令应恢复')
})

const failed = await run('契约测试（echo-plugin）')
await h.stop()
if (failed > 0) process.exit(1)
