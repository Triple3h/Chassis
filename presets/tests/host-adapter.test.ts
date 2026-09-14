import assert from 'node:assert/strict'
import { createLauncherBridge, createSofastBridge } from '../shared/lib/host-adapter'

/**
 * 适配层单测：**两套宿主 API 的映射等价性**。
 *
 * 目标：同一段插件代码，在如快与启动台上打出来的调用语义必须一致。
 * 这里直接拿「假宿主」记录调用，不碰真 SDK、不碰浏览器。
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

/* -------------------------------------------------------- 假的「启动台 SDK」 */

const launcherCalls: Array<{ method: string; args: unknown[] }> = []
const launcherApi = {
  host: {
    isLauncher: () => true,
    info: async () => ({ pluginId: 'sofast-totp' }),
  },
  hostUi: {
    getSearchContent: async () => {
      launcherCalls.push({ method: 'hostUi.getSearchContent', args: [] })
      return 'JSON'
    },
    setSearchContent: async (value: string) => {
      launcherCalls.push({ method: 'hostUi.setSearchContent', args: [value] })
      return true
    },
    clearSearchContent: async () => {
      launcherCalls.push({ method: 'hostUi.clearSearchContent', args: [] })
      return true
    },
    setFooter: async (buttons: unknown) => {
      launcherCalls.push({ method: 'hostUi.setFooter', args: [buttons] })
      return true
    },
    watchSearchContent: (cb: (value: string) => void) => {
      launcherCalls.push({ method: 'hostUi.watchSearchContent', args: [] })
      return () => launcherCalls.push({ method: 'hostUi.watchSearchContent.off', args: [cb] })
    },
  },
  storage: {
    get: async (key: string) => {
      launcherCalls.push({ method: 'storage.get', args: [key] })
      return { from: 'launcher' }
    },
    set: async (key: string, value: unknown) => {
      launcherCalls.push({ method: 'storage.set', args: [key, value] })
    },
    remove: async (key: string) => {
      launcherCalls.push({ method: 'storage.remove', args: [key] })
    },
    all: async () => {
      launcherCalls.push({ method: 'storage.all', args: [] })
      return { a: 1 }
    },
  },
  exec: {
    run: async (payload: { command: string; args?: unknown; timeoutMs?: number }) => {
      launcherCalls.push({ method: 'exec.run', args: [payload] })
      return { ok: true }
    },
  },
  screenshot: {
    start: async () => {
      launcherCalls.push({ method: 'screenshot.start', args: [] })
      return true
    },
  },
}

/* ------------------------------------------------------------ 假的「如快 SDK」 */

const sofastCalls: Array<{ method: string; args: unknown[] }> = []
const sofastApi = {
  inSofastIframe: () => true,
  Context: {
    getSearchContent: async () => {
      sofastCalls.push({ method: 'Context.getSearchContent', args: [] })
      return 'JSON'
    },
    setSearchContent: async (value: string) => {
      sofastCalls.push({ method: 'Context.setSearchContent', args: [value] })
      return true
    },
    clearSearchContent: async () => {
      sofastCalls.push({ method: 'Context.clearSearchContent', args: [] })
      return true
    },
    setFooter: async (buttons: unknown) => {
      sofastCalls.push({ method: 'Context.setFooter', args: [buttons] })
      return true
    },
    watchSearchContent: (cb: (value: string) => void) => {
      sofastCalls.push({ method: 'Context.watchSearchContent', args: [] })
      return () => sofastCalls.push({ method: 'Context.watchSearchContent.off', args: [cb] })
    },
  },
  LocalStorage: {
    getItem: async (key: string) => {
      sofastCalls.push({ method: 'LocalStorage.getItem', args: [key] })
      return { from: 'sofast' }
    },
    setItem: async (key: string, value: unknown) => {
      sofastCalls.push({ method: 'LocalStorage.setItem', args: [key, value] })
      return undefined
    },
    removeItem: async (key: string) => {
      sofastCalls.push({ method: 'LocalStorage.removeItem', args: [key] })
      return undefined
    },
    allItems: async () => {
      sofastCalls.push({ method: 'LocalStorage.allItems', args: [] })
      return { a: 1 }
    },
  },
  Backend: {
    run: async (command: string, args?: unknown, options?: { timeoutMs?: number }) => {
      sofastCalls.push({ method: 'Backend.run', args: [command, args, options] })
      return { ok: true }
    },
  },
  Screenshot: {
    start: async () => {
      sofastCalls.push({ method: 'Screenshot.start', args: [] })
      return true
    },
  },
}

const launcher = createLauncherBridge(launcherApi)
const sofast = createSofastBridge(sofastApi)

console.log('身份与搜索框')

