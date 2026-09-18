/**
 * `clipboard.watch` 契约（plugin-spec §8.1）。
 *
 * 守的是一条**分层不变量**：剪贴板变化的**监听**在壳（常驻、不受插件进程回收影响），
 * 内容的**读取**在插件。内核只做中间那一跳 —— 收到通知 → 拉起订阅插件的 `record` 命令。
 *
 * 单看任一层源码都看不出问题，得站在壳那一侧观察：
 *   - 没人订阅时内核**不该**去打扰壳（否则每个用户都白开一个监听线程）；
 *   - 订阅者从 1 个变成 0 个时必须**关掉**；
 *   - 通知到达后必须真的把插件拉起来（这条最容易写漏：能力声明加了、通知 handler 没接）。
 *
 * 装置形态：假壳走真壳那条 stdio JSON-RPC；`record` 的产物用 SDK 的 echo 二进制 ——
 * 它不认识 `record` 这个命令名，会 `fail("未知命令：record")`，正好把「确实被拉起了一次」
 * 落在内核日志里可断言。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'
import { installEchoBinaries } from '../helpers/fixtures'

const h = await createHarness({ label: 'clip-watch', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function writePlugin(name: string, capabilities: string[]): Promise<string> {
  const dir = path.join(h.dataRoot, 'sources', name)
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'dist', 'package.json'),
    JSON.stringify(
      {
        name,
        title: `测试插件 ${name}`,
        version: '1.0.0',
        type: 'module',
        apiVersion: '2',
        capabilities,
        commands: [
          { name: 'panel', title: '面板', mode: 'view' },
          { name: 'record', title: '记录', mode: 'script' },
        ],
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>panel</title>')
  await installEchoBinaries(dir, ['record'])
  return dir
}

/** 最后一次 `clipboard.watch` 的参数（没有就 undefined） */
function lastWatch(): { enabled?: boolean } | undefined {
  const calls = shell!.calls.filter((call) => call.method === 'clipboard.watch')
  const last = calls[calls.length - 1]
  return last ? (last.params as { enabled?: boolean }) : undefined
}

test('没插件订阅时不向壳请求监听', async () => {
  const before = shell!.calls.filter((call) => call.method === 'clipboard.watch').length
  const source = await writePlugin('plain-clip', ['storage'])
  const installed = await h.pluginAction('installDir', { path: source, overwrite: true })
  assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)
  await sleep(200)
  assertEqual(
    shell!.calls.filter((call) => call.method === 'clipboard.watch').length,
    before,
    '没声明 clipboard.watch 的插件不该触发监听请求',
  )
})

test('有插件订阅 ⇒ 向壳开启监听（幂等：装第二个订阅者不再重复开）', async () => {
  shell!.calls.length = 0
  const source = await writePlugin('clip-watch-a', ['clipboard.watch'])
  const installed = await h.pluginAction('installDir', { path: source, overwrite: true })
  assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)
  await shell!.waitFor('clipboard.watch')
  assertEqual(lastWatch()?.enabled, true, '有订阅者就该开启')

  const second = await writePlugin('clip-watch-b', ['clipboard.watch'])
  await h.pluginAction('installDir', { path: second, overwrite: true })
  await sleep(250)
  assertEqual(
    shell!.calls.filter((call) => call.method === 'clipboard.watch').length,
    1,
    '已经是开启状态就不该再打扰壳',
  )
})

test('壳通报变化 ⇒ 拉起订阅插件的 record 命令', async () => {
  await h.waitFor(() => h.logs().includes('clip-watch-a') || true)
  shell!.notify('clipboard/changed', { changeCount: 42, kinds: ['text'] })
  // 跨进程：spawn + 协议往返 + 日志落 stderr，都要等
  await h.waitFor(() => h.logs().includes('剪贴板记录失败'), 3000, 'record 应被拉起（echo 二进制不认 record，必然失败）')
  assert(
    h.logs().includes('未知命令：record'),
    '失败原因应当来自插件产物本身（说明内核真的 spawn 了 record 而不是没接通知）',
  )
})

test('订阅者被禁用 ⇒ 还有别人订阅就继续开；全部停用 ⇒ 关闭监听', async () => {
  shell!.calls.length = 0
  await h.pluginAction('disable', { id: 'clip-watch-a' })
  await sleep(250)
  assertEqual(lastWatch(), undefined, '还有 clip-watch-b 在订阅，不该发请求')

  await h.pluginAction('disable', { id: 'clip-watch-b' })
  await sleep(250)
  assertEqual(lastWatch()?.enabled, false, '一个订阅者都不剩就该关掉监听')

  // 重新启用 ⇒ 再开一次
  await h.pluginAction('enable', { id: 'clip-watch-a' })
  await sleep(250)
  assertEqual(lastWatch()?.enabled, true)
})

test('声明了 clipboard.watch 却没有 record 命令 ⇒ 只记 warn、不影响插件', async () => {
  const dir = path.join(h.dataRoot, 'sources', 'clip-no-record')
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'dist', 'package.json'),
    JSON.stringify(
      {
        name: 'clip-no-record',
        title: '订阅但没有 record',
        version: '1.0.0',
        type: 'module',
        apiVersion: '2',
        capabilities: ['clipboard.watch'],
        commands: [{ name: 'panel', title: '面板', mode: 'view' }],
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>panel</title>')
  const installed = await h.pluginAction('installDir', { path: dir, overwrite: true })
  assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)

  const before = h.logs().length
  shell!.notify('clipboard/changed', { changeCount: 43, kinds: ['text'] })
  await sleep(400)
  assert(
    h.logs().slice(before).includes('没有 record 命令'),
    '缺少 record 命令应当只在日志里说一句，不能让插件挂掉',
  )
  assertEqual((await h.plugin('clip-no-record'))?.state, 'active')
})

const failed = await run('剪贴板监听契约')
await h.stop()
if (failed > 0) process.exit(1)
