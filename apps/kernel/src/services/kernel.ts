import type { ActionResult, AuditRecord, CommandDecl, HostInfo, ResultItem } from '@launcher/plugin-manifest'
import { LauncherError } from '@launcher/plugin-manifest'
import type { AuditLog } from '../audit'
import type { EventBus } from '../events'
import type { Pipeline } from '../pipeline'
import type { CommandRegistry, SearchResultHub } from '../registry'
import type { Middleware, MiddlewareStage, Session } from '../types'
import type { ServiceBinder } from '../context'
import type {
  AuditService,
  CommandRegistryService,
  HostService,
  KernelServices,
  PipelineService,
  SearchResultService,
  ServiceKey,
} from './types'
import type { HostUiBridge } from './hostUi'
import type { PluginStorage } from './storage'
import type { Primitives } from './shell'
import type { QuicklinkStore } from './quicklink'
import type { ScriptRuntime } from './exec'

export interface KernelServiceDeps {
  version: string
  dataRoot: string
  audit: AuditLog
  bus: EventBus
  registry: CommandRegistry
  hub: SearchResultHub
  pipeline: Pipeline
  storage: PluginStorage
  primitives: Primitives
  hostUi: HostUiBridge
  quicklinks: QuicklinkStore
  exec: ScriptRuntime
  /** 会话查询（host.info / 会话能力裁剪） */
  getSession: (sid: string) => Session | undefined
  /** 命令 id → 插件声明的能力（运行期动态注册的合法性校验） */
  capabilitiesOf: (pluginId: string) => ReadonlySet<string>
  invokeCommand: (id: string, args: unknown, source: 'ui' | 'plugin') => Promise<ActionResult>
  registerCommand: (pluginId: string, pluginTitle: string, decl: CommandDecl) => () => void
}

/**
 * 服务装配：只产出 **binder**（按插件构造受限服务视图）。
 *
 * 这里曾同时产出一份挂 `'__host__'` 的 `KernelServices` 实例交给 `createPluginContext`，
 * 但后者只读 `binder`，那份对象从装配到销毁没有任何读取方 —— 已删除。
 * 服务形状仍以 `services/types.ts` 的 `KernelServices` 为准（它就是 binder 的返回类型表）。
 */
export function createServiceBinder(deps: KernelServiceDeps): ServiceBinder {
  function commandsFor(pluginId: string, pluginTitle: string): CommandRegistryService {
    const service: CommandRegistryService = {
      register: (decl: CommandDecl) => {
        assertDeclCapabilities(decl, deps.capabilitiesOf(pluginId))
        return deps.registerCommand(pluginId, pluginTitle, decl)
      },
      update: (name: string, patch: Partial<CommandDecl>) => {
        assertDeclCapabilities(patch as CommandDecl, deps.capabilitiesOf(pluginId))
        deps.registry.update(`${pluginId}:${name}`, patch)
      },
      list: () => deps.registry.byPlugin(pluginId).map((c) => c.decl),
      invoke: (name: string, args?: unknown) => deps.invokeCommand(`${pluginId}:${name}`, args, 'plugin'),
    }
    return service
  }

  function searchResultFor(pluginId: string): SearchResultService {
    return {
      set: (items: ResultItem[], token?: number) => {
        assertResultItems(items)
        deps.hub.accept(token, pluginId, items, 'set')
      },
      append: (items: ResultItem[], token?: number) => {
        assertResultItems(items)
        deps.hub.accept(token, pluginId, items, 'append')
      },
      clear: (token?: number) => {
        deps.hub.accept(token, pluginId, [], 'clear')
      },
    }
  }

  function auditFor(pluginId: string): AuditService {
    return {
      record: (entry) => {
        deps.audit.record({
          pluginId,
          channel: 'ui',
          method: `ctx.log:${entry.method}`,
          ok: entry.ok !== false,
          ms: 0,
          capability: entry.capability ?? '',
          ...(entry.args !== undefined ? { args: entry.args } : {}),
        })
      },
      query: (q): AuditRecord[] => deps.audit.query({ pluginId, limit: q?.limit ?? 100 }),
    }
  }

  function pipelineFor(pluginId: string): PipelineService {
    return {
      use: (stage: MiddlewareStage, fn: Middleware, label = 'anonymous') => deps.pipeline.use(stage, fn, pluginId, label),
    }
  }

  function execFor(pluginId: string): KernelServices['exec'] {
    return {
      run: async ({ command, args, timeoutMs }) => {
        if (!command || typeof command !== 'string') throw new LauncherError('BAD_ARGS', 'command 必填')
        // 只能调本插件的 script / no-view 命令（plugin-spec §7.2）
        const entry = deps.registry.get(`${pluginId}:${command}`)
        if (!entry) throw new LauncherError('NOT_FOUND', `本插件不存在命令：${command}`)
        return deps.exec.run(pluginId, command, args, timeoutMs)
      },
    }
  }

  return {
    bind(key: ServiceKey, pluginId: string, sid?: string): unknown {
      switch (key) {
        case 'storage':
          return deps.storage.serviceFor(pluginId)
        case 'commands': {
          const entry = deps.registry.byPlugin(pluginId)[0]
          return commandsFor(pluginId, entry?.pluginTitle ?? pluginId)
        }
        case 'searchResult':
          return searchResultFor(pluginId)
        case 'hostUi':
          return deps.hostUi.serviceFor(pluginId, sid ?? '')
        case 'clipboard':
          return deps.primitives.clipboardFor(pluginId)
        case 'shell':
          return deps.primitives.shellFor(pluginId)
        case 'exec':
          return execFor(pluginId)
        case 'notify':
          return deps.primitives.notifyFor(pluginId)
        case 'screenshot':
          return deps.primitives.screenshotFor(pluginId)
        case 'quicklink':
          return deps.quicklinks.serviceFor(pluginId)
        case 'audit':
          return auditFor(pluginId)
        case 'pipeline':
          return pipelineFor(pluginId)
        case 'host': {
          const session = sid ? deps.getSession(sid) : undefined
          return {
            info: (): HostInfo => ({
              version: deps.version,
              platform: process.platform,
              dataRoot: deps.dataRoot,
              pluginId,
              command: session?.command ?? '',
              sid: session?.sid ?? '',
            }),
          }
        }
        default:
          throw new LauncherError('INTERNAL', `未知服务：${String(key)}`)
      }
    },
  } as unknown as ServiceBinder
}

function assertDeclCapabilities(decl: Partial<CommandDecl>, declared: ReadonlySet<string>): void {
  for (const cap of decl.capabilities ?? []) {
    if (!declared.has(cap)) {
      throw new LauncherError('CAPABILITY_DENIED', `命令声明了未声明的能力：${cap}`)
    }
  }
}

function assertResultItems(items: ResultItem[]): void {
  if (!Array.isArray(items)) throw new LauncherError('BAD_ARGS', 'items 必须是数组')
  if (items.length > 100) throw new LauncherError('BAD_ARGS', '单次提交结果不得超过 100 条')
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.action) {
      throw new LauncherError('BAD_ARGS', '结果项必须包含 id / title / action')
    }
  }
}
