/**
 * 底座基础能力（`essential`）：不可禁用、只有出厂声明算数、配置里的残留禁用项在启动时被清掉。
 *
 * 判定标准：禁用它会让启动台基本功能残废（搜应用 / 搜文件），或让用户失去自救入口
 * （设置与插件管理被禁用后，界面上再没有地方能把它改回来）。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

interface InfoLike {
  id: string
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
    await fsp.writeFile(
      path.join(dataRoot, 'config.json'),
      JSON.stringify({ disabled: ['core-thing'] }, null, 2),
    )
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
  },
})

test('出厂声明 essential：配置里的禁用项被忽略，插件照常激活', async () => {
  assertEqual(h.kernel.plugins.isEssential('core-thing'), true)
  assertEqual(h.kernel.plugins.get('core-thing')?.state, 'active')
  assertEqual(
    h.kernel.config.get().disabled.includes('core-thing'),
    false,
    '残留禁用项应当从配置里清掉',
  )
})

test('essential 插件不可禁用：内核直接拒绝，状态不变', async () => {
  let code = ''
  let message = ''
  await h.kernel.plugins.setDisabled('core-thing', true).catch((err: { code?: string; message?: string }) => {
    code = err.code ?? ''
    message = err.message ?? ''
  })
  assertEqual(code, 'FORBIDDEN')
  assert(message.includes('基础能力'), `错误信息应当说明原因：${message}`)
  assertEqual(h.kernel.plugins.get('core-thing')?.state, 'active', '拒绝之后状态不能变')
})

test('界面调用路径（pluginAction）走同一条保护', async () => {
  let message = ''
  await h.kernel.pluginAction('disable', { id: 'core-thing' }).catch((err: Error) => {
    message = err.message
  })
  assert(message.includes('基础能力'), message)
  assertEqual(h.kernel.plugins.get('core-thing')?.state, 'active')
})

test('第三方插件自称 essential 无效：isEssential 为 false 且可正常禁用', async () => {
  assertEqual(h.kernel.plugins.get('fake-core')?.state, 'active')
  assertEqual(h.kernel.plugins.isEssential('fake-core'), false, '只认出厂声明')

  await h.kernel.pluginAction('disable', { id: 'fake-core' })
  assertEqual(h.kernel.plugins.get('fake-core')?.state, 'disabled')
})

test('info() 暴露 essential，界面据此隐藏禁用开关', async () => {
  const listed = await h.api<{ plugins: InfoLike[] }>('/api/plugins')
  const core = listed.plugins.find((plugin) => plugin.id === 'core-thing')
  const fake = listed.plugins.find((plugin) => plugin.id === 'fake-core')
  assertEqual(core?.essential, true)
  assertEqual(fake?.essential, false)
})

const failed = await run('底座基础能力（不可禁用）')
await h.stop()
await fsp.rm(builtinRoot, { recursive: true, force: true })
if (failed > 0) process.exit(1)
