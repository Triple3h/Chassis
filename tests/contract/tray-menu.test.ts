/** 托盘菜单（requirements §3.1）：菜单由内核提供、壳转发点击；settings / plugins 要真能打开页面。 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// internal-settings 的最小替身：view 命令 + 一张页面，让 openSession 走得通
const builtinRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-tray-menu-'))
const dir = path.join(builtinRoot, 'internal-settings', 'dist')
await fsp.mkdir(dir, { recursive: true })
await fsp.writeFile(
  path.join(dir, 'package.json'),
  JSON.stringify(
    {
      name: 'internal-settings',
      title: '设置与插件管理',
      version: '0.1.0',
      type: 'module',
      apiVersion: '1',
      essential: true,
      capabilities: ['hostUi'],
      commands: [
        { name: 'settings', title: '设置', mode: 'view', searchable: true },
        { name: 'manage', title: '插件管理', mode: 'view', searchable: true },
      ],
    },
    null,
    2,
  ),
)
await fsp.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>settings</title>')

// internal-store 的最小替身：更新页。命令声明 `hidden`（首页与搜索都不出现）——
// 托盘「检查更新…」正是它的固定入口，这条用例顺带证明 hidden 的 view 命令仍可 invoke。
const storeDir = path.join(builtinRoot, 'internal-store', 'dist')
await fsp.mkdir(storeDir, { recursive: true })
await fsp.writeFile(
  path.join(storeDir, 'package.json'),
  JSON.stringify(
    {
      name: 'internal-store',
      title: '底座更新',
      version: '0.1.0',
      type: 'module',
      apiVersion: '1',
      capabilities: ['hostUi'],
      commands: [{ name: 'updates', title: '更新', mode: 'view', searchable: true, hidden: true }],
    },
    null,
    2,
  ),
)
await fsp.writeFile(path.join(storeDir, 'index.html'), '<!doctype html><title>updates</title>')

const h = await createHarness({ label: 'tray-menu', fakeShell: true, builtinRoots: [builtinRoot] })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')
const sh = shell

interface OpenViewPayload {
  ok: boolean
  kind: string
  data?: { command?: string; pluginId?: string; sid?: string }
}

/** 模拟壳转发托盘点击，收齐内核的反应（壳请求 + SSE 事件） */
async function clickTray(id: string): Promise<{ sent: string[]; openView: OpenViewPayload[]; events: string[] }> {
  const openView: OpenViewPayload[] = []
  const events: string[] = []
  const sub = h.subscribe((event) => {
    events.push(event.event)
    if (event.event === 'ui/openView') openView.push(event.data as OpenViewPayload)
  })
  await sub.ready
  sh.sent.length = 0
  sh.notify('tray/menu', { id })
  await sleep(600)
  sub.stop()
  return { sent: sh.sent, openView, events }
}

test('tray/menu(settings)：先唤出窗口，再广播 ui/openView（载荷 = ActionResult，命令 = settings）', async () => {
  const { sent, openView } = await clickTray('settings')
  assert(sent.includes('window.show'), `应先唤出窗口（壳收到：${sent.join(', ') || '无'}）`)
  assertEqual(openView.length, 1, 'ui/openView 恰好一条')
  const result = openView[0]!
  assertEqual(result.ok, true, 'ActionResult.ok')
  assertEqual(result.kind, 'view', 'ActionResult.kind')
  assertEqual(result.data?.pluginId, 'internal-settings', '插件')
  assertEqual(result.data?.command, 'settings', '命令')
  assert(!!result.data?.sid, '带会话 sid（UI 要靠它开 iframe）')
})

test('tray/menu(plugins)：广播的是插件管理页（manage）', async () => {
  const { sent, openView } = await clickTray('plugins')
  assert(sent.includes('window.show'), '同样先唤出窗口')
  assertEqual(openView.length, 1, 'ui/openView 恰好一条')
  assertEqual(openView[0]!.data?.command, 'manage', '命令')
})

test('tray/menu(app-update)：常驻项，点击打开更新页（不直接执行更新）', async () => {
  const { sent, openView } = await clickTray('app-update')
  assert(sent.includes('window.show'), '先唤出窗口')
  assertEqual(openView.length, 1, 'ui/openView 恰好一条')
  const result = openView[0]!
  assertEqual(result.ok, true, 'ActionResult.ok')
  assertEqual(result.data?.pluginId, 'internal-store', '打开的是更新页那个插件')
  assertEqual(result.data?.command, 'updates', '打开的是更新页')
  assert(!!result.data?.sid, '带会话 sid（UI 要靠它开 iframe）')
  assert(!sent.includes('shell.applyUpdate'), `托盘只负责送到更新页，不该直接换包：${sent.join(', ')}`)
})

test('tray/menu(reload)：内核执行重载（plugin/reloaded 可见）且插件回到 active', async () => {
  const { events } = await clickTray('reload')
  assert(events.includes('plugin/reloaded'), `应发出 plugin/reloaded（实际：${events.join(', ') || '无'}）`)
  for (let i = 0; i < 100; i += 1) {
    if ((await h.plugin('internal-settings'))?.state === 'active') break
    await sleep(30)
  }
  assertEqual((await h.plugin('internal-settings'))?.state, 'active', '重载后回到 active')
})

test('tray/menu(show) 不经过内核处理路径也不会崩（壳本地处理，内核兜底同样唤出）', async () => {
  const { sent, openView } = await clickTray('show')
  assert(sent.includes('window.show'), '内核兜底路径同样唤出窗口')
  assertEqual(openView.length, 0, 'show 不应广播 openView')
})

await run()
await h.stop()
