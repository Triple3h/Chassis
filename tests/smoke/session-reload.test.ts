/**
 * 插件热重载 × 插件页会话（requirements §7.4 停用/重载 + §8.5 会话契约）。
 *
 * 背景（用户实测 bug）：在插件管理页点「重载」（重载了它自己 / 全部重载）之后，
 * 页面里后续的桥调用全部报「会话或 token 不匹配」，插件列表也闪成空。
 * 根因：重载 = 停用 + 加载，停用会关掉该插件开着的 view 会话并停掉 listener（端口也换了），
 * 而当时的 UI 只把会话关闭当成一个无语义事件，插件页自己又拿着旧 sid 继续问。
 *
 * 这里锁住内核侧的契约：关闭必须带原因，重载结束必须广播重开信号。
 * 广播经 SSE 观察（插件页 SDK 拿到的就是这条）。
 */
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const h = await createHarness({ fixtures: ['echo-plugin'], label: 'session-reload' })

const closed: Array<Record<string, unknown>> = []
const reloaded: Array<Record<string, unknown>> = []
const sub = h.subscribe((event) => {
  if (event.event === 'session/closed') closed.push(event.data as Record<string, unknown>)
  if (event.event === 'plugin/reloaded') reloaded.push(event.data as Record<string, unknown>)
})
await sub.ready

test('重载插件：旧会话带 reason=reload 关闭，加载完成后广播 plugin/reloaded', async () => {
  const session = await h.openSession('echo-plugin', 'echo')

  const action = await h.pluginAction('reload', { id: 'echo-plugin' })
  assertEqual(action.ok, true, `重载应当成功：${JSON.stringify(action.error ?? {})}`)
  await h.waitFor(() => reloaded.some((item) => item.pluginId === 'echo-plugin'), 5000, 'plugin/reloaded 广播')

  const close = closed.find((item) => item.sid === session.sid)
  assert(close, `应当广播 session/closed：${JSON.stringify(closed)}`)
  assertEqual(close?.reason, 'reload')
  assertEqual(close?.pluginId, 'echo-plugin')
  assertEqual(close?.command, 'echo')

  const done = reloaded.find((item) => item.pluginId === 'echo-plugin')
  assert(done, `应当广播 plugin/reloaded：${JSON.stringify(reloaded)}`)
  assertEqual(done?.ok, true)
  assertDeepEqual(done?.commands, ['echo'], '要带回原来开着的 view 命令，UI 才能重开')

  // 旧 sid / 旧 token 已经失效 —— 这正是用户看到的那句报错
  const stale = await h.bridge(session.sid, session.token, 'ctx.host.info')
  assertEqual(stale.ok, false)
  assertEqual(stale.error?.code, 'SESSION_INVALID')

  // 重开一次：新会话指向新端口（插件页 listener 已重启）
  const again = await h.openSession('echo-plugin', 'echo')
  assert(again.sid !== session.sid, '重开应当是新会话')
  const info = await h.bridge(again.sid, again.token, 'ctx.host.info')
  assert(info.ok, `新会话的桥调用应当通过：${JSON.stringify(info.error)}`)
})

test('停用插件：会话带 reason=disable 关闭，且不广播重开信号', async () => {
  const session = await h.openSession('echo-plugin', 'echo')
  const before = reloaded.length

  await h.pluginAction('disable', { id: 'echo-plugin' })
  await h.waitFor(() => closed.some((item) => item.sid === session.sid), 5000, 'session/closed 广播')
  await sleep(150)

  assertEqual(closed.find((item) => item.sid === session.sid)?.reason, 'disable')
  assertEqual(reloaded.length, before, '停用不是重载，不该广播 plugin/reloaded')

  await h.pluginAction('enable', { id: 'echo-plugin' })
})

test('UI 主动关闭会话：reason=ui（不要被当成插件不可用）', async () => {
  const session = await h.openSession('echo-plugin', 'echo')
  await h.api('/api/session/close', { method: 'POST', body: JSON.stringify({ sid: session.sid }) })
  await h.waitFor(() => closed.some((item) => item.sid === session.sid), 5000, 'session/closed 广播')
  assertEqual(closed.find((item) => item.sid === session.sid)?.reason, 'ui')
})

test('卸载插件：会话带 reason=uninstall 关闭', async () => {
  const session = await h.openSession('echo-plugin', 'echo')
  const action = await h.pluginAction('uninstall', { id: 'echo-plugin' })
  assertEqual(action.ok, true, `卸载应当成功：${JSON.stringify(action.error ?? {})}`)
  await h.waitFor(() => closed.some((item) => item.sid === session.sid), 5000, 'session/closed 广播')
  assertEqual(closed.find((item) => item.sid === session.sid)?.reason, 'uninstall')
})

const failed = await run('插件热重载 × 会话')
sub.stop()
await h.stop()
if (failed > 0) process.exit(1)
