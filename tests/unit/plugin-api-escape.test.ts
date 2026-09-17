import { assert, assertEqual, run, test } from '../helpers/assert'

/**
 * 回归：插件页里的 `Esc` 必须交还宿主（「在插件页里按 Esc 退回启动台」）。
 *
 * iframe 是独立文档，宿主挂在顶层 window 上的键盘监听收不到插件页里的按键 —— 由 SDK 兜底：
 * **没人消费**的 Esc 变成一次 `commands.close()`（宿主按 `session/closed{reason:'ui'}` 收尾）。
 * 这里用假 window 复现三种情形：无人消费（转发）/ `preventDefault`（不退）/ `stopPropagation`（不退）。
 *
 * 「消费」判定必须等事件派发结束（microtask）再读：SDK 的监听注册得比插件自己的 handler 早，
 * 当场读 `defaultPrevented` 永远是 false。
 */

const received: Array<Record<string, unknown>> = []
const messageListeners: Array<(event: unknown) => void> = []
const keydownListeners: Array<(event: { key: string; defaultPrevented: boolean; cancelBubble: boolean }) => void> = []

const fakeWindow = {
  parent: {
    postMessage: (msg: unknown): void => {
      // 模拟浏览器：结构化克隆发不出去的东西会在这里抛错
      structuredClone(msg)
      received.push(msg as Record<string, unknown>)
      const id = (msg as { id?: number }).id
      setTimeout(() => {
        for (const fn of messageListeners) fn({ data: { __launcher: 1, id, ok: true, result: null } })
      }, 0)
    },
  },
  addEventListener: (type: string, fn: (event: unknown) => void): void => {
    if (type === 'message') messageListeners.push(fn as (event: unknown) => void)
    if (type === 'keydown') keydownListeners.push(fn as (typeof keydownListeners)[number])
  },
  setTimeout,
  clearTimeout,
}

const globals = globalThis as Record<string, unknown>
globals.window = fakeWindow
globals.location = { search: '?sid=test-sid&token=test-token' }

await import('../../packages/plugin-api/src/index')

/**
 * 派发一次按键。`consume` 模拟插件自己的 handler 是否认领了这次 Esc ——
 * 认领的两种写法都算（SDK 读的就是 `defaultPrevented` / `cancelBubble`）。
 */
async function press(consume: 'none' | 'prevent' | 'stop' | 'other-key'): Promise<void> {
  assert(keydownListeners.length > 0, 'SDK 应当注册了 keydown 监听')
  const event = { key: consume === 'other-key' ? 'Enter' : 'Escape', defaultPrevented: false, cancelBubble: false }
  for (const fn of keydownListeners) fn(event)
  if (consume === 'prevent') event.defaultPrevented = true
  if (consume === 'stop') event.cancelBubble = true
  // 等 microtask 里的判定跑完
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function closeCalls(): number {
  return received.filter((m) => m.method === 'ctx.commands.close').length
}

test('没人消费 Esc ⇒ SDK 交还宿主（一次 commands.close）', async () => {
  await press('none')
  assertEqual(closeCalls(), 1, 'Esc 应当变成一次 ctx.commands.close')
})

test('插件 preventDefault 了 Esc ⇒ 不退（清空搜索词这类消费）', async () => {
  await press('prevent')
  assertEqual(closeCalls(), 1, '消费过的 Esc 不应再关会话')
})

test('插件 stopPropagation 了 Esc ⇒ 不退（UiDialog 那类弹层）', async () => {
  await press('stop')
  assertEqual(closeCalls(), 1, 'stopPropagation 同样算消费')
})

test('其他按键不触发退出', async () => {
  await press('other-key')
  assertEqual(closeCalls(), 1, '只有 Esc 会交还宿主')
})

const failed = await run('插件 SDK · Esc 交还')
if (failed > 0) process.exit(1)
