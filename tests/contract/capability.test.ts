/**
 * 能力边界契约（P5 / plugin-spec §8）：
 * 未声明的 capability 在装配期就不挂载 —— 调用返回 CAPABILITY_DENIED，且审计有记录。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const h = await createHarness({ label: 'capability' })

async function writePlugin(name: string, capabilities: string[]): Promise<string> {
  const dir = path.join(h.dataRoot, 'sources', name)
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  // 源码工程形态：清单与产物都在 dist/（内核据此把 dist 当作插件根）
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
        commands: [{ name: 'ping', title: 'Ping', mode: 'view' }],
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>ping</title>')
  await fsp.writeFile(path.join(dir, 'dist', 'ping.mjs'), 'export const ok = true\n')
  return dir
}

test('无能力插件可以安装并加载（纯前端插件的底线）', async () => {
  const source = await writePlugin('no-cap', [])
  const record = await h.kernel.plugins.installFromDirectory(source, { overwrite: true })
  assertEqual(record.state, 'active')
  assertEqual(record.capabilities.size, 0)
})

test('调用未声明能力 → CAPABILITY_DENIED，且审计记录失败', async () => {
  const { sid, token } = await h.openSession('no-cap', 'ping')
  const storage = await h.bridge(sid, token, 'ctx.storage.set', { key: 'a', value: 1 })
  assertEqual(storage.ok, false, '未声明 storage 应当失败')
  assertEqual(storage.error?.code, 'CAPABILITY_DENIED')

  const clipboard = await h.bridge(sid, token, 'ctx.clipboard.writeText', { text: 'x' })
  assertEqual(clipboard.error?.code, 'CAPABILITY_DENIED')

  const shell = await h.bridge(sid, token, 'ctx.shell.openUrl', { url: 'https://example.com' })
  assertEqual(shell.error?.code, 'CAPABILITY_DENIED')

  const audit = h.kernel.audit.query({ pluginId: 'no-cap', limit: 50 })
  const denied = audit.filter((r) => !r.ok && r.error?.code === 'CAPABILITY_DENIED')
  assert(denied.length >= 3, `审计应记录每次越权调用，实际 ${denied.length} 条`)
  assert(denied.every((r) => r.capability !== ''), '审计应当带 capability 字段')
})

test('非 internal 插件调用管理面接口 → FORBIDDEN', async () => {
  const { sid, token } = await h.openSession('no-cap', 'ping')
  const result = await h.bridge(sid, token, 'ctx.settings.get')
  assertEqual(result.ok, false)
  assertEqual(result.error?.code, 'FORBIDDEN')
})

test('内置插件默认能力为空且不可被越权篡改', async () => {
  const caps = h.kernel.plugins.capabilitiesOf('no-cap')
  assertEqual(caps.size, 0)
  assertEqual(caps.has('storage'), false)
})

const failed = await run('能力边界契约')
await h.stop()
if (failed > 0) process.exit(1)
