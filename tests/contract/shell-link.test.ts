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
 *
 * 后半段（内核侧收口）守的是另一件事：**隐藏要多绕一圈**。
 * 内核先把 `shell/visibility(false)` 广播出去让 UI 播离场动画，隔 `HIDE_ANIMATION_MS`
 * 才真去敲壳。多出来的这一圈带出一个新风险 —— 动画还没演完用户又按了热键，
 * 排队中的那次隐藏必须自己作废，否则窗口会在重新唤出后又被偷走。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'
import { HIDE_ANIMATION_MS } from '../../apps/kernel/src/kernel'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const h = await createHarness({ label: 'shell-link', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

/** 收一份内核广播出来的可见性序列 */
function recordVisibility(): { seen: Array<boolean | undefined>; stop: () => void } {
  const seen: Array<boolean | undefined> = []
  const off = h.kernel.bus.on('shell/visibility', (payload) => {
    seen.push((payload as { visible?: boolean } | undefined)?.visible)
  })
  return { seen, stop: off }
}

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

// ── 离场动画：隐藏要「先广播、演完再走」────────────────────────

test('失焦隐藏先给 UI 留出离场时间，再真正隐藏（且只隐藏一次）', async () => {
  await h.kernel.config.patch({ hideOnBlur: true })
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await sleep(Math.floor(HIDE_ANIMATION_MS / 2))
  assert(
    !shell.sent.includes('window.hide'),
    `内核应当先广播可见性、等 UI 播完离场动画，实际在动画途中就发了：${shell.sent.join(', ')}`,
  )
  await shell.waitFor('window.hide')
  assertEqual(shell.sent.filter((m) => m === 'window.hide').length, 1, '一场离场应当且只应当隐藏一次')
})

test('离场动画途中重新唤出：排队中的隐藏必须作废', async () => {
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await sleep(Math.floor(HIDE_ANIMATION_MS / 2))
  // 用户又按了一次热键（壳已经显示，这里只是把结果报给内核）
  shell.notify('window/toggled', { visible: true })
  await sleep(HIDE_ANIMATION_MS * 3)
  assertEqual(
    shell.sent.filter((m) => m === 'window.hide').length,
    0,
    `重新唤出后不该再把窗口藏回去（热键连按会被偷走窗口），实际发出：${shell.sent.join(', ') || '无'}`,
  )
})

test('hide 与 show 都广播可见性（UI 的弹窗动效靠它触发）', async () => {
  const shown = recordVisibility()
  await h.api('/api/window/show', { method: 'POST' })
  shown.stop()
  assertEqual(shown.seen.length, 1, `内核自己唤出窗口也要广播，实际广播了 ${shown.seen.length} 次`)
  assertEqual(shown.seen[0], true, '内核唤出时必须广播 visible=true，否则 UI 会停在透明态')

  shell.sent.length = 0
  const hidden = recordVisibility()
  await h.api('/api/window/hide', { method: 'POST' })
  hidden.stop()
  assertEqual(hidden.seen.length, 1, `隐藏前必须先广播一次，实际 ${hidden.seen.length} 次`)
  assertEqual(hidden.seen[0], false, '隐藏时必须广播 visible=false')
})

test('/api/window/visible 如实回答窗口当前是否可见', async () => {
  const res = await h.api<{ ok: boolean; visible: boolean | null }>('/api/window/visible')
  assertEqual(res.visible, true, '假壳固定回答可见，UI 靠它校正启动时的状态')
})

/**
 * 「问不到壳」必须和「窗口不可见」区分开。
 *
 * 这一条是实测抓出来的：`isVisible()` 原本把请求异常吞成 `false`，
 * standalone（`pnpm dev` / 浏览器开发）下没有壳，于是 UI 每次启动都得出「窗口是隐藏的」，
 * 把整个界面设成 opacity 0 —— 浏览器里开发启动台直接白屏，且现象完全不指向根因。
 */
test('没有壳时 /api/window/visible 必须回答 null，不能退化成 false', async () => {
  const bare = await createHarness({ label: 'no-shell' })
  try {
    const res = await bare.api<{ ok: boolean; visible: boolean | null }>('/api/window/visible')
    assertEqual(
      res.visible,
      null,
      `问不到壳时要回答 null（UI 据此保持可见），实际：${JSON.stringify(res.visible)}`,
    )
  } finally {
    await bare.stop()
  }
})

const failed = await run('壳 ↔ 内核 通知契约')
await h.stop()
if (failed > 0) process.exit(1)
