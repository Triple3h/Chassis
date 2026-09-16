/**
 * 插件改名的数据连续性（requirements §7.4 / §7.5）。
 *
 * 用户实测 bug：插件改名（`sofast-hosts` → `hosts`）并升级后，「最近使用」里的
 * Hosts 管家是灰的 —— history.json 里存的还是旧 pluginId，而置灰判定
 * `isResultAlive(pluginId, command)` 查的是新 id，必然判「插件不可用」。
 * 数据目录那次迁移（`adoptLegacyDataDir`）救不了它：历史项也得跟着改名。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const LEGACY_KEY = 'sofast-hosts:hosts:2be88ca4'
const CURRENT_KEY = 'hosts:hosts:2be88ca4'

const h = await createHarness({
  fixtures: ['echo-plugin'],
  label: 'legacy-id',
  seed: async (dataRoot) => {
    await fsp.writeFile(
      path.join(dataRoot, 'history.json'),
      JSON.stringify({
        version: 1,
        items: [
          { key: LEGACY_KEY, pluginId: 'sofast-hosts', command: 'hosts', title: 'Hosts 管家', lastUsed: 2000, count: 3 },
          { key: 'echo-plugin:echo:2be88ca4', pluginId: 'echo-plugin', command: 'echo', title: '契约自检', lastUsed: 1000, count: 1 },
        ],
      }),
    )
    await fsp.writeFile(
      path.join(dataRoot, 'pinned.json'),
      JSON.stringify({
        version: 1,
        items: [{ key: LEGACY_KEY, pluginId: 'sofast-hosts', command: 'hosts', title: 'Hosts 管家', order: 0 }],
      }),
    )
  },
})

interface HistoryView {
  items: Array<{ key: string; pluginId: string; title: string }>
  pinned: Array<{ key: string; pluginId: string }>
}

test('启动时把历史 / 固定项里的旧插件 id 改成新 id（真实启动路径）', async () => {
  const view = await h.api<HistoryView>('/api/history')

  const hosts = view.items.find((item) => item.pluginId === 'hosts')
  assert(hosts, `历史项应当迁移到新 id：${JSON.stringify(view.items)}`)
  assertEqual(hosts?.key, CURRENT_KEY, 'key 前缀必须一起换，否则固定 / 历史对不上号')
  assertEqual(hosts?.title, 'Hosts 管家', '展示快照不动')
  assertEqual(view.items.find((item) => item.pluginId === 'sofast-hosts'), undefined, '不该再留旧 id')

  assertEqual(view.pinned[0]?.pluginId, 'hosts')
  assertEqual(view.pinned[0]?.key, CURRENT_KEY)
})

test('没改过名的插件历史项不受影响；迁移结果落盘', async () => {
  const view = await h.api<HistoryView>('/api/history')
  assert(
    view.items.some((item) => item.pluginId === 'echo-plugin'),
    '未改名的插件条目必须原样保留',
  )

  await h.kernel.history.flush()
  const raw = JSON.parse(await fsp.readFile(path.join(h.dataRoot, 'history.json'), 'utf8')) as HistoryView
  assert(!raw.items.some((item) => item.pluginId === 'sofast-hosts'), '迁移结果应当落盘，不该每次启动重来')
})

const failed = await run('插件改名迁移')
await h.stop()
if (failed > 0) process.exit(1)
