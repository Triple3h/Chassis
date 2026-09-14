/**
 * 壳 ↔ 内核 通知契约（requirements §4.1 / §6.2）。
 *
 * 这里守的是一条**边界不变量**：窗口显隐的裁决者只有壳一处，内核只广播状态、绝不自行切换。
 *
 * 为什么值得单独一条测试：这个 bug 在两边各自的源码里都看不出问题 ——
 * 壳 `toggle` 写了显示/隐藏，内核 `hotkey/pressed` 也写了一版 `isVisible → hide/show`。
 * 合在一起就是"一次热键被 toggle 两遍"：壳刚显示 → 内核立刻隐藏，
 * 表现是**按热键窗口闪一下就消失，而托盘左键完全正常**（托盘不经过内核）。
 * 只有站在壳那一侧观察内核越界发了什么，才抓得住。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const h = await createHarness({ label: 'shell-link', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

test('壳通知 window/toggled(visible) 后，内核不得再自行切换显隐', async () => {
  shell.sent.length = 0
  shell.notify('window/toggled', { visible: true })
  await sleep(150)
  assert(
    !shell.sent.includes('window.hide'),
    `内核不应自行隐藏窗口（否则热键唤出会被立刻撤销），实际发出：${shell.sent.join(', ') || '无'}`,
  )
})

test('window/toggled 不应引发任何壳侧调用（纯广播）', async () => {
  shell.sent.length = 0
  shell.notify('window/toggled', { visible: false })
  await sleep(150)
  assertEqual(shell.sent.length, 0, `内核只该广播状态，实际发出：${shell.sent.join(', ')}`)
})

test('失焦仍是内核的职责：壳通知 window/blurred 时按 hideOnBlur 隐藏', async () => {
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await shell.waitFor('window.hide')
  assertEqual(shell.sent.filter((m) => m === 'window.hide').length, 1, '失焦应当且只应当隐藏一次')
})

test('hideOnBlur=false 时，壳通知失焦也不隐藏', async () => {
  await h.kernel.config.patch({ hideOnBlur: false })
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await sleep(150)
  assertEqual(shell.sent.length, 0, `关掉失焦隐藏后不应有壳侧调用，实际：${shell.sent.join(', ')}`)
})

const failed = await run('壳 ↔ 内核 通知契约')
await h.stop()
if (failed > 0) process.exit(1)
