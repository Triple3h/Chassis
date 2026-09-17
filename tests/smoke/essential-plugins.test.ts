/**
 * 底座基础能力（`essential`）：不可禁用、只有出厂声明算数、配置里的残留禁用项在启动时被清掉。
 *
 * 判定标准：禁用它会让启动台基本功能残废（搜应用 / 搜文件），或让用户失去自救入口
 * （设置与插件管理被禁用后，界面上再没有地方能把它改回来）。
 *
 * 三条路径都要走真实入口：HTTP `/api/plugins/action`（UI 插件管理页）、
 * 管理面 `ctx.settings.pluginAction`（设置页在插件页里走的那条）。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

interface InfoLike {
  id: string
  state: string
  essential: boolean
}

async function writePlugin(
  root: string,
  manifest: Record<string, unknown>,
  html = '<!doctype html><title>demo</title>',
): Promise<void> {
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2))
  await fsp.writeFile(path.join(root, 'index.html'), html)
}

// 出厂 bundle 里放一个声明了 essential 的插件
const builtinRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-essential-builtin-'))
await writePlugin(path.join(builtinRoot, 'core-thing', 'dist'), {
  name: 'core-thing',
  title: '基础示例',
  version: '1.0.0',
  type: 'module',
  apiVersion: '1',
  capabilities: [],
  essential: true,
  commands: [{ name: 'main', title: '基础入口', mode: 'view' }],
})

const h = await createHarness({
  label: 'essential',
  builtinRoots: [builtinRoot],
  seed: async (dataRoot) => {
    // ① 配置里残留「基础能力被禁用」的旧状态：启动时必须忽略并清掉，
    //    否则 essential 插件会永远停在禁用态，而界面上没有开关能把它打开
    await fsp.writeFile(path.join(dataRoot, 'config.json'), JSON.stringify({ disabled: ['core-thing'] }, null, 2))
    // ② 第三方插件自称 essential：不该获得保护（否则等于给自己上「用户关不掉」）
    await writePlugin(path.join(dataRoot, 'extensions', 'fake-core', 'dist'), {
      name: 'fake-core',
      title: '自称基础',
      version: '1.0.0',
      type: 'module',
      apiVersion: '1',
      capabilities: [],
      essential: true,
      commands: [{ name: 'main', title: '入口', mode: 'view' }],
    })
    // ③ 设置页那条路要一个 `internal-` 前缀的插件才有管理面权限（ADR-0003）
    await writePlugin(path.join(dataRoot, 'extensions', 'internal-probe', 'dist'), {
      name: 'internal-probe',
      title: '管理面探针',
      version: '1.0.0',
      type: 'module',
      apiVersion: '1',
      capabilities: [],
      commands: [{ name: 'main', title: '入口', mode: 'view' }],
    })
  },
})

const infoOf = async (id: string): Promise<InfoLike | undefined> => {
  const listed = await h.api<{ plugins: InfoLike[] }>('/api/plugins')
  return listed.plugins.find((plugin) => plugin.id === id)
}

test('出厂声明 essential：配置里的禁用项被忽略，插件照常激活', async () => {
  const core = await infoOf('core-thing')
  assertEqual(core?.essential, true)
  assertEqual(core?.state, 'active')
  assertEqual(
    (await h.config()).disabled.includes('core-thing'),
    false,
    '残留禁用项应当从配置里清掉',
  )
})

test('essential 插件不可禁用：内核直接拒绝，状态不变（HTTP 入口）', async () => {
  const res = await h.pluginAction('disable', { id: 'core-thing' })
  assertEqual(res.ok, false, '禁用应当被拒')
  assertEqual(res.error?.code, 'FORBIDDEN')
  assert(
    (res.error?.message ?? '').includes('基础能力'),
    `错误信息应当说明原因：${res.error?.message ?? ''}`,
  )
  assertEqual((await infoOf('core-thing'))?.state, 'active', '拒绝之后状态不能变')
})

test('设置页那条路（ctx.settings.pluginAction）走同一条保护', async () => {
  const { sid, token } = await h.openSession('internal-probe', 'main')
  const res = await h.bridge(sid, token, 'ctx.settings.pluginAction', {
    action: 'disable',
    payload: { id: 'core-thing' },
  })
  assertEqual(res.ok, false, '管理面同样不得禁用')
  assert(
    (res.error?.message ?? '').includes('基础能力'),
    `错误信息应当说明原因：${res.error?.message ?? ''}`,
  )
  assertEqual((await infoOf('core-thing'))?.state, 'active')
})

test('第三方插件自称 essential 无效：isEssential 为 false 且可正常禁用', async () => {
  assertEqual((await infoOf('fake-core'))?.state, 'active')
  assertEqual((await infoOf('fake-core'))?.essential, false, '只认出厂声明')

  const res = await h.pluginAction('disable', { id: 'fake-core' })
  assertEqual(res.ok, true, `普通插件应当可禁用：${JSON.stringify(res.error ?? {})}`)
  assertEqual((await infoOf('fake-core'))?.state, 'disabled')
})

test('信息接口暴露 essential，界面据此隐藏禁用开关', async () => {
  assertEqual((await infoOf('core-thing'))?.essential, true)
  assertEqual((await infoOf('fake-core'))?.essential, false)
})

const failed = await run('底座基础能力（不可禁用）')
await h.stop()
await fsp.rm(builtinRoot, { recursive: true, force: true })
if (failed > 0) process.exit(1)
