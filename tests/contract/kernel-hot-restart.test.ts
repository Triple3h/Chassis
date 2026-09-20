/**
 * 内核热更新 · 优雅重启：`POST /api/hot/restart` 的对外契约。
 *
 * 单独成文件的原因：重启会让内核进程退出（壳的 `supervise` 在真实场景下把它拉起来），
 * 不能和其他热更新用例共用同一个装置。
 *
 * 断言两条对外可见的事实：壳收到 `kernel/restarting`（带 reason / version / hotVersion），
 * 以及内核日志里出现重启记录（排空 → 收尾 → 退出）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness, repoRoot } from '../helpers/harness'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** 内核版本读根 `version.json`（唯一维护点）—— 硬编码的话每次升级都假红一次 */
const KERNEL_VERSION = JSON.parse(await fsp.readFile(path.join(repoRoot, 'version.json'), 'utf-8')).kernel as string
const HOT_VERSION = '0.1.0'

const h = await createHarness({ label: 'kernel-hot-restart', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

test('hot/restart：壳收到 kernel/restarting，内核排空在途请求后退出', async () => {
  const res = await h.api<{ ok: boolean; restarting: boolean }>('/api/hot/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'contract-test' }),
  })
  assertEqual(res.ok, true, '重启请求被接受')
  assertEqual(res.restarting, true, '立即回应（排空与退出在后台）')

  await shell.waitFor('kernel/restarting', 3000)
  const call = shell.calls.find((item) => item.method === 'kernel/restarting')
  assert(!!call, '通知要带参数')
  assertEqual(call!.params.reason, 'contract-test', '重启原因')
  assertEqual(call!.params.version, KERNEL_VERSION, '内核版本')
  assertEqual(call!.params.hotVersion, HOT_VERSION, '热更新机制版本')
  assert(typeof call!.params.pid === 'number', '带 pid（壳排错用）')

  for (let i = 0; i < 100; i += 1) {
    if (h.logs().includes('内核热更新重启')) break
    await sleep(50)
  }
  assert(h.logs().includes('内核热更新重启'), `内核日志记录重启：${h.logs()}`, )
})

const failed = await run('内核热更新 · 优雅重启')
await h.stop()
if (failed > 0) process.exit(1)
