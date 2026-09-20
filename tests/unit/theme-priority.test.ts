/**
 * 插件页主题的判定优先级与主题色校验（plugin-spec §5.3）。
 *
 * 为什么值得单独测：这条规则出错的样子**在界面上看不出是错的** ——
 * 插件页永远不跟宿主换主题，看着就像"这个插件本来就是浅色"。
 * 实测踩过一次：页内把自动判定出来的主题写进 localStorage，
 * 于是「第一次打开插件页时恰好是什么主题」从此压过宿主透传的 `?theme=`。
 * 现在页内不落盘、也不提供切换，钉住它的是「判定函数产不出页内来源」这一条。
 *
 * 规则本身在 `packages/ui/lib/themePriority.ts`，纯函数、不碰 DOM：
 * 正因为它纯，才不用起浏览器就能把优先级钉死。
 */
import { assertEqual, run, test } from '../helpers/assert'
import { parseAccent, resolveTheme } from '../../packages/ui/lib/themePriority'

const base = { fromHost: '', fromDocument: '', system: 'dark' as const }

test('宿主透传的主题压过文档属性与系统偏好', () => {
  const decision = resolveTheme({ fromHost: 'light', fromDocument: 'dark', system: 'dark' })
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
  const decision = resolveTheme({ fromHost: 'AUTO', fromDocument: 'null', system: 'light' })
  assertEqual(decision.mode, 'light')
  assertEqual(decision.source, 'system')
})

test('宿主换主题后插件页必须跟着换 —— 页内不持有主题状态', () => {
  // 这是那次实测 bug 的正面回归：判定不依赖任何「本页选过什么」，
  // 「宿主先浅色、后切深色」就会老老实实跟着换，而不是被第一次的值钉死。
  assertEqual(resolveTheme({ ...base, fromHost: 'light' }).mode, 'light')
  assertEqual(resolveTheme({ ...base, fromHost: 'dark' }).mode, 'dark')
})

test('主题色只接受 #rgb / #rrggbb，其余一律当没给', () => {
  assertEqual(parseAccent('#4f8cff'), '#4f8cff')
  assertEqual(parseAccent(' #abc '), '#abc', '两侧的空白可以容忍')
  assertEqual(parseAccent('#12345'), '', '位数不对')
  assertEqual(parseAccent('4f8cff'), '', '缺 #')
  assertEqual(parseAccent('red'), '', '颜色关键字不收')
  assertEqual(parseAccent(''), '')
  assertEqual(parseAccent('var(--x)'), '', '不能让任意 CSS 值混进 CSS 变量')
  assertEqual(parseAccent('#4f8cff;background:url(x)'), '', '注入串必须被挡住')
})

const failed = await run('插件页主题判定与主题色校验')
if (failed > 0) process.exit(1)
