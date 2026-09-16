/**
 * 插件页主题的判定优先级（plugin-spec §5.3）。
 *
 * 为什么值得单独测：这条规则出错的样子**在界面上看不出是错的** ——
 * 插件页永远不跟宿主换主题，看着就像"这个插件本来就是浅色"。
 * 实测踩过一次：`useTheme` 在挂载时把自动判定出来的主题也写进了 localStorage，
 * 于是「第一次打开插件页时恰好是什么主题」从此压过宿主透传的 `?theme=`。
 *
 * 规则本身在 `packages/ui/lib/themePriority.ts`，纯函数、不碰 DOM：
 * 正因为它纯，才不用起浏览器就能把优先级钉死。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { resolveTheme } from '../../packages/ui/lib/themePriority'

const base = { pinned: '', fromHost: '', fromDocument: '', system: 'dark' as const }

test('手动选过 ⇒ 压过宿主、文档与系统', () => {
  const decision = resolveTheme({ pinned: 'light', fromHost: 'dark', fromDocument: 'dark', system: 'dark' })
  assertEqual(decision.mode, 'light', '用户按过主题按钮，就该一直是那个主题')
  assertEqual(decision.source, 'pinned')
})

test('没手动选过时，宿主透传的主题压过系统偏好', () => {
  const decision = resolveTheme({ ...base, fromHost: 'light', system: 'dark' })
  assertEqual(decision.mode, 'light', '宿主说是浅色就必须是浅色，不能被系统偏好顶掉')
  assertEqual(decision.source, 'host')
})

test('宿主没给主题时退回文档上的 data-theme', () => {
  const decision = resolveTheme({ ...base, fromDocument: 'light' })
  assertEqual(decision.mode, 'light')
  assertEqual(decision.source, 'document')
})

test('什么都不知道时才用系统偏好', () => {
  assertEqual(resolveTheme({ ...base, system: 'light' }).source, 'system')
  assertEqual(resolveTheme({ ...base, system: 'light' }).mode, 'light')
  assertEqual(resolveTheme(base).mode, 'dark')
})

test('非法值一律当没给（不能让脏数据决定界面）', () => {
  const decision = resolveTheme({ pinned: 'solarized', fromHost: 'AUTO', fromDocument: 'null', system: 'light' })
  assertEqual(decision.mode, 'light')
  assertEqual(decision.source, 'system')
})

test('没有手动选择时判定结果永不来自 pinned —— 自动判定没有东西可落盘', () => {
  // 这是那次实测 bug 的正面回归：只要自动判定产生不出 `pinned`，
  // 「宿主先浅色、后切深色」就会老老实实跟着换，而不是被第一次的值钉死。
  const first = resolveTheme({ ...base, fromHost: 'light' })
  assert(first.source !== 'pinned', `自动判定不该产出 pinned，实际：${first.source}`)
  assertEqual(resolveTheme({ ...base, fromHost: 'dark' }).mode, 'dark', '宿主换主题后插件页必须跟着换')
})

const failed = await run('插件页主题判定优先级')
if (failed > 0) process.exit(1)
