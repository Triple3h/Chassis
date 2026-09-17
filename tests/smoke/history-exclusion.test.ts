/**
 * 清单 `history: false`：底座自身的入口（设置 / 插件管理 / 应用启动 / 文件搜索）不进「最近使用」。
 *
 * 两条路都要守住，缺一条用户就会觉得"没生效"：
 * ① **以后不写** —— 执行成功也不产生历史条目；
 * ② **存量要清** —— 光"以后不写"不够，最近使用里那条旧记录会一直留着。
 *
 * 只影响最近使用：搜索结果与固定项照旧（固定是用户的显式动作）。
 */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

interface HistoryView {
  items: Array<{ key: string; pluginId: string; command: string; title: string; count: number }>
  pinned: Array<{ key: string; pluginId: string }>
}

/**
 * 历史 / 固定项的稳定 key（内核 `util::text::item_key` 的镜像：`<插件>:<命令>:<args 的 sha1 前 8 位>`）。
 * 存量条目的 key 必须与内核写入时一致，否则「再次使用」会被当成新条目、测不到次数累加。
 */
function itemKey(pluginId: string, command: string, args?: unknown): string {
  const hash = createHash('sha1').update(JSON.stringify(args ?? null)).digest('hex').slice(0, 8)
  return `${pluginId}:${command}:${hash}`
}

async function writePlugin(root: string, manifest: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2))
  await fsp.writeFile(path.join(root, 'index.html'), '<!doctype html><title>demo</title>')
}

const builtinRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-history-builtin-'))
await writePlugin(path.join(builtinRoot, 'quiet-entry', 'dist'), {
  name: 'quiet-entry',
  title: '静默入口',
  version: '1.0.0',
  type: 'module',
  apiVersion: '1',
  capabilities: [],
  history: false,
  commands: [{ name: 'main', title: '静默入口', mode: 'view' }],
})
await writePlugin(path.join(builtinRoot, 'noisy-entry', 'dist'), {
  name: 'noisy-entry',
  title: '普通入口',
  version: '1.0.0',
  type: 'module',
  apiVersion: '1',
  capabilities: [],
  commands: [{ name: 'main', title: '普通入口', mode: 'view' }],
})

const h = await createHarness({
  label: 'history-exclusion',
  builtinRoots: [builtinRoot],
  seed: async (dataRoot) => {
    // 存量：两条旧记录（外加一条固定项），启动装配期只该摘掉 quiet-entry 那条
    // （key 由内核按 `pluginId:command:args哈希` 生成，这里只需要 pluginId 对得上 —— 摘除是按插件 id 做的）
    await fsp.writeFile(
      path.join(dataRoot, 'history.json'),
      JSON.stringify({
        version: 1,
        items: [
          { key: itemKey('quiet-entry', 'main'), pluginId: 'quiet-entry', command: 'main', title: '静默入口', lastUsed: 2000, count: 3 },
          { key: itemKey('noisy-entry', 'main'), pluginId: 'noisy-entry', command: 'main', title: '普通入口', lastUsed: 1000, count: 1 },
        ],
      }),
    )
    await fsp.writeFile(
      path.join(dataRoot, 'pinned.json'),
      JSON.stringify({
        version: 1,
        items: [{ key: 'quiet-entry:main', pluginId: 'quiet-entry', command: 'main', title: '静默入口', order: 0 }],
      }),
    )
  },
})

test('启动时摘掉 history:false 插件的存量条目，固定项不受影响', async () => {
  const view = await h.api<HistoryView>('/api/history')
  const ids = view.items.map((item) => item.pluginId)
  assertEqual(ids.length, 1, `只应剩普通入口，实际：${ids.join(',') || '（空）'}`)
  assertEqual(ids[0], 'noisy-entry')
  assertEqual(view.pinned.length, 1, '固定是用户的显式动作，不能被插件声明抹掉')
})

test('执行 history:false 的插件不写历史；普通插件照常写（次数累加）', async () => {
  const quiet = await h.invoke('quiet-entry:main')
  assert(quiet.ok, `执行应当成功：${JSON.stringify(quiet)}`)
  const afterQuiet = await h.api<HistoryView>('/api/history')
  assert(
    !afterQuiet.items.some((item) => item.pluginId === 'quiet-entry'),
    'history:false 的插件执行后不该出现在最近使用里',
  )

  // 执行两次：存量那条（次数 1）应当被累加到 3 —— 说明「再次使用」认得出是同一条
  await h.invoke('noisy-entry:main')
  await h.invoke('noisy-entry:main')
  const afterNoisy = await h.api<HistoryView>('/api/history')
  const entry = afterNoisy.items.find((item) => item.pluginId === 'noisy-entry')
  assert(entry, '普通插件照常写历史')
  assertEqual(entry?.count, 3, `存量条目应当被继续累加，实际 count=${entry?.count}`)
})

const failed = await run('最近使用排除（history: false）')
await h.stop()
await fsp.rm(builtinRoot, { recursive: true, force: true })
if (failed > 0) process.exit(1)
