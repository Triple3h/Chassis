import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import { HistoryStore } from '../../apps/kernel/src/history'
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

test('重复固定幂等；pruneInvalid 清理失效项', async () => {
  const { store, dir } = await tmpStore()
  store.pin({ key: 'a', pluginId: 'p', command: 'c', title: 'a' })
  store.pin({ key: 'a', pluginId: 'p', command: 'c', title: 'a' })
  assertEqual(store.pinnedList().length, 1)

  store.record({ key: 'dead', pluginId: 'gone', command: 'x', title: 'x' })
  const removed = store.pruneInvalid((item) => item.pluginId !== 'gone')
  assertEqual(removed.history, 1)
  assertEqual(store.allRecent().length, 0)
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

const failed = await run('历史与固定')
if (failed > 0) process.exit(1)
