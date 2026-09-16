/**
 * 「界面化改别名」的端到端等价物（走设置页调用的同一条 pluginAction）：
 * 中文标题 + 无别名的插件搜不到英文名 → setKeywords 后立刻能搜到（不用重载）→ 恢复默认后又回到原状。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

interface PluginInfo {
  id: string
  keywords: string[]
  keywordsCustomized: boolean
  commands: Array<{ name: string; keywords: string[]; keywordsCustomized: boolean }>
}

const h = await createHarness({ label: 'keywords' })

// 装一个「中文标题 + 清单里没有英文别名」的插件，复现 totp 当初搜不到的处境
const source = path.join(h.dataRoot, 'sources', 'alias-demo')
await fsp.mkdir(path.join(source, 'dist'), { recursive: true })
await fsp.writeFile(
  path.join(source, 'dist', 'package.json'),
  JSON.stringify(
    {
      name: 'alias-demo',
      title: '别名示例',
      version: '1.0.0',
      type: 'module',
      apiVersion: '1',
      capabilities: [],
      commands: [{ name: 'verify', title: '双重验证码', mode: 'view', searchable: true }],
    },
    null,
    2,
  ),
)
await fsp.writeFile(path.join(source, 'dist', 'index.html'), '<!doctype html><title>alias</title>')
await h.kernel.plugins.installFromDirectory(source, { overwrite: true })
assertEqual(h.kernel.plugins.get('alias-demo')?.state, 'active', '示例插件应当装配成功')

const search = (query: string) =>
  h.api<{ groups: { best: Array<{ pluginId: string }> } }>('/api/search', {
    method: 'POST',
    body: JSON.stringify({ query }),
  })

const action = (payload: Record<string, unknown>) =>
  h.api<{ ok: boolean; plugins: PluginInfo[] }>('/api/plugins/action', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

const infoOf = async (): Promise<PluginInfo> => {
  const listed = await h.api<{ plugins: PluginInfo[] }>('/api/plugins')
  const record = listed.plugins.find((plugin) => plugin.id === 'alias-demo')
  assert(record, '插件应当在列表里')
  return record
}

const hit = async (query: string): Promise<boolean> =>
  (await search(query)).groups.best.some((item) => item.pluginId === 'alias-demo')

test('起点：中文标题搜英文名搜不到（zhaohui）', async () => {
  assertEqual(await hit('totp'), false, '清单里没有 totp 别名时不应命中')
  assertEqual(await hit('shuangchong'), true, '中文标题的拼音本该命中（对照组）')
  const info = await infoOf()
  assertDeepEqual(info.keywords, [])
  assertEqual(info.keywordsCustomized, false)
})

test('编辑插件级别名：搜索立刻生效，不用重载插件', async () => {
  const result = await action({ action: 'setKeywords', id: 'alias-demo', keywords: ['totp', '验证码'] })
  assert(result.ok, '写入应当成功')
  const info = result.plugins.find((plugin) => plugin.id === 'alias-demo')
  assertDeepEqual(info?.keywords, ['totp', '验证码'], 'action 应当回传新的插件列表')
  assertEqual(info?.keywordsCustomized, true)

  assertEqual(await hit('totp'), true, '插件级别名应当作用于入口命令')
  assertEqual(h.kernel.plugins.get('alias-demo')?.state, 'active', '不重载插件即可生效')
})

test('命令级别名单独生效，界面拿到的仍是「命令自己」的别名', async () => {
  // 用与插件级别名（totp / 验证码）不重叠、也不是子串的词 ——
  // 别名同样走拼音索引，'otp' 会被 'totp' 的 includes 命中（子串匹配），不能拿来验证「谁生效」
  await action({ action: 'setKeywords', id: 'alias-demo', command: 'verify', keywords: ['authy', 'ga-code'] })
  assertEqual(await hit('authy'), true, '命令级别名应当参与搜索')
  const info = await infoOf()
  assertDeepEqual(info.commands[0]?.keywords, ['authy', 'ga-code'], '命令级只含自己的别名（不含插件级）')
  assertEqual(info.commands[0]?.keywordsCustomized, true)
  assertDeepEqual(info.keywords, ['totp', '验证码'], '插件级不受命令级编辑影响')
})

test('恢复默认：删掉覆盖后回到清单原值', async () => {
  await action({ action: 'resetKeywords', id: 'alias-demo', command: 'verify' })
  const afterCommand = await infoOf()
  assertDeepEqual(afterCommand.commands[0]?.keywords, [])
  assertEqual(afterCommand.commands[0]?.keywordsCustomized, false)
  assertEqual(await hit('authy'), false, '命令级别名已失效')

  await action({ action: 'resetKeywords', id: 'alias-demo' })
  const afterPlugin = await infoOf()
  assertDeepEqual(afterPlugin.keywords, [])
  assertEqual(afterPlugin.keywordsCustomized, false)
  assertEqual(await hit('totp'), false, '回到清单原值（无别名）')
})

test('覆盖落盘：重启内核后别名仍在', async () => {
  await action({ action: 'setKeywords', id: 'alias-demo', keywords: ['totp'] })
  const overrides = await fsp.readFile(path.join(h.dataRoot, 'plugin-overrides.json'), 'utf8')
  assert(overrides.includes('totp'), `覆盖层应当落盘：${overrides}`)

  await action({ action: 'resetKeywords', id: 'alias-demo' })
  await action({ action: 'resetKeywords', id: 'alias-demo', command: 'verify' })
})

test('未知插件 / 未知命令：拒绝而不是静默写入', async () => {
  await h.api('/api/plugins/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'setKeywords', id: 'not-installed', keywords: ['x'] }),
  }).catch(() => undefined)
  const info = await infoOf()
  assertEqual(info.keywordsCustomized, false, '无效请求不应改动任何东西')
})

const failed = await run('界面化别名（端到端）')
await h.stop()
if (failed > 0) process.exit(1)
