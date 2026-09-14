import { SERVICE_CAPABILITY } from '@launcher/plugin-manifest'
import { LauncherError } from '@launcher/plugin-manifest'
import type { Disposer, KernelEvent } from './types'
import type { EventBus } from './events'
import type { KernelServices, PluginContext, ServiceKey } from './services/types'

export interface ServiceBinder {
  /** 为某个插件构造受限服务视图 */
  bind<K extends ServiceKey>(key: K, pluginId: string, sessionSid?: string): KernelServices[K]
}

export interface DisposeSink {
  register(pluginId: string, fn: Disposer, label: string): void
}

function hasCapability(caps: ReadonlySet<string>, required: string): boolean {
  if (caps.has(required)) return true
  // clipboard.read 与 clipboard.write 是两条独立能力
  return false
}

/**
 * 装配期裁剪（requirements §7.1 / P5）：
 * 只挂载插件声明且被授予的服务；未授权 → 属性不存在（不是「存在但被拒」）。
 */
export function createPluginContext(opts: {
  pluginId: string
  capabilities: ReadonlySet<string>
  services: KernelServices
  binder: ServiceBinder
  bus: EventBus
  disposeSink: DisposeSink
  onDenied?: (pluginId: string, service: string, capability: string) => void
  /** 管理面特权：仅 internal 插件由内核注入（P2「仅管理面除外」） */
  extra?: Record<string, unknown>
}): PluginContext {
  const { pluginId, capabilities, binder, bus, disposeSink } = opts

  const ctx = {
    id: pluginId,
    capabilities,
  } as PluginContext

  const define = (key: ServiceKey, requiredCapability: string | null): void => {
    if (requiredCapability && !hasCapability(capabilities, requiredCapability)) {
      opts.onDenied?.(pluginId, key, requiredCapability)
      return // 不挂载：属性不存在
    }
    try {
      Object.defineProperty(ctx, key, {
        value: binder.bind(key, pluginId),
        enumerable: true,
        configurable: true,
        writable: false,
      })
    } catch {
      /* ignore */
    }
  }

  // 无能力要求的服务
  define('storage', null)
  define('commands', null)
  define('searchResult', null)
  define('audit', null)
  define('host', null)
  define('pipeline', null)

  // 需要能力的服务（capability 名见 SERVICE_CAPABILITY）
  define('hostUi', SERVICE_CAPABILITY.hostUi ?? 'hostUi')
  define('shell', SERVICE_CAPABILITY.shell ?? 'shell.open')
  define('exec', SERVICE_CAPABILITY.exec ?? 'exec.spawn')
  define('notify', SERVICE_CAPABILITY.notify ?? 'notify.show')
  define('screenshot', SERVICE_CAPABILITY.screenshot ?? 'screenshot')
  define('quicklink', SERVICE_CAPABILITY.quicklink ?? 'quicklink')

  // 管理面特权服务（只有 internal 插件拿得到）
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    Object.defineProperty(ctx, key, { value, enumerable: true, configurable: true, writable: false })
  }

  // clipboard：read / write 分开裁剪
  const canRead = capabilities.has('clipboard.read')
  const canWrite = capabilities.has('clipboard.write')
  if (canRead || canWrite) {
    const full = binder.bind('clipboard', pluginId)
    Object.defineProperty(ctx, 'clipboard', {
      value: {
        readText: async (): Promise<string> => {
          if (!canRead) throw new LauncherError('CAPABILITY_DENIED', '未声明 clipboard.read')
          return full.readText()
        },
        writeText: async (text: string): Promise<void> => {
          if (!canWrite) throw new LauncherError('CAPABILITY_DENIED', '未声明 clipboard.write')
          return full.writeText(text)
        },
      },
      enumerable: true,
      configurable: true,
    })
  }

  const disposers: Array<() => void> = []
  let disposed = false

  Object.defineProperty(ctx, 'effect', {
    value: <T>(fn: () => T | Disposer, label: string): T => {
      if (disposed) throw new LauncherError('INTERNAL', `插件已停用，不能再注册：${label}`)
      const result = fn()
      if (typeof result === 'function') {
        const disposer = result as Disposer
        disposers.push(disposer)
        disposeSink.register(pluginId, disposer, label)
      }
      return result as T
    },
    enumerable: true,
  })

  Object.defineProperty(ctx, 'inject', {
    value: (names: ServiceKey[], fn: (ctx: PluginContext) => void | Disposer): Disposer => {
      // 硬依赖：缺任一服务，回调不执行（服务在装配期已裁剪，这里只做存在性判断）
      const missing = names.filter((n) => (ctx as unknown as Record<string, unknown>)[n] === undefined)
      if (missing.length > 0) {
        opts.onDenied?.(pluginId, missing.join(','), 'inject')
        return () => undefined
      }
      const result = fn(ctx)
      if (typeof result === 'function') {
        disposers.push(result)
        disposeSink.register(pluginId, result, `inject(${names.join(',')})`)
      }
      return () => {
        if (typeof result === 'function') result()
      }
    },
    enumerable: true,
  })

  Object.defineProperty(ctx, 'on', {
    value: (event: KernelEvent, fn: (payload: unknown) => void): Disposer => {
      const off = bus.on(event, fn)
      disposers.push(off)
      disposeSink.register(pluginId, off, `on(${event})`)
      return off
    },
    enumerable: true,
  })

  Object.defineProperty(ctx, '__disposeAll', {
    value: () => {
      disposed = true
      // 逆序回滚（P4）
      for (const fn of disposers.reverse()) {
        try {
          fn()
        } catch {
          /* 卸载路径不能因单个 disposer 失败而中断 */
        }
      }
      disposers.length = 0
    },
    enumerable: false,
  })

  return ctx
}

export function disposeContext(ctx: PluginContext): void {
  const fn = (ctx as unknown as { __disposeAll?: () => void }).__disposeAll
  if (typeof fn === 'function') fn()
}
