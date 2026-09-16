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
 * 后半段（内核侧收口）守的是另一件事：**隐藏要多绕一圈，而且这一圈以回执收尾**。
 * 内核先把 `shell/visibility(false)` 广播出去让 UI 播离场动画，**等 UI 回执
 * 「最后一帧画出来了」（`/api/window/hidden`）才真去敲壳**。多出来的这一圈带出两个风险：
 *   ① 回执一直不来（UI 没了 / SSE 断了）—— 必须有兜底（`HIDE_FALLBACK_MS`）把窗口收掉；
 *   ② 动画还没演完用户又按了热键 —— 排队中的那次隐藏必须自己作废（连迟到的回执也不能把窗口偷走）。
 *
 * 为什么不能像以前那样「隔固定时长落地」：那段时长要同时盖住「IPC + SSE + webview 取事件」
 * 的不可控延迟和 140ms 的淡出，一旦被砍在中间，webview 就把半透明的一帧留成"最后一帧"，
 * 下次唤出先亮它 —— 用户看到「闪一下，像打开了两次」。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'
import { HIDE_FALLBACK_MS, SHOW_ANIMATION_MS } from '../../apps/kernel/src/kernel'

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

test('window/toggled(visible=false) 先广播、不落地；等到 UI 回执才隐藏（且只隐藏一次）', async () => {
  shell.sent.length = 0
  shell.notify('window/toggled', { visible: false })
  await sleep(150)
  assertEqual(
    shell.sent.length,
    0,
    `内核只能先广播：回执没来就落地会把淡出砍在中间（旧画面留在窗口里 = 下次唤出闪一下），实际发出：${shell.sent.join(', ')}`,
  )
  await h.api('/api/window/hidden', { method: 'POST', body: JSON.stringify({ opacity: 0, elapsedMs: 150 }) })
  await shell.waitFor('window.hide')
  assertEqual(shell.sent.filter((m) => m === 'window.hide').length, 1, '一次隐藏应当且只应当落地一次')
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

test('失焦隐藏先广播、等回执；回执之前绝不落地', async () => {
  await h.kernel.config.patch({ hideOnBlur: true })
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await sleep(150)
  assert(
    !shell.sent.includes('window.hide'),
    `UI 还没回执就落地会把淡出砍在中间（半透明的一帧留在窗口里 = 下次唤出闪一下），实际发出：${shell.sent.join(', ')}`,
  )
  await h.api('/api/window/hidden', { method: 'POST', body: JSON.stringify({ opacity: 0, elapsedMs: 150 }) })
  await shell.waitFor('window.hide')
  assertEqual(shell.sent.filter((m) => m === 'window.hide').length, 1, '一场离场应当且只应当隐藏一次')
})

test('离场动画途中重新唤出：排队中的隐藏必须作废（迟到的回执也不能把窗口偷走）', async () => {
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await sleep(80)
  // 用户又按了一次热键（壳已经显示，这里只是把结果报给内核）
  shell.notify('window/toggled', { visible: true })
  await sleep(60)
  // UI 那次「离场演完了」的回执照旧发出来，但它属于已经被撤销的那一次隐藏
  await h.api('/api/window/hidden', { method: 'POST', body: JSON.stringify({ opacity: 0, elapsedMs: 140 }) })
  await sleep(HIDE_FALLBACK_MS + 120)
  assertEqual(
    shell.sent.filter((m) => m === 'window.hide').length,
    0,
    `重新唤出后不该再把窗口藏回去（热键连按会被偷走窗口），实际发出：${shell.sent.join(', ') || '无'}`,
  )
})

/**
 * 回执不能是唯一的路：UI 没了 / SSE 断了 / 回执丢了，窗口也必须收得掉 ——
 * 「按了热键窗口消失不了」比「闪一下」严重得多。
 */
test('回执一直不来时，兜底时长到点也要落地（且只落地一次）', async () => {
  shell.sent.length = 0
  shell.notify('window/blurred', {})
  await shell.waitFor('window.hide', HIDE_FALLBACK_MS + 900)
  assertEqual(shell.sent.filter((m) => m === 'window.hide').length, 1, '兜底到点应当且只应当隐藏一次')
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

/**
 * 显示广播**不能立刻发**。
 *
 * 壳的 `show()` 返回 ≠ 窗口已经上屏、webview 已经恢复绘制；而 CSS 的时间线不会等，
 * 立刻广播就会让 UI 的入场动画在窗口还没有画面时播完（实测反馈：动效好像没实现）。
 * 这条守的是「晚一点广播」，不是具体数值 —— 数值由 SHOW_ANIMATION_MS 决定。
 */
test('显示广播要等窗口上屏：晚一点才发 visible=true', async () => {
  const seen = recordVisibility()
  shell.notify('window/toggled', { visible: true })
  await sleep(Math.floor(SHOW_ANIMATION_MS / 2))
  assertEqual(
    seen.seen.length,
    0,
    `窗口还没上屏就不该广播可见（否则入场动画会被吞掉），实际广播了 ${seen.seen.length} 次`,
  )
  await sleep(Math.floor(SHOW_ANIMATION_MS / 2) + 60)
  seen.stop()
  assertEqual(seen.seen[seen.seen.length - 1], true, '晚一点必须补上 visible=true')
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

/**
 * 显示这条路也要「回报」，只是方向反过来：**敲壳失败也绝不能吞掉广播**。
 *
 * 漏报的后果不是少一次动画，而是 UI 停在 `opacity: 0` —— 那是一块透明窗口，
 * 用户会以为启动台压根没打开（比"没有动效"严重得多）。所以 `showWindowAnimated`
 * 把广播放在 `finally` 里：显示这条路径只加不减。
 */
test('敲壳唤出失败（壳没连上）时，仍必须广播 visible=true', async () => {
  const bare = await createHarness({ label: 'no-shell-show' })
  try {
    const seen: Array<boolean | undefined> = []
    const off = bare.kernel.bus.on('shell/visibility', (payload) => {
      seen.push((payload as { visible?: boolean } | undefined)?.visible)
    })
    await bare.kernel.showWindowAnimated(true).catch(() => undefined)
    off()
    assertEqual(seen.length, 1, `敲壳失败也要广播一次，实际广播了 ${seen.length} 次`)
    assertEqual(seen[0], true, '广播必须是 visible=true，否则 UI 会停在透明态')
  } finally {
    await bare.stop()
  }
})

const failed = await run('壳 ↔ 内核 通知契约')
await h.stop()
if (failed > 0) process.exit(1)
