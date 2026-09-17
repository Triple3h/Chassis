/**
 * 契约测试（requirements §11 / plugin-spec §14）：
 * 用真 HTTP listener 覆盖 §8.6 全表，含未授权路径与 token 校验。
 *
 * fixture 是 Rust 版本（v2）：逻辑层产物 = SDK 的 echo 示例二进制（`tests/helpers/fixtures.ts` 负责铺）。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'
import { materializeEchoPlugin } from '../helpers/fixtures'

await materializeEchoPlugin()
const h = await createHarness({ fixtures: ['echo-plugin'], label: 'contract' })

test('echo-plugin 加载成功且清单命令全部注册', async () => {
  const plugin = await h.plugin('echo-plugin')
  assert(plugin, '插件应当被发现')
  assertEqual(plugin?.state, 'active', JSON.stringify(plugin?.error ?? ''))
  const commands = ((plugin?.commands ?? []) as Array<{ name: string }>).map((item) => item.name).sort()
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

  const audit = (await h.audit(100)).filter((row) => row.pluginId === 'echo-plugin')
  assert(audit.some((row) => row.method === 'ctx.host.info' && row.ok), '成功调用应当有审计记录')
  assert(audit.some((row) => !row.ok), '失败调用应当有审计记录')
})

test('结果项契约：带 token 的注入被接受，非法形状被拒', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  const search = await h.api<{ token: number }>('/api/search', { method: 'POST', body: JSON.stringify({ query: 'contract' }) })

  const res = await h.bridge(sid, token, 'ctx.searchResult.set', {
    items: [{ id: 'x', title: '注入结果', action: { type: 'command', command: 'job' } }],
    token: search.token,
  })
  assert(res.ok, `set 失败：${JSON.stringify(res.error)}`)

  // 槽位本身只对内核可见（v1/v2 都是「落槽 + 参与下次 compose」）；这里守写入的校验面
  const bad = await h.bridge(sid, token, 'ctx.searchResult.set', { items: 'not-an-array', token: search.token })
  assertEqual(bad.ok, false, '非法 items 必须被拒')
  assertEqual(bad.error?.code, 'BAD_ARGS')
})

test('贡献型搜索：script 搜索源返回结果并被内核采纳', async () => {
  const response = await h.api<{ groups: { best: Array<{ item: { title: string } }> } }>('/api/search', {
    method: 'POST',
    body: JSON.stringify({ query: 'contract' }),
  })
  const titles = response.groups.best.map((entry) => entry.item.title)
  assert(titles.some((title) => title === 'echo: contract'), `未采纳 feed 结果：${titles.join(' | ')}`)
})

test('禁用插件：命令撤回（搜不到）、会话失效、启用后恢复', async () => {
  const searchable = async (): Promise<boolean> => {
    const res = await h.api<{ groups: { best: Array<{ pluginId: string }> } }>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: '契约自检' }),
    })
    return res.groups.best.some((entry) => entry.pluginId === 'echo-plugin')
  }

  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  assertEqual(await searchable(), true, '启用状态下命令应当能搜到')

  await h.pluginAction('disable', { id: 'echo-plugin' })
  assertEqual((await h.plugin('echo-plugin'))?.state, 'disabled')
  assertEqual(await searchable(), false, '命令应全部撤回（搜索结果里不再出现）')
  const stale = await h.bridge(sid, token, 'ctx.host.info')
  assertEqual(stale.ok, false, '会话应被关闭')
  assertEqual(stale.error?.code, 'SESSION_INVALID')

  await h.pluginAction('enable', { id: 'echo-plugin' })
  assertEqual((await h.plugin('echo-plugin'))?.state, 'active')
  assertEqual(await searchable(), true, '启用后命令应恢复')
})

const failed = await run('契约测试（echo-plugin）')
await h.stop()
if (failed > 0) process.exit(1)
