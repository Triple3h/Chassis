/**
 * 底座基础能力（essential）不进审计：
 * 它们不可禁用、随底座一同发布，调用又密（设置页轮询、应用扫描、文件搜索），
 * 全记下来只会挤满环形缓冲与日志文件、把真正需要追溯的第三方插件记录淹掉。
 *
 * 判定只认出厂声明：第三方插件即便自称 essential 也照常记审计。
 *
 * 黑盒形态：插件信息读 `/api/plugins`，审计读 `/api/audit`（按 pluginId 客户端筛）。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

async function writePlugin(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  await fsp.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>demo</title>')
}

const base = {
  version: '1.0.0',
  type: 'module',
  apiVersion: '1',
  capabilities: ['storage'],
  commands: [{ name: 'main', title: '入口', mode: 'view' }],
}

const builtinRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-audit-essential-'))
await writePlugin(path.join(builtinRoot, 'core-thing', 'dist'), {
  ...base,
  name: 'core-thing',
  title: '基础示例',
  essential: true,
})

const h = await createHarness({
  label: 'audit-essential',
  builtinRoots: [builtinRoot],
  seed: async (dataRoot) => {
    await writePlugin(path.join(dataRoot, 'extensions', 'fake-core', 'dist'), {
      ...base,
      name: 'fake-core',
      title: '自称基础',
      essential: true,
    })
  },
})

test('基础能力插件：调用照常成功，但不落审计', async () => {
  assertEqual((await h.plugin('core-thing'))?.essential, true, '出厂声明应当被识别')
  const { sid, token } = await h.openSession('core-thing', 'main')
  const stored = await h.bridge(sid, token, 'ctx.storage.set', { key: 'k', value: 1 })
  assertEqual(stored.ok, true, `调用应当成功：${JSON.stringify(stored.error ?? {})}`)
  const rows = (await h.audit()).filter((row) => row.pluginId === 'core-thing')
  assertEqual(rows.length, 0, '基础能力的调用不该进审计')
})

test('第三方插件自称 essential 无效：照常记审计', async () => {
  assertEqual((await h.plugin('fake-core'))?.essential, false)
  const { sid, token } = await h.openSession('fake-core', 'main')
  const stored = await h.bridge(sid, token, 'ctx.storage.set', { key: 'k', value: 1 })
  assertEqual(stored.ok, true)
  const rows = (await h.audit()).filter((row) => row.pluginId === 'fake-core')
  assert(rows.length >= 1, '普通插件的调用必须有审计')
  assertEqual(rows[0]?.method, 'ctx.storage.set')
})

const failed = await run('基础能力不进审计')
await h.stop()
await fsp.rm(builtinRoot, { recursive: true, force: true })
if (failed > 0) process.exit(1)
