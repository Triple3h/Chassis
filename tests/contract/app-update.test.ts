/**
 * 应用（壳）自更新 · 对外契约：
 *  1. `pluginAction('shellInfo')` → 内核问壳（`app.info`）拿「壳版本 / 安装位置 / 能否自更新」，
 *     转给更新页 —— 壳是唯一知道自己版本的角色，内核不能拿自己的版本凑数；
 *  2. `pluginAction('applyShellUpdate')` → 内核把候选 `.app` 交给壳（原语 `shell.applyUpdate`），
 *     并留下审计（这条动作会替换整个应用）；
 *  3. 参数校验在内核侧拦下（缺 appPath 不发到壳）。
 *
 * 真实的「替换 / 回滚」由壳的 helper 做（`apps/shell/src/update.rs` 单测覆盖 helper 语义、
 * `boot_guard` 与候选包自检）；这里只断言内核 → 壳这条链路。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const h = await createHarness({ label: 'app-update', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

test('shellInfo：问壳要版本与可更新性，转给 UI', async () => {
  // 注意：`plugins_action` 走 `ok_json(result)` —— 返回的是结果对象本身（不像壳回执那样自带 ok 字段）
  const res = await h.pluginAction('shellInfo', {})
  assertEqual(res.available, true, `壳已连接 ⇒ available：${JSON.stringify(res)}`)
  assertEqual(res.version, '0.1.0', '壳版本必须来自壳自报')
  assertEqual(res.hotVersion, '0.1.0', '壳自更新机制版本')
  assertEqual(res.canSelfUpdate, true, '打包态壳允许自更新')
  assert(shell.sent.includes('app.info'), `内核必须问壳要信息：${shell.sent.join(', ')}`)
})

test('applyShellUpdate：候选 .app 交给壳，并留审计', async () => {
  const res = await h.pluginAction('applyShellUpdate', { appPath: '/tmp/staged/Chassis.app' })
  assertEqual(res.ok, true, `交壳应成功：${JSON.stringify(res)}`)
  assertEqual(res.restarting, true, '壳会重启整个应用（回执之后）')

  await shell.waitFor('shell.applyUpdate', 3000)
  const call = [...shell.calls].reverse().find((item) => item.method === 'shell.applyUpdate')
  assert(!!call, '必须发到壳')
  assertEqual(call!.params.appPath, '/tmp/staged/Chassis.app', '参数 = 候选包路径')

  const records = await h.audit(80)
  const hit = records.find((item) => item.method === 'ctx.settings.applyShellUpdate')
  assert(!!hit, `审计里要有这条：${records.map((item) => item.method).join(', ')}`)
  assertEqual(hit!.pluginId, 'internal-store', '发起方是底座更新插件')
})

test('applyShellUpdate：缺 appPath ⇒ BAD_ARGS 且不打扰壳', async () => {
  const before = shell.sent.filter((item) => item === 'shell.applyUpdate').length
  const res = await h.pluginAction('applyShellUpdate', {})
  assertEqual(res.ok, false, '缺参数必须失败')
  assertEqual(res.error?.code, 'BAD_ARGS', `错误码：${JSON.stringify(res.error)}`)
  assertEqual(
    shell.sent.filter((item) => item === 'shell.applyUpdate').length,
    before,
    '校验失败不应发到壳',
  )
})

test('appUpdateStatus：没检查过就不提示、不忙碌（托盘与关于页都靠它）', async () => {
  const res = (await h.pluginAction('appUpdateStatus', {})) as { available?: boolean; busy?: boolean }
  assertEqual(res.available, false, `没有检查结果时不该提示更新：${JSON.stringify(res)}`)
  assertEqual(res.busy, false, '空闲状态')
})

test('checkAppUpdate：通道插件不可用 ⇒ 明确失败，不伪装成「已是最新」', async () => {
  const res = (await h.pluginAction('checkAppUpdate', {})) as { ok?: boolean; error?: { message?: string } }
  assertEqual(res.ok, false, `检查失败必须可见：${JSON.stringify(res)}`)
  assert(!!res.error?.message, `要有可读的错误信息：${JSON.stringify(res.error)}`)
  assert(shell.sent.includes('app.info'), '检查前应先问壳要版本 / 能否自更新')
})

test('applyAppUpdate：用户确认后才执行；失败复位 busy（托盘更新入口常驻，可再点）', async () => {
  shell.calls.length = 0
  const res = (await h.pluginAction('applyAppUpdate', {})) as { ok?: boolean; error?: { message?: string } }
  assertEqual(res.ok, false, `没有可用的下载通道时必须失败：${JSON.stringify(res)}`)

  const status = (await h.pluginAction('appUpdateStatus', {})) as { busy?: boolean }
  assertEqual(status.busy, false, '失败后必须复位：用户还能再试')

  // 执行开始与失败恢复都会重发托盘菜单 —— 更新入口是**常驻**第一项，失败后要回到「检查更新…」文案
  await shell.waitFor('tray.setMenu', 3000)
  const menus = shell.calls.filter((item) => item.method === 'tray.setMenu')
  const items = (menus[menus.length - 1]?.params.items ?? []) as Array<{ id?: string; label?: string; enabled?: boolean }>
  const entry = items.find((item) => item.id === 'app-update')
  assert(!!entry, `更新入口常驻，不该消失：${JSON.stringify(items)}`)
  assert(String(entry.label).includes('检查更新'), `失败后回到「检查更新…」：${JSON.stringify(entry)}`)
  assert(entry.enabled !== false, '失败后不留在禁用态（能再点）')
  assert(items.some((item) => item.id === 'quit'), `基础菜单项要还在：${JSON.stringify(items)}`)
})

const failed = await run('应用（壳）自更新')
await h.stop()
if (failed > 0) process.exit(1)
