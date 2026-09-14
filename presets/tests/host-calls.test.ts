import assert from 'node:assert/strict'
import { HOST_TIMEOUT, createHostCalls } from '../shared/lib/host-calls'
import type { HostBridge } from '../shared/lib/host-adapter'

/**
 * 适配层单测：**宿主无关的公共语义**（超时 / 哨兵值 / localStorage 兜底）。
 *
 * 这层逻辑对两个宿主必须逐字相同，是「如快侧零回归」的最后一道闸：
 * 改这里之前先想清楚，如快侧的边缘行为会不会跟着变。
 *
 * 不依赖浏览器、不依赖真 SDK：桥是假的，`localStorage` 是内存实现。
 */

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.stack : err)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ 假宿主 */

interface Recorded {
  method: string
  args: unknown[]
}

function makeBridge(patch: Partial<HostBridge> = {}) {
  const seen: Recorded[] = []
  const listeners: Array<(value: string) => void> = []
  let offCalls = 0

  const bridge: HostBridge = {
    kind: 'launcher',
    async getSearchContent() {
      seen.push({ method: 'getSearchContent', args: [] })
      return 'QUERY'
    },
    async setSearchContent(value) {
      seen.push({ method: 'setSearchContent', args: [value] })
      return true
    },
    async clearSearchContent() {
      seen.push({ method: 'clearSearchContent', args: [] })
      return true
    },
    watchSearchContent(cb) {
      seen.push({ method: 'watchSearchContent', args: [] })
      listeners.push(cb)
      return () => {
        offCalls++
      }
    },
    async setFooter(buttons) {
      seen.push({ method: 'setFooter', args: [buttons] })
      return true
    },
    async triggerScreenshot() {
      seen.push({ method: 'triggerScreenshot', args: [] })
      return true
    },
    async runScript(command, args, timeoutMs) {
      seen.push({ method: 'runScript', args: [command, args, timeoutMs] })
      return { ok: true }
    },
    storage: {
      async get(key) {
        seen.push({ method: 'storage.get', args: [key] })
        return { stored: key }
      },
      async set(key, value) {
        seen.push({ method: 'storage.set', args: [key, value] })
        return undefined
      },
      async remove(key) {
        seen.push({ method: 'storage.remove', args: [key] })
        return undefined
      },
      async all() {
        seen.push({ method: 'storage.all', args: [] })
        return { a: 1, b: 2 }
      },
    },
    ...patch,
  }

  return { bridge, seen, listeners, offCalls: () => offCalls }
}

class MemoryStorage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.map)
  }
}

function installLocalStorage(): MemoryStorage {
  const store = new MemoryStorage()
  ;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = store
  return store
}

const hangs = <T,>(): Promise<T> => new Promise<T>(() => {})

/* ------------------------------------------------------------------ 用例 */

console.log('宿主探测结果')

await test('没有宿主：inHost() 为 false，取内容回落到空串', async () => {
  const calls = createHostCalls(async () => null)
  assert.equal(await calls.inHost(), false)
  assert.equal(await calls.getSearchContent(), '')
})

await test('探测抛错时按「没有宿主」处理，不把异常抛给插件', async () => {
  const calls = createHostCalls(async () => {
    throw new Error('probe exploded')
  })
  assert.equal(await calls.inHost(), false)
  assert.equal(await calls.getSearchContent(), '')
})

console.log('搜索框')

await test('getSearchContent 透传宿主内容', async () => {
  const { bridge, seen } = makeBridge()
  const calls = createHostCalls(async () => bridge)
  assert.equal(await calls.getSearchContent(), 'QUERY')
  assert.deepEqual(seen[0], { method: 'getSearchContent', args: [] })
})

await test(`宿主不应答时 getSearchContent 在 ${HOST_TIMEOUT.context}ms 后回落空串`, async () => {
  const { bridge } = makeBridge({ getSearchContent: hangs })
  const calls = createHostCalls(async () => bridge)
  const started = Date.now()
  assert.equal(await calls.getSearchContent(), '')
  assert.ok(Date.now() - started >= HOST_TIMEOUT.context - 20, '应当等到超时')
})

await test('setSearchContent / clearSearchContent 透传参数', async () => {
  const { bridge, seen } = makeBridge()
  const calls = createHostCalls(async () => bridge)
  await calls.setSearchContent('hello')
  await calls.clearSearchContent()
  assert.deepEqual(seen[0].args, ['hello'])
  assert.equal(seen[1].method, 'clearSearchContent')
})

await test('watchSearchContent 订阅宿主，取消时调用宿主的 off', async () => {
  const { bridge, listeners, offCalls } = makeBridge()
  const calls = createHostCalls(async () => bridge)
  const received: string[] = []
  const off = calls.watchSearchContent((value) => received.push(value))
  await Promise.resolve() // 等异步订阅落地
  await Promise.resolve()
  listeners.forEach((fn) => fn('typed'))
  assert.deepEqual(received, ['typed'])
  assert.equal(offCalls(), 0)
  off()
  assert.equal(offCalls(), 1)
})

