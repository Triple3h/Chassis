/**
 * 插件更新契约（M7 / plugin-spec §6.4 / ADR-0006）：
 *
 * 黑盒形态（真内核二进制 + HTTP + SSE）：
 *   ① `installZip` + `overwrite` 覆盖**非 essential** 出厂插件 → 版本生效、`builtin` 仍为 true、广播 `plugin/reloaded`
 *   ② 覆盖 **essential** 出厂插件 → `ESSENTIAL_PROTECTED`，旧版本原地不动
 *   ③ 升级保留用户数据（别名覆盖不随安装目录一起被清）
 *   ④ `revertToBuiltin` → 回到 App 自带的那份
 *
 * 出厂插件由 `--builtin-plugins` 指向 fixture（`tests/fixtures/update-builtin`）；
 * 更新包是测试里现打的 zip（`tests/helpers/zip.ts`，不依赖系统的 `zip` 命令）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness, repoRoot } from '../helpers/harness'
import type { PluginInfo } from '../helpers/harness'
import { makeZip } from '../helpers/zip'

const builtinRoot = path.join(repoRoot, 'tests', 'fixtures', 'update-builtin')
const h = await createHarness({ label: 'plugin-update', builtinRoots: [builtinRoot] })

/** 打一个 `demo` 的更新包（zip 根 = 插件目录内容） */
async function packDemo(version: string): Promise<string> {
  const file = path.join(h.dataRoot, 'downloads', `demo-${version}.zip`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const manifest = JSON.stringify(
    {
      name: 'demo',
      title: '出厂示例',
      version,
      type: 'module',
      apiVersion: '2',
      capabilities: [],
      commands: [{ name: 'show', title: '示例页', mode: 'view', searchable: true }],
    },
    null,
    2,
  )
  const zip = makeZip([
    { name: 'package.json', data: manifest },
    { name: 'index.html', data: `<!doctype html><title>出厂示例 ${version}</title>` },
  ])
  await fsp.writeFile(file, zip)
  return file
}

async function packCore(version: string): Promise<string> {
  const file = path.join(h.dataRoot, 'downloads', `core-${version}.zip`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const zip = makeZip([
    {
      name: 'package.json',
      data: JSON.stringify({
        name: 'core',
        title: '底座基础能力',
        version,
        type: 'module',
        apiVersion: '2',
        essential: true,
        capabilities: [],
        commands: [{ name: 'show', title: '基础页', mode: 'view', searchable: true }],
      }),
    },
    { name: 'index.html', data: `<!doctype html><title>底座基础能力 ${version}</title>` },
  ])
  await fsp.writeFile(file, zip)
  return file
}

test('出厂插件与 essential 插件都在装配期就位', async () => {
  const demo = await h.plugin('demo')
  assertEqual(demo?.version, '1.0.0')
  assertEqual(demo?.builtin, true)
  assertEqual(demo?.essential, false)
  const core = await h.plugin('core')
  assertEqual(core?.essential, true, 'essential 来自出厂清单，客户端读得到')
})

test('覆盖安装非 essential 出厂插件：新版本生效且广播 plugin/reloaded', async () => {
  const events: Array<{ event: string; data: unknown }> = []
  const sub = h.subscribe(({ event, data }) => events.push({ event, data }))
  await sub.ready

  const zipPath = await packDemo('2.0.0')
  const installed = await h.pluginAction('installZip', { path: zipPath, overwrite: true })
  assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)

  const record = await h.plugin('demo')
  assertEqual(record?.version, '2.0.0', '新版本应当生效')
  assertEqual(record?.builtin, true, '被覆盖后仍是出厂插件（不可卸载、可禁用）')
  assert(
    String((record as PluginInfo & { dir?: string })?.dir ?? '').replace(/\\/g, '/').includes('/extensions/'),
    `生效目录应当切到 extensions：${String((record as { dir?: string })?.dir)}`,
  )

  await h.waitFor(() => events.some((entry) => entry.event === 'plugin/reloaded'))
  const reloaded = events.find((entry) => entry.event === 'plugin/reloaded')
  assertEqual((reloaded?.data as { pluginId?: string } | undefined)?.pluginId, 'demo')
  assertEqual((reloaded?.data as { ok?: boolean } | undefined)?.ok, true, '重载成功才让 UI 重开页面')
  sub.stop()
})

test('升级保留用户数据：别名覆盖不随安装目录一起被清', async () => {
  const before = await h.pluginAction('setKeywords', { id: 'demo', keywords: ['我的别名'] })
  assert(before.ok, '设置别名应当成功')
  const overrides = await h.readData<Record<string, { keywords?: string[] }>>('plugin-overrides.json')
  assertEqual(overrides.demo?.keywords?.[0], '我的别名')

  const zipPath = await packDemo('3.0.0')
  const installed = await h.pluginAction('installZip', { path: zipPath, overwrite: true })
  assert(installed.ok, `覆盖安装应当成功：${JSON.stringify(installed.error ?? {})}`)
  assertEqual((await h.plugin('demo'))?.version, '3.0.0')

  const after = await h.readData<Record<string, { keywords?: string[] }>>('plugin-overrides.json')
  assertEqual(after.demo?.keywords?.[0], '我的别名', '升级绝不能走 uninstall 那条路（会清覆盖层）')
})

test('essential 出厂插件不可被覆盖：ESSENTIAL_PROTECTED 且旧版本不动', async () => {
  const zipPath = await packCore('2.0.0')
  const result = await h.pluginAction('installZip', { path: zipPath, overwrite: true })
  assertEqual(result.ok, false, 'essential 必须被拒绝')
  assertEqual(result.error?.code, 'ESSENTIAL_PROTECTED')
  const core = await h.plugin('core')
  assertEqual(core?.version, '1.0.0', '拒绝后旧版本原地不动')
  assert(
    !String((core as { dir?: string })?.dir ?? '').replace(/\\/g, '/').includes('/extensions/'),
    '生效目录仍是出厂 bundle',
  )
})

test('revertToBuiltin 回到 App 自带的那份', async () => {
  assertEqual((await h.plugin('demo'))?.version, '3.0.0')
  const reverted = await h.pluginAction('revertToBuiltin', { id: 'demo' })
  assert(reverted.ok, `恢复出厂应当成功：${JSON.stringify(reverted.error ?? {})}`)
  assertEqual((reverted as { reverted?: boolean }).reverted, true)
  assertEqual((await h.plugin('demo'))?.version, '1.0.0')

  // 没有覆盖时不是错误
  const again = await h.pluginAction('revertToBuiltin', { id: 'demo' })
  assert(again.ok, '没有覆盖时也应成功（不是错误）')
  assertEqual((again as { reverted?: boolean }).reverted, false)
})

test('zip 安装还原可执行位：逻辑层二进制装完起得来', async () => {
  if (process.platform === 'win32') return // Windows 没有 unix 权限位
  const file = path.join(h.dataRoot, 'downloads', 'demo-4.0.0.zip')
  const manifest = JSON.stringify({
    name: 'demo',
    title: '出厂示例',
    version: '4.0.0',
    type: 'module',
    apiVersion: '2',
    capabilities: [],
    commands: [
      { name: 'show', title: '示例页', mode: 'view', searchable: true },
      { name: 'hello', title: '示例命令', mode: 'no-view', searchable: false },
    ],
  })
  await fsp.writeFile(
    file,
    makeZip([
      { name: 'package.json', data: manifest },
      { name: 'index.html', data: '<!doctype html><title>示例</title>' },
      { name: 'hello', data: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    ]),
  )
  const installed = await h.pluginAction('installZip', { path: file, overwrite: true })
  assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)
  const mode = (await fsp.stat(path.join(h.dataRoot, 'extensions', 'demo', 'hello'))).mode
  assert((mode & 0o111) !== 0, `装完必须保留可执行位（当前 0o${(mode & 0o777).toString(8)}）`)
})

test('出厂插件不可卸载（恢复出厂是它的等价动作）', async () => {
  const result = await h.pluginAction('uninstall', { id: 'demo' })
  assertEqual(result.ok, false)
  assertEqual(result.error?.code, 'FORBIDDEN')
})

const failed = await run('插件更新契约')
await h.stop()
if (failed > 0) process.exit(1)