await test('两个桥各自带上宿主标记', () => {
  assert.equal(launcher.kind, 'launcher')
  assert.equal(sofast.kind, 'sofast')
})

await test('读搜索框：hostUi.getSearchContent ↔ Context.getSearchContent', async () => {
  assert.equal(await launcher.getSearchContent(), 'JSON')
  assert.equal(await sofast.getSearchContent(), 'JSON')
  assert.deepEqual(
    [launcherCalls.at(-1)?.method, sofastCalls.at(-1)?.method],
    ['hostUi.getSearchContent', 'Context.getSearchContent'],
  )
})

await test('写 / 清搜索框按各自命名空间转发', async () => {
  await launcher.setSearchContent('abc')
  await sofast.setSearchContent('abc')
  assert.deepEqual(launcherCalls.at(-1)?.args, ['abc'])
  assert.deepEqual(sofastCalls.at(-1)?.args, ['abc'])
  assert.equal(launcherCalls.at(-1)?.method, 'hostUi.setSearchContent')
  assert.equal(sofastCalls.at(-1)?.method, 'Context.setSearchContent')

  await launcher.clearSearchContent()
  await sofast.clearSearchContent()
  assert.equal(launcherCalls.at(-1)?.method, 'hostUi.clearSearchContent')
  assert.equal(sofastCalls.at(-1)?.method, 'Context.clearSearchContent')
})

await test('监听搜索框返回的取消函数直通宿主的 off', () => {
  const offLauncher = launcher.watchSearchContent(() => undefined)
  const offSofast = sofast.watchSearchContent(() => undefined)
  offLauncher()
  offSofast()
  assert.equal(launcherCalls.at(-1)?.method, 'hostUi.watchSearchContent.off')
  assert.equal(sofastCalls.at(-1)?.method, 'Context.watchSearchContent.off')
})

await test('footer 透传按钮数组（两个宿主都收数组）', async () => {
  const buttons = [{ type: 'button', label: '复制' }]
  await launcher.setFooter(buttons)
  await sofast.setFooter(buttons)
  assert.deepEqual(launcherCalls.at(-1)?.args, [buttons])
  assert.deepEqual(sofastCalls.at(-1)?.args, [buttons])
})

console.log('存储 / 脚本 / 截图')

await test('存储四件套映射到各自的命名空间', async () => {
  assert.deepEqual(await launcher.storage.get('accounts'), { from: 'launcher' })
  assert.deepEqual(await sofast.storage.get('accounts'), { from: 'sofast' })
  assert.equal(launcherCalls.at(-1)?.method, 'storage.get')
  assert.equal(sofastCalls.at(-1)?.method, 'LocalStorage.getItem')

  await launcher.storage.set('k', 1)
  await sofast.storage.set('k', 1)
  assert.equal(launcherCalls.at(-1)?.method, 'storage.set')
  assert.equal(sofastCalls.at(-1)?.method, 'LocalStorage.setItem')

  await launcher.storage.remove('k')
  await sofast.storage.remove('k')
  assert.equal(launcherCalls.at(-1)?.method, 'storage.remove')
  assert.equal(sofastCalls.at(-1)?.method, 'LocalStorage.removeItem')

  assert.deepEqual(await launcher.storage.all(), { a: 1 })
  assert.deepEqual(await sofast.storage.all(), { a: 1 })
  assert.equal(launcherCalls.at(-1)?.method, 'storage.all')
  assert.equal(sofastCalls.at(-1)?.method, 'LocalStorage.allItems')
})

await test('跑脚本：exec.run({command,args,timeoutMs}) ↔ Backend.run(command,args,{timeoutMs})', async () => {
  const launcherResult = await launcher.runScript('read-image', { listOnly: true }, 12_000)
  const sofastResult = await sofast.runScript('read-image', { listOnly: true }, 12_000)
  assert.deepEqual(launcherResult, { ok: true })
  assert.deepEqual(sofastResult, { ok: true })

  assert.deepEqual(launcherCalls.at(-1)?.args, [{ command: 'read-image', args: { listOnly: true }, timeoutMs: 12_000 }])
  assert.deepEqual(sofastCalls.at(-1)?.args, ['read-image', { listOnly: true }, { timeoutMs: 12_000 }])
})

await test('截图：screenshot.start ↔ Screenshot.start', async () => {
  assert.equal(await launcher.triggerScreenshot(), true)
  assert.equal(await sofast.triggerScreenshot(), true)
  assert.equal(launcherCalls.at(-1)?.method, 'screenshot.start')
  assert.equal(sofastCalls.at(-1)?.method, 'Screenshot.start')
})

console.log(`\n通过 ${passed} 项`)
