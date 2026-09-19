/**
 * 截图原语（architecture D18）：`ctx.screenshot.start` 由**壳**执行。
 *
 * 守护点：插件调用 → 内核只做能力校验与审计 → 转发给壳（假壳观察到 `screenshot.start`），
 * 返回值就是壳的 `{ ok }` —— 不再存在「内核自己 exec screencapture」这条路径（D18 的收敛）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const h = await createHarness({ fakeShell: true, label: 'screenshot' })

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
        apiVersion: '1',
        capabilities,
        commands: [{ name: 'panel', title: '面板', mode: 'view' }],
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>panel</title>')
  return dir
}

test('截图请求转发给壳原语，返回值 = 壳的结果', async () => {
  const source = await writePlugin('shot', ['screenshot'])
  const installed = await h.pluginAction('installDir', { path: source, overwrite: true })
  assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)

  const { sid, token } = await h.openSession('shot', 'panel')
  const result = await h.bridge(sid, token, 'ctx.screenshot.start')
  assertEqual(result.ok, true)
  assertEqual(result.result, true, '壳回 { ok:true } 时原语返回 true')

  await h.shell!.waitFor('screenshot.start')
  const calls = h.shell!.calls.filter((call) => call.method === 'screenshot.start')
  assertEqual(calls.length, 1, '截图只向壳请求一次')
})

test('截图调用进审计（capability = screenshot）', async () => {
  const rows = (await h.audit(50)).filter((row) => row.pluginId === 'shot')
  const shot = rows.find((row) => row.method === 'ctx.screenshot.start')
  assert(shot, `审计应记录截图调用：${JSON.stringify(rows)}`)
  assertEqual(shot?.ok, true)
  assertEqual(String(shot?.capability ?? ''), 'screenshot')
})

const failed = await run('截图原语（壳执行）')
await h.stop()
if (failed > 0) process.exit(1)
