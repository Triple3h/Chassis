/**
 * 窗口尺寸记忆（requirements §3.1「尺寸记忆」/ architecture D20）。
 *
 * 守三件事：
 *  - **清洗**：记忆值是要落盘、下次唤出直接拿来设窗口的 —— 半个尺寸、负数、脏结构
 *    必须在入口被丢掉（留一个脏数字 ⇒ 下次唤出窗口变成一个诡异尺寸，而用户不知道为什么）；
 *  - **两模式互不干扰**：`patchConfig` 是浅合并，UI 每次写回都得把整个对象给全；
 *    少给一个键就等于把另一个模式的记忆悄悄抹掉（用户："我插件页的尺寸怎么没了"）；
 *  - **先钳制再转发**：UI 算错时不能把窗口拉成 5 像素高 —— 发给壳的必须是钳制后的值。
 */
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'
import { MAX_WINDOW_HEIGHT, MAX_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, sanitizeWindowSizes } from '../../apps/kernel/src/config'

test('清洗：半个尺寸 / 越界 / 脏结构一律丢掉那一项', () => {
  assertDeepEqual(sanitizeWindowSizes(undefined), {}, '空输入 → 空记忆')
  assertDeepEqual(sanitizeWindowSizes('host'), {}, '不是对象 → 空记忆')
  assertDeepEqual(sanitizeWindowSizes({ host: { width: 900 } }), {}, '只有宽没有高 ⇒ 丢掉这一项')
  assertDeepEqual(sanitizeWindowSizes({ host: { width: 900, height: -20 } }), {}, '非法数字 ⇒ 丢掉')
  assertDeepEqual(sanitizeWindowSizes({ plugin: { width: 100, height: 100 } }), {}, '小于最小尺寸 ⇒ 丢掉')

  const clamped = sanitizeWindowSizes({ host: { width: 99999, height: 99999 } }).host
  assertEqual(clamped?.width, MAX_WINDOW_WIDTH, '过大 ⇒ 钳到上限')
  assertEqual(clamped?.height, MAX_WINDOW_HEIGHT, '高度同理')

  const kept = sanitizeWindowSizes({ host: { width: 900, height: 700 } })
  assertEqual(kept.host?.width, 900, '正常值原样留下')
  assertEqual(kept.host?.height, 700)
  assertEqual(kept.plugin, undefined, '没提到的模式不会凭空出现')
})

const h = await createHarness({ label: 'window-sizes', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

test('落盘：写一个模式不影响另一个（UI 每次写回都是整个对象）', async () => {
  await h.api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ windowSizes: { host: { width: 900, height: 700 } } }),
  })
  assertEqual(h.kernel.config.get().windowSizes.host?.width, 900, '宿主那份应当落盘')

  await h.api('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      windowSizes: { host: { width: 900, height: 700 }, plugin: { width: 1000, height: 800 } },
    }),
  })
  const sizes = h.kernel.config.get().windowSizes
  assertEqual(sizes.host?.height, 700, '写插件那份不该把宿主那份弄丢')
  assertEqual(sizes.plugin?.width, 1000, '插件页那份应当落盘')
})

test('恢复默认：清掉某个模式的记忆，另一份保留', async () => {
  await h.api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ windowSizes: { plugin: { width: 1000, height: 800 } } }),
  })
  const sizes = h.kernel.config.get().windowSizes
  assertEqual(sizes.host, undefined, '「恢复默认」把宿主那份清掉了')
  assertEqual(sizes.plugin?.width, 1000, '插件页那份不受影响')
})

test('/api/window/setSize：越界值先钳制、再转发给壳', async () => {
  shell.calls.length = 0
  const res = await h.api<{ ok: boolean; width: number; height: number }>('/api/window/setSize', {
    method: 'POST',
    body: JSON.stringify({ width: 99999, height: 10 }),
  })

  assertEqual(res.width, MAX_WINDOW_WIDTH, '返回给 UI 的也应当是钳制后的值')
  assertEqual(res.height, MIN_WINDOW_HEIGHT, '高度不能小于最小值')
  const call = shell.calls.find((item) => item.method === 'window.setSize')
  assert(call !== undefined, '内核必须把尺寸转发给壳')
  assertEqual(call?.params.width, MAX_WINDOW_WIDTH, '发给壳的必须是钳制后的宽')
  assertEqual(call?.params.height, MIN_WINDOW_HEIGHT, '发给壳的必须是钳制后的高')
})

test('/api/window/setSize：非数字直接拒绝，绝不转发脏值', async () => {
  shell.calls.length = 0
  const res = await h.api<{ ok: boolean; error?: { code: string } }>('/api/window/setSize', {
    method: 'POST',
    body: JSON.stringify({ width: '宽', height: 600 }),
  })

  assertEqual(res.ok, false, '非法参数应当报错')
  assertEqual(res.error?.code, 'BAD_ARGS', '按参数错误返回（400），不是内部错误')
  assertEqual(
    shell.calls.filter((item) => item.method === 'window.setSize').length,
    0,
    '不该把脏值发给壳',
  )
})

const failed = await run('窗口尺寸记忆')
await h.stop()
if (failed > 0) process.exit(1)
