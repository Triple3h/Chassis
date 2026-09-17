import { LauncherError, SERVICE_CAPABILITY, toErrorShape } from '@launcher/plugin-manifest'
import type { ResultItem } from '@launcher/plugin-manifest'
import type { AuditLog } from '../audit'
import type { EventBus } from '../events'
import type { CommandRegistry, SearchResultHub } from '../registry'
import type { SessionManager } from '../session'
import type { Session } from '../types'
import type { PluginStorage } from './storage'
import type { Primitives } from './shell'
import type { HostUiBridge } from './hostUi'
import type { FooterButton } from './types'
import type { QuicklinkStore } from './quicklink'
import type { ScriptRuntime } from './exec'
import type { SettingsService } from './settings'

export interface BridgeDeps {
  sessions: SessionManager
  registry: CommandRegistry
  hub: SearchResultHub
  audit: AuditLog
  bus: EventBus
  storage: PluginStorage
  primitives: Primitives
  hostUi: HostUiBridge
  quicklinks: QuicklinkStore
  exec: ScriptRuntime
  version: string
  dataRoot: string
  invokeCommand: (id: string, args: unknown, source: 'ui' | 'plugin') => Promise<unknown>
  capabilitiesOf: (pluginId: string) => ReadonlySet<string>
  /** 管理面特权服务（非 internal 插件调用会被服务内部拒绝） */
  settingsFor?: (pluginId: string) => SettingsService
}