await test('无宿主时 watchSearchContent 是空操作，取消也不报错', async () => {
  const calls = createHostCalls(async () => null)
  const off = calls.watchSearchContent(() => {
    throw new Error('不该被调用')
  })
  off()
})

console.log('footer / 截图 / 脚本')

await test('setFooter 透传按钮并返回宿主结果', async () => {
  const { bridge, seen } = makeBridge()
  const calls = createHostCalls(async () => bridge)
  const buttons = [{ type: 'button', label: '复制' }]
  assert.equal(await calls.setFooter(buttons), true)
  assert.deepEqual(seen[0].args[0], buttons)
})

await test(`宿主不应答时 setFooter 在 ${HOST_TIMEOUT.action}ms 后返回 false`, async () => {
  const { bridge } = makeBridge({ setFooter: hangs })
  const calls = createHostCalls(async () => bridge)
  assert.equal(await calls.setFooter([]), false)
})

await test('triggerScreenshot 透传并沿用 8s 长超时', async () => {
  const { bridge, seen } = makeBridge()
  const calls = createHostCalls(async () => bridge)
  assert.equal(await calls.triggerScreenshot(), true)
  assert.equal(seen[0].method, 'triggerScreenshot')
})

await test('runScript 透传命令 / 参数 / 超时，并原样返回脚本结果', async () => {
  const { bridge, seen } = makeBridge()
  const calls = createHostCalls(async () => bridge)
  const result = await calls.runScript<{ ok: boolean }>('read-image', { listOnly: true }, 12_000)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(seen[0], { method: 'runScript', args: ['read-image', { listOnly: true }, 12_000] })
})

await test('runScript 默认超时 10s；脚本报错时回落 null 而不是抛出', async () => {
  const ok = makeBridge()
  const calls = createHostCalls(async () => ok.bridge)
  await calls.runScript('hosts-read')
  assert.equal(ok.seen[0].args[2], 10_000)

  const failing = makeBridge({
    runScript: async () => {
      return null
    },
  })
  const calls2 = createHostCalls(async () => failing.bridge)
  assert.equal(await calls2.runScript('hosts-write'), null)

  const throwing = createHostCalls(async () => {
    throw new Error('bridge down')
  })
  assert.equal(await throwing.runScript('hosts-write'), null)
})

console.log('存储')

await test('宿主可用时 storage 读写全部透传，且不写 localStorage', async () => {
  const local = installLocalStorage()
  const { bridge, seen } = makeBridge()
  const calls = createHostCalls(async () => bridge)

  assert.deepEqual(await calls.storage.get('k'), { stored: 'k' })
  await calls.storage.set('k', { v: 1 })
  await calls.storage.remove('k')
  assert.deepEqual(await calls.storage.all(), { a: 1, b: 2 })

  assert.deepEqual(
    seen.map((item) => item.method),
    ['storage.get', 'storage.set', 'storage.remove', 'storage.all'],
  )
  assert.deepEqual(local.dump(), {}, '宿主可用时不该碰 localStorage（避免双写）')
})

await test('宿主可用但没有这个键：返回 undefined，也不去读 localStorage', async () => {
  const local = installLocalStorage()
  local.setItem('sof:k', JSON.stringify('旧数据'))
  const { bridge } = makeBridge({ storage: { ...makeBridge().bridge.storage, get: async () => undefined } })
  const calls = createHostCalls(async () => bridge)
  assert.equal(await calls.storage.get('k'), undefined)
})

await test('无宿主：storage 退回 localStorage（前缀 sof:）', async () => {
  const local = installLocalStorage()
  const calls = createHostCalls(async () => null)

  await calls.storage.set('accounts', [{ id: 1 }])
  assert.deepEqual(local.dump(), { 'sof:accounts': '[{"id":1}]' })
  assert.deepEqual(await calls.storage.get('accounts'), [{ id: 1 }])
  assert.deepEqual(await calls.storage.all(), { accounts: [{ id: 1 }] })

  await calls.storage.remove('accounts')
  assert.deepEqual(local.dump(), {})
  assert.equal(await calls.storage.get('accounts'), undefined)
})

await test('宿主存在但不应答：storage 超时后同样退回 localStorage', async () => {
  const local = installLocalStorage()
  local.setItem('sof:settings', JSON.stringify({ theme: 'dark' }))
  const { bridge } = makeBridge({ storage: { ...makeBridge().bridge.storage, get: hangs } })
  const calls = createHostCalls(async () => bridge)
  // 探针/读取超时后仍要能读到本地兜底数据，否则开发环境会「数据凭空消失」
  assert.deepEqual(await calls.storage.get('settings'), { theme: 'dark' })
})

console.log(`\n通过 ${passed} 项`)
