/**
 * 旧宿主遗留数据迁移（requirements §8.10 / plugin-spec §11 过渡期）：
 * 如快 Sofast 把插件数据放在插件目录下（`<插件目录>/data/storage.json`），
 * 而新底座要求「数据与代码分离」（P7）—— 首次加载时必须搬进 dataRoot。
 *
 * 为什么值得一条契约测试：`PluginStorage.migrateLegacy()` 早就写好了，但**没人调用**，
 * 于是「承诺过的一次性迁移」是空的。这类"实现了但没接线"的洞只有端到端跑一次才看得见。
 *
 * 注意 echo-plugin fixture 是**源码工程形态**（插件根 = `<fixture>/dist`），
 * 所以旧数据要种在 `<extensions>/echo-plugin/dist/data/` 下 —— 与内核解析出的插件根一致。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const LEGACY = { accounts: [{ id: 'legacy-1' }], settings: { theme: 'dark' } }
const FRESH = { accounts: [{ id: 'new-1' }] }

/** 旧数据目录：插件根（= dist/）下面的 data/ */
const legacyDirOf = (dataRoot: string) => path.join(dataRoot, 'extensions', 'echo-plugin', 'dist', 'data')
const targetFileOf = (dataRoot: string) => path.join(dataRoot, 'plugins', 'echo-plugin', 'storage.json')

async function exists(file: string): Promise<boolean> {
  return fsp
    .access(file)
    .then(() => true)
    .catch(() => false)
}

/* ---------------------------------------------------------------- 场景一 */

const h = await createHarness({
  fixtures: ['echo-plugin'],
  label: 'storage-migration',
  seed: async (dataRoot) => {
    await fsp.mkdir(legacyDirOf(dataRoot), { recursive: true })
    await fsp.writeFile(path.join(legacyDirOf(dataRoot), 'storage.json'), JSON.stringify(LEGACY))
  },
})

test('旧 data/storage.json 被搬进 <dataRoot>/plugins/<id>/storage.json', async () => {
  const target = targetFileOf(h.dataRoot)
  assert(await exists(target), '目标文件不存在，说明迁移没有接线')
  assertDeepEqual(JSON.parse(await fsp.readFile(target, 'utf-8')), LEGACY)
})

test('迁移只复制不删除：旧文件留在原处交给用户清理', async () => {
  assert(await exists(path.join(legacyDirOf(h.dataRoot), 'storage.json')), '旧文件不该被删掉')
})

test('迁移在审计里留痕（可追溯）', () => {
  const records = h.kernel.audit.query({ pluginId: 'echo-plugin', limit: 50 })
  const migrated = records.filter((record) => record.method === 'storage.migrateLegacy')
  assertEqual(migrated.length, 1)
  assertEqual(migrated[0]?.ok, true)
})

test('通过桥读到的就是迁移后的数据', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  const res = await h.bridge(sid, token, 'ctx.storage.get', { key: 'accounts' })
  assertEqual(res.ok, true)
  assertDeepEqual(res.result, LEGACY.accounts)
})

/* ---------------------------------------------------------------- 场景二 */

const h2 = await createHarness({
  fixtures: ['echo-plugin'],
  label: 'storage-migration-existing',
  seed: async (dataRoot) => {
    await fsp.mkdir(legacyDirOf(dataRoot), { recursive: true })
    await fsp.writeFile(path.join(legacyDirOf(dataRoot), 'storage.json'), JSON.stringify(LEGACY))

    const target = targetFileOf(dataRoot)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, JSON.stringify(FRESH))
  },
})

test('目标已存在时不迁移（绝不拿旧数据盖新数据）', async () => {
  assertDeepEqual(JSON.parse(await fsp.readFile(targetFileOf(h2.dataRoot), 'utf-8')), FRESH)
  const records = h2.kernel.audit.query({ pluginId: 'echo-plugin', limit: 50 })
  assertEqual(records.filter((record) => record.method === 'storage.migrateLegacy').length, 0)
})

/* ------------------------------------------------------- 收尾（run 只能调一次） */

const failed = await run('旧数据迁移契约')
await h.stop()
await h2.stop()
if (failed > 0) process.exit(1)
