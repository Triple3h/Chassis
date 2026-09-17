/**
 * 插件改名的数据连续性（requirements §7.4 / §7.5）。
 *
 * 用户实测 bug：插件改名（`sofast-hosts` → `hosts`）并升级后，「最近使用」里的
 * Hosts 管家是灰的 —— history.json 里存的还是旧 pluginId，而置灰判定
 * `isResultAlive(pluginId, command)` 查的是新 id，必然判「插件不可用」。
 * 数据目录那次迁移（`adoptLegacyDataDir`）救不了它：历史项也得跟着改名。
 *
 * 2026-09-17 再改一次（`hosts` → `host-manager`）后这个用例多了一条职责：
 * **两代旧 id 都要一次跳到当前 id**。迁移是单跳查表，链在 `legacy.ts` 里，
 * 断了就会出现「停在中间那一代上、条目照样置灰」的回归。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const LEGACY_KEY = 'sofast-hosts:hosts:2be88ca4'
const MIDDLE_KEY = 'hosts:hosts:2be88ca4'
const MIDDLE_ARGS_KEY = 'hosts:hosts:77aa11'
const CURRENT_KEY = 'host-manager:hosts:2be88ca4'
const CURRENT_ARGS_KEY = 'host-manager:hosts:77aa11'

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
          // 上一代 id 也留下过记录：迁移后与上一条同 key，应当合并
          { key: MIDDLE_KEY, pluginId: 'hosts', command: 'hosts', title: 'Hosts 管家', lastUsed: 1500, count: 2 },
          { key: MIDDLE_ARGS_KEY, pluginId: 'hosts', command: 'hosts', args: { tab: 'system' }, title: 'Hosts 管家', lastUsed: 1400, count: 1 },
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
  items: Array<{ key: string; pluginId: string; title: string; count: number }>
  pinned: Array<{ key: string; pluginId: string }>
}

test('启动时把历史 / 固定项里的旧插件 id 改成新 id（真实启动路径）', async () => {
  const view = await h.api<HistoryView>('/api/history')

  const hosts = view.items.find((item) => item.pluginId === 'host-manager')
  assert(hosts, `历史项应当迁移到新 id：${JSON.stringify(view.items)}`)
  assertEqual(hosts?.key, CURRENT_KEY, 'key 前缀必须一起换，否则固定 / 历史对不上号')
  assertEqual(hosts?.title, 'Hosts 管家', '展示快照不动')
  assertEqual(hosts?.count, 5, '两代旧记录合并后次数相加（3 + 2）')
  assertEqual(
    view.items.some((item) => item.pluginId === 'sofast-hosts' || item.pluginId === 'hosts'),
    false,
    '两代旧 id 都不该留下',
  )
  assert(
    view.items.some((item) => item.key === CURRENT_ARGS_KEY),
    '带 args 的条目也要换前缀（args 哈希不动）',
  )

  assertEqual(view.pinned[0]?.pluginId, 'host-manager')
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
  assert(
    !raw.items.some((item) => item.pluginId === 'sofast-hosts' || item.pluginId === 'hosts'),
    '迁移结果应当落盘，不该每次启动重来',
  )
})

const failed = await run('插件改名迁移')
await h.stop()
if (failed > 0) process.exit(1)
