import { assertEqual, run, test } from '../helpers/assert'

/**
 * 回归：窗口拖动由 SDK 统一接管（不再由各插件在顶栏上绑 mousedown）。
 *
 * 约定：页首 `<header>`（贴视口顶部）与顶缘 8px 是拖动区，交互元素上不触发；
 * 对话框里的 `<header>`（不贴顶）不参与；自定义拖动区可用 `data-window-drag`。
 */

const received: Array<Record<string, unknown>> = []
const messageListeners: Array<(event: unknown) => void> = []
const mousedownListeners: Array<(event: unknown) => void> = []

const fakeWindow = {
  parent: {
    postMessage: (msg: unknown): void => {
      structuredClone(msg)
      received.push(msg as Record<string, unknown>)
      const id = (msg as { id?: number }).id
      setTimeout(() => {
        for (const fn of messageListeners) fn({ data: { __launcher: 1, id, ok: true, result: null } })
      }, 0)
    },
  },
  addEventListener: (type: string, fn: (event: unknown) => void): void => {
    if (type === 'message') messageListeners.push(fn)
    if (type === 'mousedown') mousedownListeners.push(fn)
  },
  setTimeout,
  clearTimeout,
}

const globals = globalThis as Record<string, unknown>
globals.window = fakeWindow
globals.location = { search: '?sid=test-sid&token=test-token' }

await import('../../packages/plugin-api/src/index')

interface NodeOptions {
  /** 匹配 button / input / a / [role=button] 等交互元素 */
  interactive?: boolean
  /** `header` 距视口顶部的位置；不传 = 页面没有 header */
  headerTop?: number
  /** 带 `data-window-drag` 的自定义拖动区 */
  dragMarker?: boolean
}

function node(options: NodeOptions = {}) {
  return {
    closest(selector: string): unknown {
      if (selector.includes('button') && options.interactive) return this
      if (selector === '[data-window-drag]') return options.dragMarker ? this : null
      if (selector === 'header' && options.headerTop !== undefined) {
        return { getBoundingClientRect: () => ({ top: options.headerTop }) }
      }
      return null
    },
  }
}

function press(options: NodeOptions & { y?: number; button?: number } = {}) {
  const event = {
    button: options.button ?? 0,
    target: node(options),
    clientY: options.y ?? 20,
    defaultPrevented: false,
    preventDefault(): void {
      event.defaultPrevented = true
    },
  }
  for (const fn of mousedownListeners) fn(event)
  return event
}

function dragCalls(): number {
  return received.filter((message) => message.method === 'ctx.window.startDrag').length
}

test('顶栏空白处按下 ⇒ 拖窗', () => {
  const event = press({ headerTop: 0 })
  assertEqual(dragCalls(), 1, '页首 header 应当触发 startDrag')
  assertEqual(event.defaultPrevented, true, '拖窗时应当 preventDefault（不选文字、不抢焦点）')
})

test('顶栏按钮 / 输入框上按下 ⇒ 不拖窗', () => {
  press({ headerTop: 0, interactive: true })
  assertEqual(dragCalls(), 1, '交互元素上不应当触发拖动')
})

test('对话框里的 header（不贴顶）不参与拖动', () => {
  press({ headerTop: 120 })
  assertEqual(dragCalls(), 1, '非页首 header 不应当触发拖动')
})

test('没有 header 时，顶缘 8px 内仍可拖窗', () => {
  press({ y: 8 })
  assertEqual(dragCalls(), 2, '无标题栏页面应当保留顶缘热区')
})

test('没有 header 且不在顶缘 ⇒ 不拖窗', () => {
  press({ y: 9 })
  assertEqual(dragCalls(), 2, '顶缘之外不应当触发拖动')
})

test('data-window-drag 标记的任意区域 ⇒ 拖窗', () => {
  press({ y: 200, dragMarker: true })
  assertEqual(dragCalls(), 3, '自定义拖动区应当生效')
})

test('右键不触发拖动', () => {
  press({ headerTop: 0, button: 2 })
  assertEqual(dragCalls(), 3, '只有左键触发拖动')
})

const failed = await run('插件 SDK · 窗口拖动')
if (failed > 0) process.exit(1)
