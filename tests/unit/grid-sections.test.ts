/**
 * 启动台首页分区（requirements §3.2）：
 *  - 空输入 = ① 已固定 ② **已安装插件**（内核按「这个插件最近一次打开」倒序排好，UI 原样渲染）；
 *    首页**不再**出现「最近使用」—— 最近使用只在有输入时作为命中分区存在。
 *  - 有输入 = ① 已固定命中 ② 最佳匹配 ③ 最近使用命中；插件分区不出现。
 *
 * 守的是「哪个分区在什么输入下出现、按什么顺序」，以及插件的折叠行数（默认 2 行）。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { buildSections, type BuildSectionsInput, type ResultGroup } from '../../apps/launcher-ui/src/lib/grid'
import type { RankedResult } from '../../apps/launcher-ui/src/lib/types'

function makeResult(key: string, title: string): RankedResult {
  const [pluginId = 'demo', command = 'open'] = key.split(':')
  return {
    pluginId,
    pluginTitle: pluginId,
    command,
    item: { id: `command:${command}`, title, action: { type: 'command', command } },
    itemKey: key,
    score: 1,
  }
}

const expanded: Record<ResultGroup, boolean> = { pinned: false, best: false, recent: false, plugins: false }

function sections(overrides: Partial<BuildSectionsInput>): ReturnType<typeof buildSections> {
  return buildSections({ query: '', pinned: [], best: [], recent: [], plugins: [], columns: 7, expanded, ...overrides })
}

test('空输入：已固定 + 已安装插件（最近使用不再占行）', () => {
  const out = sections({
    pinned: [makeResult('totp:totp:pin', '双重验证码')],
    plugins: [makeResult('host-manager:hosts:entry', 'Hosts 管家'), makeResult('todo:todo:entry', 'ToDo 待办')],
    recent: [makeResult('app-launcher:item:recent', '上次用过的文件')],
  })
  assertEqual(out.map((section) => section.label).join(' | '), '已固定 | 已安装插件')
  assertEqual(out[1]?.items.length, 2, '插件顺序由内核给（最近打开倒序），UI 不再重排')
  assertEqual(out[1]?.group, 'plugins')
})

test('有输入：最佳匹配 + 最近使用命中都在，插件分区不出现', () => {
  const out = sections({
    query: '验证',
    pinned: [makeResult('totp:totp:pin', '双重验证码')],
    best: [makeResult('totp:totp:best', '双重验证码')],
    recent: [makeResult('totp:totp:recent', '双重验证码')],
    plugins: [makeResult('totp:totp:entry', '双重验证码')],
  })
  assertEqual(out.map((section) => section.label).join(' | '), '已固定 | 最佳匹配 | 最近使用')
})

test('插件超过两行折叠，展开后全给', () => {
  const plugins = Array.from({ length: 20 }, (_, index) => makeResult(`p${index}:open:x`, `插件 ${index}`))
  const collapsed = sections({ plugins })
  assertEqual(collapsed[0]?.items.length, 14, '默认露 2 行（7 列 × 2）')
  assertEqual(collapsed[0]?.hidden, 6, '折叠时如实报出被藏起来的条数')
  assertEqual(collapsed[0]?.collapsible, true)

  const opened = sections({ plugins, expanded: { ...expanded, plugins: true } })
  assertEqual(opened[0]?.items.length, 20, '展开后全显示')
  assertEqual(opened[0]?.hidden, 0, '展开态没有被藏起来的条数')
})

test('没有插件也没有固定项：两个分区都不产出（交给空状态文案）', () => {
  assertEqual(sections({}).length, 0)
})

const failed = await run('启动台首页分区')
if (failed > 0) process.exit(1)
