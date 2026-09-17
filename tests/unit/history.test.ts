import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import { HistoryStore } from '../../apps/kernel/src/history'
import { LEGACY_ID_TO_CURRENT } from '../../apps/kernel/src/legacy'
import { itemKey } from '../../apps/kernel/src/util/text'

async function tmpStore(limit = 500): Promise<{ store: HistoryStore; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-history-'))
  const store = new HistoryStore(dir)
  await store.load(limit)
  return { store, dir }
}

test('record 累加使用次数并刷新 lastUsed', async () => {
  const { store, dir } = await tmpStore()
  const base = { key: itemKey('p', 'cmd', undefined), pluginId: 'p', command: 'cmd', title: '命令' }
  const first = store.record(base)
  assertEqual(first.count, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = store.record({ ...base, title: '命令改名' })
  assertEqual(second.count, 2)
  assert(second.lastUsed >= first.lastUsed, 'lastUsed 应前进')
  assertEqual(store.recent()[0]?.title, '命令改名', '展示快照应更新')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('超过 historyLimit 时按 lastUsed 淘汰最旧', async () => {
  const { store, dir } = await tmpStore(100)
  for (let i = 0; i < 120; i += 1) {
    store.record({ key: `k${i}`, pluginId: 'p', command: 'c', title: `item-${i}` })
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const all = store.allRecent()
  assertEqual(all.length, 100)
  assert(!all.some((item) => item.key === 'k0'), '最旧的条目应当被淘汰')
  assertEqual(all[0]?.key, 'k119', '最新的条目在最前')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('固定项按 order 排序，重排与取消固定都生效', async () => {
  const { store, dir } = await tmpStore()
  for (const key of ['a', 'b', 'c']) {
    store.pin({ key, pluginId: 'p', command: 'c', title: key })
  }
  assertDeepEqual(store.pinnedList().map((p) => p.key), ['a', 'b', 'c'])
  store.reorder(['c', 'a', 'b'])
  assertDeepEqual(store.pinnedList().map((p) => p.key), ['c', 'a', 'b'])
  store.unpin('a')
  assertDeepEqual(store.pinnedList().map((p) => p.key), ['c', 'b'])
  assertDeepEqual(store.pinnedList().map((p) => p.order), [0, 1], 'unpin 后 order 应重新编号')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('重复固定幂等', async () => {
  const { store, dir } = await tmpStore()
  store.pin({ key: 'a', pluginId: 'p', command: 'c', title: 'a' })
  store.pin({ key: 'a', pluginId: 'p', command: 'c', title: 'a' })
  assertEqual(store.pinnedList().length, 1)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('dropHistoryBy 只清历史、不动固定项（固定是用户的显式动作）', async () => {
  const { store, dir } = await tmpStore()
  store.record({ key: 'q', pluginId: 'quiet', command: 'c', title: '静默入口' })
  store.record({ key: 'n', pluginId: 'noisy', command: 'c', title: '普通入口' })
  store.pin({ key: 'q', pluginId: 'quiet', command: 'c', title: '静默入口' })

  assertEqual(store.dropHistoryBy((pluginId) => pluginId === 'quiet'), 1)
  assertEqual(store.allRecent().length, 1)
  assertEqual(store.allRecent()[0]?.pluginId, 'noisy', '别的插件不受影响')
  assertEqual(store.pinnedList().length, 1, '固定项不能被插件的一句声明抹掉')
  assertEqual(store.dropHistoryBy((pluginId) => pluginId === 'quiet'), 0, '重复调用是幂等的')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('debounce + 原子写：flush 后落盘可重新加载', async () => {
  const { store, dir } = await tmpStore()
  store.record({ key: 'persist', pluginId: 'p', command: 'c', title: '落盘' })
  store.pin({ key: 'persist', pluginId: 'p', command: 'c', title: '落盘' })
  await store.flush()

  const reloaded = new HistoryStore(dir)
  await reloaded.load(500)
  assertEqual(reloaded.allRecent().length, 1)
  assertEqual(reloaded.pinnedList().length, 1)
  assertEqual(reloaded.pinnedList()[0]?.title, '落盘')
  const files = await fsp.readdir(dir)
  assert(files.includes('history.json') && files.includes('pinned.json'), `落盘文件缺失：${files.join(',')}`)
  assert(!files.some((f) => f.endsWith('.tmp')), '不应残留临时文件')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('插件改名：两代旧 id 一次迁到当前 id，并与新 id 的同类条目合并', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-history-migrate-'))
  // hosts 改过两次名：sofast-hosts → hosts → host-manager。
  // 两条历史必须**一次跳到底**（迁移是单跳查表，链断了就会停在中间那代上）。
  const legacyCommandKey = itemKey('sofast-hosts', 'hosts', undefined)
  const legacyArgsKey = itemKey('sofast-hosts', 'hosts', { tab: 'system' })
  await fsp.writeFile(
    path.join(dir, 'history.json'),
    JSON.stringify({
      version: 1,
      items: [
        { key: legacyCommandKey, pluginId: 'sofast-hosts', command: 'hosts', title: 'Hosts 管家', lastUsed: 1000, count: 1 },
        // 上一代 id 已经写过同一条：迁移后必须合并，不能变成两条
        { key: itemKey('hosts', 'hosts', undefined), pluginId: 'hosts', command: 'hosts', title: 'Hosts 管家', lastUsed: 2000, count: 2 },
        { key: legacyArgsKey, pluginId: 'sofast-hosts', command: 'hosts', args: { tab: 'system' }, title: 'Hosts 管家', lastUsed: 500, count: 1 },
        { key: itemKey('other', 'x', undefined), pluginId: 'other', command: 'x', title: '别的插件', lastUsed: 300, count: 1 },
      ],
    }),
  )
  await fsp.writeFile(
    path.join(dir, 'pinned.json'),
    JSON.stringify({
      version: 1,
      items: [{ key: legacyCommandKey, pluginId: 'sofast-hosts', command: 'hosts', title: 'Hosts 管家', order: 0 }],
    }),
  )

  const store = new HistoryStore(dir)
  await store.load(500)
  const migrated = store.migratePluginIds(LEGACY_ID_TO_CURRENT)
  assertEqual(migrated.history, 3, '两代旧 id 的三条都要迁')
  assertEqual(migrated.pinned, 1)
  assertEqual(store.allRecent().length, 3, '同一 key 的新旧条目应当合并成一条')

  const merged = store.find(itemKey('host-manager', 'hosts', undefined))
  assert(merged, '迁移后 key 前缀应当就是当前 id')
  assertEqual(merged?.pluginId, 'host-manager')
  assertEqual(merged?.count, 3, '合并后使用次数相加')
  assertEqual(merged?.lastUsed, 2000, '保留最近使用的一条')
  assert(store.find(legacyArgsKey) === undefined, '带 args 的条目也应当换前缀')
  assert(store.find(itemKey('host-manager', 'hosts', { tab: 'system' })), 'args 哈希不该被改动')
  assertEqual(store.find(itemKey('other', 'x', undefined))?.pluginId, 'other', '别的插件不受影响')
  assertEqual(store.pinnedList()[0]?.pluginId, 'host-manager')

  await store.flush()
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'history.json'), 'utf8')) as { items: Array<{ pluginId: string }> }
  assert(
    !raw.items.some((item) => item.pluginId === 'sofast-hosts' || item.pluginId === 'hosts'),
    '迁移结果应当落盘，且不该停在中间那一代上',
  )
  await fsp.rm(dir, { recursive: true, force: true })
})

const failed = await run('历史与固定')
if (failed > 0) process.exit(1)
