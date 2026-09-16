import { assert, assertEqual, run, test } from '../helpers/assert'

/**
 * 回归：Vue 的 reactive 是 Proxy，而 `postMessage` 按结构化克隆传输 ⇒ 抛 DataCloneError，
 * 消息根本发不出去（现象：调用静默超时、宿主侧毫无记录、界面看起来"点了没反应"）。
 *
 * 这里用一个会做 `structuredClone` 校验的假 parent 复现该行为（Node 与浏览器同为 V8/结构化克隆语义），
 * 断言 SDK 会 JSON 展平后重发一次，参数内容不丢。
 */

const received: Array<Record<string, unknown>> = []
const listeners: Array<(event: unknown) => void> = []

const fakeWindow = {
  parent: {
    postMessage: (msg: unknown): void => {
      // 模拟浏览器：含 Proxy 的 payload 会在这里抛 DataCloneError
      structuredClone(msg)
      received.push(msg as Record<string, unknown>)
      // 模拟宿主回包（否则 SDK 会等到默认超时）
      const id = (msg as { id?: number }).id
      setTimeout(() => {
        for (const fn of listeners) fn({ data: { __launcher: 1, id, ok: true, result: null } })
      }, 0)
    },
  },
  addEventListener: (type: string, fn: (event: unknown) => void): void => {
    if (type === 'message') listeners.push(fn)
  },
  setTimeout,
  clearTimeout,
}

const globals = globalThis as Record<string, unknown>
globals.window = fakeWindow
globals.location = { search: '?sid=test-sid&token=test-token' }

const { storage } = await import('../../packages/plugin-api/src/index')

test('reactive(Proxy) 参数也能送达宿主：SDK 自动展平，内容不丢', async () => {
  const proxyList = [new Proxy({ id: 'a1', name: '内网', counter: 3 }, {})]
  await storage.set('accounts', proxyList)

  assertEqual(received.length, 1, '应当成功发出一次 postMessage')
  const msg = received[0] as { method?: string; params?: { key?: string; value?: Array<{ name?: string }> } }
  assertEqual(msg.method, 'ctx.storage.set')
  assertEqual(msg.params?.key, 'accounts')
  assertEqual(msg.params?.value?.[0]?.name, '内网', 'JSON 展平后内容应保留')
  assert(msg.params?.value?.[0] !== proxyList[0], '发给宿主的应当是展平后的普通对象')
})

const failed = await run('插件 SDK 桥')
if (failed > 0) process.exit(1)
