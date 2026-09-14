import { LauncherError, toErrorShape } from '@launcher/plugin-manifest'
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

/** 方法 → 所需能力（'' 表示无需声明） */
const METHOD_CAPABILITY: Record<string, string> = {
  'ctx.storage.get': 'storage',
  'ctx.storage.set': 'storage',
  'ctx.storage.remove': 'storage',
  'ctx.storage.all': 'storage',
  'ctx.storage.clear': 'storage',
  'ctx.hostUi.getSearchContent': 'hostUi',
  'ctx.hostUi.setSearchContent': 'hostUi',
  'ctx.hostUi.clearSearchContent': 'hostUi',
  'ctx.hostUi.setFooter': 'hostUi',
  'ctx.hostUi.hide': 'hostUi',
  'ctx.clipboard.readText': 'clipboard.read',
  'ctx.clipboard.writeText': 'clipboard.write',
  'ctx.shell.openUrl': 'shell.open',
  'ctx.shell.openPath': 'shell.open',
  'ctx.shell.reveal': 'shell.open',
  'ctx.exec.run': 'exec.spawn',
  'ctx.notify.show': 'notify.show',
  'ctx.screenshot.start': 'screenshot',
  'ctx.quicklink.all': 'quicklink',
  'ctx.quicklink.add': 'quicklink',
  'ctx.quicklink.edit': 'quicklink',
  'ctx.quicklink.remove': 'quicklink',
}

export function capabilityFor(method: string): string {
  return METHOD_CAPABILITY[method] ?? ''
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
      this.deps.audit.record({
        pluginId: session.pluginId,
        channel: 'ui',
        method: call.method,
        ok: true,
        ms: Date.now() - start,
        capability: capabilityFor(call.method),
        ...(call.params !== undefined ? { args: call.params } : {}),
      })
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
    const storage = () => this.deps.storage.serviceFor(pluginId)
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
        this.deps.sessions.close(sid)
        this.deps.bus.emit('plugin/state', { pluginId, sid, closed: true })
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
        return storage().get(str(params.key, 'key'))
      case 'ctx.storage.set':
        await storage().set(str(params.key, 'key'), params.value)
        return null
      case 'ctx.storage.remove':
        await storage().remove(str(params.key, 'key'))
        return null
      case 'ctx.storage.all':
        return storage().all()
      case 'ctx.storage.clear':
        await storage().clear()
        return null

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
