/**
 * 管理面插件的口径（plugin-spec §3.2 `hidden`）：声明 `hidden` 的 view 命令
 * **首页插件格与搜索结果都不出现**，但仍可 `invoke` 打开 —— 设置 / 更新正是靠这一点
 * 把入口收进固定位置（⌘, / 搜索栏齿轮 / 托盘「检查更新…」「设置…」「插件管理…」），
 * 启动台里只剩下真正干活的插件。
 *
 * 想整插件退干净，要把它的**全部** view 命令都标上：漏一条，那条就会顶上来当入口。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const builtinRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-hidden-'))

/** 落一个只含 view 命令的出厂插件（首页插件格只认 view 入口） */
async function writePlugin(id: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(builtinRoot, id, 'dist')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ version: '0.1.0', type: 'module', apiVersion: '2', capabilities: [], ...manifest }, null, 2),
  )
  await fsp.writeFile(path.join(dir, 'index.html'), `<!doctype html><title>${id}</title>`)
}

// 管理面形态：两条 view 命令都 hidden（真实例子 = internal-settings 的 settings/manage）
await writePlugin('mgr', {
  name: 'mgr',
  title: '管理面板',
  commands: [
    { name: 'panel', title: '管理入口', mode: 'view', searchable: true, hidden: true },
    { name: 'extra', title: '管理入口二', mode: 'view', searchable: true, hidden: true },
  ],
})

// 对照：普通插件照旧出现在首页
await writePlugin('demo', {
  name: 'demo',
  title: '演示插件',
  commands: [{ name: 'open', title: '演示入口', mode: 'view', searchable: true }],
})

const h = await createHarness({ label: 'hidden-entries', builtinRoots: [builtinRoot] })

interface SearchHit {
  itemKey: string
  pluginId: string
  command: string
  item: { title: string }
}
interface SearchResponse {
  groups: { plugins: SearchHit[]; best: SearchHit[] }
}

const search = async (query: string): Promise<SearchResponse> =>
  h.api<SearchResponse>('/api/search', { method: 'POST', body: JSON.stringify({ query }) })

test('hidden 的 view 命令：首页不占格、搜索也不出现（整插件退干净）', async () => {
  const empty = await search('')
  const ids = empty.groups.plugins.map((item) => item.pluginId)
  assertEqual(ids.join(','), 'demo', `只有普通插件占首页格（实际：${ids.join(', ') || '空'}）`)

  const hit = await search('管理入口')
  assert(
    !hit.groups.best.some((item) => item.item.title.startsWith('管理入口')),
    `搜索也不该命中 hidden 命令：${hit.groups.best.map((item) => item.item.title).join(' | ') || '空'}`,
  )
})

test('hidden 只退启动台：仍可 invoke（固定入口靠它打开页面）', async () => {
  const opened = await h.invoke('mgr:panel')
  assert(opened.ok, `仍要能打开页面：${JSON.stringify(opened)}`)
  const url = String((opened.data as { url?: string } | undefined)?.url ?? '')
  assert(url.includes('/index.html?sid='), `view 会话照常建立：${url}`)
})

await run()
await h.stop()
