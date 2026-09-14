import { assert, assertEqual, run, test } from '../helpers/assert'
import { createPluginContext } from '../../apps/kernel/src/context'
import { EventBus } from '../../apps/kernel/src/events'
import type { ServiceBinder } from '../../apps/kernel/src/context'
import type { KernelServices, ServiceKey } from '../../apps/kernel/src/services/types'

const noop = async (): Promise<undefined> => undefined

function fakeServices(): KernelServices {
  return {
    storage: { get: noop, set: noop, remove: noop, all: noop, clear: noop },
    commands: { register: () => () => undefined, update: () => undefined, list: () => [], invoke: noop },
    searchResult: { set: () => undefined, append: () => undefined, clear: () => undefined },
    hostUi: {
      getSearchContent: async () => '',
      setSearchContent: async () => true,
      clearSearchContent: async () => true,
      setFooter: async () => true,
      hide: noop,
    },
    clipboard: { readText: async () => '', writeText: noop },
    shell: { openUrl: noop, openPath: noop, reveal: noop },
    exec: { run: noop },
    notify: { show: async () => true },
    screenshot: { start: async () => true },
    quicklink: { all: noop, add: noop, edit: noop, remove: noop },
    audit: { record: () => undefined, query: () => [] },
    pipeline: { use: () => () => undefined },
    host: { info: () => ({ version: 'test', platform: 'darwin', dataRoot: '/tmp', pluginId: '', command: '', sid: '' }) },
  } as unknown as KernelServices
}

function makeContext(capabilities: string[]) {
  const denied: Array<{ service: string; capability: string }> = []
  const ctx = createPluginContext({
    pluginId: 'demo',
    capabilities: new Set(capabilities),
    services: fakeServices(),
    binder: { bind: (key: ServiceKey) => fakeServices()[key] } as unknown as ServiceBinder,
    bus: new EventBus(),
    disposeSink: { register: () => undefined },
    onDenied: (_pluginId, service, capability) => denied.push({ service, capability }),
  })
  return { ctx, denied }
}

test('未声明的能力：属性不存在（不是「存在但被拒」）', () => {
  const { ctx, denied } = makeContext(['storage'])
  assertEqual(typeof ctx.storage, 'object')
  assert(!('shell' in ctx), 'shell 不应存在')
  assert(!('exec' in ctx), 'exec 不应存在')
  assert(!('notify' in ctx), 'notify 不应存在')
  assert(!Object.keys(ctx).includes('clipboard'), 'clipboard 不应出现在 Object.keys')
  assert(denied.length > 0, '应记录装配期裁剪的审计')
})

test('clipboard.read / clipboard.write 分开裁剪', () => {
  const readOnly = makeContext(['clipboard.read']).ctx
  assert('clipboard' in readOnly, '只声明 read 时 clipboard 应存在')
  assertEqual(typeof readOnly.clipboard?.readText, 'function')
  assertEqual(typeof readOnly.clipboard?.writeText, 'function')

  const writeOnly = makeContext(['clipboard.write']).ctx
  assert('clipboard' in writeOnly, '只声明 write 时 clipboard 应存在')
})

test('inject 硬依赖缺失时不激活；effect 返回的 disposer 逆序回滚', () => {
  const { ctx } = makeContext([])
  let activated = false
  ctx.inject(['shell'], () => {
    activated = true
  })
  assertEqual(activated, false, '缺服务时 inject 回调不应执行')

  const order: string[] = []
  ctx.effect(() => () => order.push('first'), 'first')
  ctx.effect(() => () => order.push('second'), 'second')
  ;(ctx as unknown as { __disposeAll: () => void }).__disposeAll()
  assertEqual(order.join(','), 'second,first', '应当逆序回滚（P4）')
})

test('管理面特权服务只由内核注入（extra）', () => {
  const withExtra = createPluginContext({
    pluginId: 'internal-settings',
    capabilities: new Set(['hostUi']),
    services: fakeServices(),
    binder: { bind: (key: ServiceKey) => fakeServices()[key] } as unknown as ServiceBinder,
    bus: new EventBus(),
    disposeSink: { register: () => undefined },
    extra: { settings: { get: () => 'ok' } },
  })
  assert('settings' in withExtra, 'internal 插件应当拿到 settings')
  const plain = makeContext(['hostUi']).ctx
  assert(!('settings' in plain), '普通插件不应拿到 settings')
})

const failed = await run('Context 装配期裁剪')
if (failed > 0) process.exit(1)