export interface BridgeCall {
  sid: string
  token: string
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface BridgeResult {
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

/**
 * 方法 → 所需能力（'' = 无需声明）。
 *
 * 真源是 `@launcher/plugin-manifest` 的 `SERVICE_CAPABILITY`（服务名 → 能力）：
 * 从 `ctx.<service>.<method>` 取出服务名去查表即可。这里只补一张**特例表** ——
 * clipboard 在服务表里只记「有 write 才能挂载」，而桥按方法细分读 / 写两种能力。
 *
 * 收敛之前这里维护着一份 20+ 行的逐方法清单：加一个 SDK 方法就得记得来改，
 * 漏了就是「桥放行、装配期裁剪却没放」或反之。
 */
const METHOD_CAPABILITY_OVERRIDES: Record<string, string> = {
  'ctx.clipboard.readText': 'clipboard.read',
  'ctx.clipboard.writeText': 'clipboard.write',
}

export function capabilityFor(method: string): string {
  const override = METHOD_CAPABILITY_OVERRIDES[method]
  if (override) return override
  const service = method.split('.')[1]
  return (service ? SERVICE_CAPABILITY[service] : undefined) ?? ''
}

/**
 * 这些服务的调用**自带审计**（服务实现内部过 `audited()`，见 services 下的
 * storage / hostUi / shell / quicklink）：桥不再对它们的成功调用重复记一条。
 *
 * 为什么：两边都记 = 同一次调用落两条（实测 `ctx.storage.get` 恰好 2 条）——
 * 审计环形缓冲只有 500 条，可追溯窗口被白白砍半，设置页的审计列表也会成对重复。
 *
 * **失败路径仍然一律记**：参数 / 能力校验可能发生在服务层 `audited()` 之前
 * （那一条就不会存在），多记一条的代价远小于漏记 —— P6 是「可审计」，不是「不重复」。
 *
 * 新增 SDK 方法时注意：属于上表服务的写进这里，其余（exec / audit / host / commands /
 * searchResult / settings / log）由桥记入口审计。`tests/unit/bridge-audit.test.ts` 守着这条线。
 */
const SELF_AUDITED_PREFIXES = [
  'ctx.storage.',
  'ctx.hostUi.',
  'ctx.clipboard.',
  'ctx.shell.',
  'ctx.notify.',
  'ctx.screenshot.',
  'ctx.quicklink.',
]

function isSelfAudited(method: string): boolean {
  return SELF_AUDITED_PREFIXES.some((prefix) => method.startsWith(prefix))
}

/**
 * 插件页 → 宿主 的唯一入口（requirements §8.5 / P6）。
 * token 校验在 内核；origin / event.source 校验在 启动台 UI（内核看不到 iframe）。
 */
export class BridgeDispatcher {
  constructor(private readonly deps: BridgeDeps) {}

  async dispatch(call: BridgeCall): Promise<BridgeResult> {
    const session = this.deps.sessions.get(call.sid)
    if (!session || session.token !== call.token) {
      this.deps.audit.record({
        pluginId: session?.pluginId ?? 'unknown',
        channel: 'ui',
        method: `bridge:${call.method}`,
        ok: false,
        ms: 0,
        capability: '',
        error: { code: 'SESSION_INVALID', message: '会话或 token 不匹配' },
      })
      return { id: call.id, ok: false, error: { code: 'SESSION_INVALID', message: '会话或 token 不匹配' } }
    }

    const start = Date.now()
    try {
      const result = await this.invoke(session, call)
      // 自带审计的服务只记服务层那一条（否则同一次调用双记，见 SELF_AUDITED_PREFIXES）
      if (!isSelfAudited(call.method)) {
        this.deps.audit.record({
          pluginId: session.pluginId,
          channel: 'ui',
          method: call.method,
          ok: true,
          ms: Date.now() - start,
          capability: capabilityFor(call.method),
          ...(call.params !== undefined ? { args: call.params } : {}),
        })
      }
      return { id: call.id, ok: true, result: result ?? null }
    } catch (err) {
      const error = toErrorShape(err)
      this.deps.audit.record({
        pluginId: session.pluginId,
        channel: 'ui',
        method: call.method,
        ok: false,
        ms: Date.now() - start,
        capability: capabilityFor(call.method),
        error,
        ...(call.params !== undefined ? { args: call.params } : {}),
      })
      return { id: call.id, ok: false, error }
    }
  }

  private async invoke(session: Session, call: BridgeCall): Promise<unknown> {
    const { pluginId, sid } = session
    const params = (call.params ?? {}) as Record<string, unknown>
    const capability = capabilityFor(call.method)
    if (capability && !this.deps.capabilitiesOf(pluginId).has(capability)) {
      throw new LauncherError('CAPABILITY_DENIED', `未声明能力：${capability}`)
    }
    const hostUi = () => this.deps.hostUi.serviceFor(pluginId, sid)

    switch (call.method) {
      case 'ctx.host.info':
        return {
          version: this.deps.version,
          platform: process.platform,
          dataRoot: this.deps.dataRoot,
          pluginId,
          command: session.command,
          sid,
        }

      case 'ctx.log':
      case 'ctx.log.info':
        return null

      case 'ctx.commands.invoke': {
        const command = str(params.command, 'command')
        const id = command.includes(':') ? command : `${pluginId}:${command}`
        return this.deps.invokeCommand(id, params.args, 'plugin')
      }

      case 'ctx.commands.close':
        // 关闭理由由内核的会话监听统一广播（`session/closed`），这里不再单独发事件
        this.deps.sessions.close(sid, 'ui')
        return null

      case 'ctx.commands.registerAction': {
        // UI 侧的动作处理器留在插件页本地；宿主只在 ResultItem.actions 里出现时回调（v1 简化：无需注册）
        return null
      }

      case 'ctx.searchResult.set':
        this.deps.hub.accept(num(params.token) ?? session.lastSearchToken, pluginId, asItems(params.items), 'set')
        return null
      case 'ctx.searchResult.append':
        this.deps.hub.accept(num(params.token) ?? session.lastSearchToken, pluginId, asItems(params.items), 'append')
        return null
      case 'ctx.searchResult.clear':
        this.deps.hub.accept(num(params.token) ?? session.lastSearchToken, pluginId, [], 'clear')
        return null

      case 'ctx.storage.get':
      case 'ctx.storage.set':
      case 'ctx.storage.remove':
      case 'ctx.storage.all':
      case 'ctx.storage.clear':
        // 方法名转发给统一实现（与脚本侧 `storage.*` 同一处，见 PluginStorage.call）
        return this.deps.storage.call(pluginId, 'ui', call.method.slice('ctx.storage.'.length), params)

      case 'ctx.hostUi.getSearchContent':
        return hostUi().getSearchContent()
      case 'ctx.hostUi.setSearchContent':
        return hostUi().setSearchContent(String(params.value ?? ''))
      case 'ctx.hostUi.clearSearchContent':
        return hostUi().clearSearchContent()
      case 'ctx.hostUi.setFooter':
        return hostUi().setFooter(asFooter(params.buttons))
      case 'ctx.hostUi.hide':
        await hostUi().hide()
        return null

      case 'ctx.clipboard.readText':
        return this.deps.primitives.clipboardFor(pluginId).readText()
      case 'ctx.clipboard.writeText':
        await this.deps.primitives.clipboardFor(pluginId).writeText(String(params.text ?? ''))
        return null

      case 'ctx.shell.openUrl':
        await this.deps.primitives.shellFor(pluginId).openUrl(str(params.url, 'url'))
        return null
      case 'ctx.shell.openPath':
        await this.deps.primitives.shellFor(pluginId).openPath(str(params.path, 'path'))
        return null
      case 'ctx.shell.reveal':
        await this.deps.primitives.shellFor(pluginId).reveal(str(params.path, 'path'))
        return null

      case 'ctx.exec.run': {
        const command = str(params.command, 'command')
        if (!this.deps.registry.get(`${pluginId}:${command}`)) {
          throw new LauncherError('NOT_FOUND', `本插件不存在命令：${command}`)
        }
        return this.deps.exec.run(pluginId, command, params.args, num(params.timeoutMs))
      }

      case 'ctx.notify.show':
        return this.deps.primitives.notifyFor(pluginId).show({
          title: String(params.title ?? ''),
          body: String(params.body ?? ''),
          silent: Boolean(params.silent),
        })

      case 'ctx.screenshot.start':
        return this.deps.primitives.screenshotFor(pluginId).start()

      case 'ctx.quicklink.all':
        return this.deps.quicklinks.serviceFor(pluginId).all()
      case 'ctx.quicklink.add':
        return this.deps.quicklinks.serviceFor(pluginId).add({
          name: String(params.name ?? ''),
          url: str(params.url, 'url'),
        })
      case 'ctx.quicklink.edit':
        await this.deps.quicklinks.serviceFor(pluginId).edit(str(params.id, 'id'), {
          ...(params.name !== undefined ? { name: String(params.name) } : {}),
          ...(params.url !== undefined ? { url: String(params.url) } : {}),
        })
        return null
      case 'ctx.quicklink.remove':
        await this.deps.quicklinks.serviceFor(pluginId).remove(str(params.id, 'id'))
        return null

      default:
        break
    }

    // 管理面特权（internal-* 之外一律 FORBIDDEN）
    if (call.method.startsWith('ctx.settings.')) {
      const settings = this.deps.settingsFor?.(pluginId)
      if (!settings) throw new LauncherError('FORBIDDEN', '本插件没有管理面权限')
      switch (call.method) {
        case 'ctx.settings.get':
          return settings.get()
        case 'ctx.settings.patch':
          return settings.patch((params.patch ?? params) as never)
        case 'ctx.settings.setAutostart':
          await settings.setAutostart(Boolean(params.enabled))
          return null
        case 'ctx.settings.setHistoryLimit':
          await settings.setHistoryLimit(Number(params.limit))
          return null
        case 'ctx.settings.plugins':
          return settings.plugins()
        case 'ctx.settings.pluginAction':
          return settings.pluginAction(str(params.action, 'action'), (params.payload ?? {}) as Record<string, unknown>)
        case 'ctx.settings.audit':
          return settings.audit(num(params.limit))
        case 'ctx.settings.clearAudit':
          await settings.clearAudit()
          return null
        case 'ctx.settings.clearHistory':
          await settings.clearHistory()
          return null
        case 'ctx.settings.openDataDir':
          await settings.openDataDir()
          return null
        case 'ctx.settings.revealPlugin':
          await settings.revealPlugin(str(params.id, 'id'))
          return null
        case 'ctx.settings.info':
          return settings.info()
        default:
          throw new LauncherError('NOT_FOUND', `未知方法：${call.method}`)
      }
    }

    throw new LauncherError('NOT_FOUND', `未知方法：${call.method}`)
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new LauncherError('BAD_ARGS', `${field} 必须是非空字符串`)
  return value
}

function num(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function asItems(value: unknown): ResultItem[] {
  if (!Array.isArray(value)) throw new LauncherError('BAD_ARGS', 'items 必须是数组')
  if (value.length > 100) throw new LauncherError('BAD_ARGS', '单次提交结果不得超过 100 条')
  for (const item of value) {
    const o = item as ResultItem
    if (!o || typeof o.id !== 'string' || typeof o.title !== 'string' || !o.action) {
      throw new LauncherError('BAD_ARGS', '结果项必须包含 id / title / action')
    }
  }
  return value as ResultItem[]
}

function asFooter(value: unknown): FooterButton[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8) as FooterButton[]
}
