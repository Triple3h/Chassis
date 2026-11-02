/**
 * 更新页的变更说明（notes）解析。
 *
 * 为什么值得单独测：notes 由发布索引（外部数据）提供，界面上坏掉的样子**不会报错** ——
 * 换行被 `<p>` 压平、`###` / `**` 原样露出来，看着像发布方写错了文案。
 * 解析器只认 Keep a Changelog 用到的子集，并且必须在 HTML 视图里把内容完整转义。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { changelogHtml, parseChangelog } from '../../packages/ui/lib/changelog'

test('分类标题与条目按行拆开（内核 0.1.10 的真实 notes）', () => {
  const groups = parseChangelog(
    '### Changed\n\n- 内核更新源新增 npm/npmmirror（签名索引），国内更新优先走 npm；移除 Gitee 镜像',
  )
  assertEqual(groups.length, 1, '只有一个分类')
  assertEqual(groups[0]?.title, '变更')
  assertEqual(groups[0]?.items.length, 1)
  assertEqual(
    groups[0]?.items[0]?.map((segment) => segment.text).join(''),
    '内核更新源新增 npm/npmmirror（签名索引），国内更新优先走 npm；移除 Gitee 镜像',
  )
})

test('多个分类各自成组，未知分类保留原文', () => {
  const groups = parseChangelog('### Added\n\n- 新功能\n\n### Fixed\n\n- 修复一个问题\n\n### Custom\n\n- 自定义')
  assertEqual(groups.map((group) => group.title).join(','), '新增,修复,Custom')
  assertEqual(groups[2]?.items.length, 1, '未知分类的条目也要保留')
})

test('--notes 的自由文本（没有分类头）也渲染成条目', () => {
  const groups = parseChangelog('一句话说明这次更新')
  assertEqual(groups.length, 1)
  assertEqual(groups[0]?.title, '')
  assertEqual(groups[0]?.items.length, 1)
})

test('行内 **加粗** 与 `代码` 拆成不同样式', () => {
  const [item] = parseChangelog('- **BREAKING** 移除 `legacy` 接口').flatMap((group) => group.items)
  assert(!!item, '应解析出条目')
  assertEqual(item.map((segment) => `${segment.bold ? 'b' : segment.code ? 'c' : 't'}:${segment.text}`).join('|'), 'b:BREAKING|t: 移除 |c:legacy|t: 接口')
})

test('HTML 视图转义内容，notes 里的标签不会当元素渲染', () => {
  const html = changelogHtml('### Fixed\n\n- 修掉 <script>alert(1)</script> 注入')
  assert(!html.includes('<script>'), 'notes 来自外部，必须转义')
  assert(html.includes('&lt;script&gt;'), '转义后的文本仍要完整显示')
})

test('空 notes 不产出任何结构', () => {
  assertEqual(parseChangelog(null).length, 0)
  assertEqual(parseChangelog('   \n\n').length, 0)
  assertEqual(changelogHtml(''), '')
})

run()
