import { LauncherError } from '@launcher/plugin-manifest'
import type { ConfigStore } from './config'
import type { OverrideStore } from './overrides'
import type { PluginManager, PluginRecord } from './plugin'
import type { Primitives } from './services/shell'

export interface PluginAdminDeps {
  plugins: PluginManager
  overrides: OverrideStore
  config: ConfigStore
  primitives: Primitives
}

/**
 * 插件管理动作（托盘、设置面板、HTTP API 共用同一条路径）。
 *
 * 从 `Kernel` 里抽出来：它只依赖「插件管理器 + 覆盖层 + 配置 + 壳原语」，
 * 与内核的其它职责（搜索、会话、显隐）没有交集，放在 `Kernel` 上会让那个类显得什么都管。
 */
export class PluginAdmin {
  constructor(private readonly deps: PluginAdminDeps) {}

  async run(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = typeof payload.id === 'string' ? payload.id : ''
    const dir = typeof payload.path === 'string' ? payload.path : ''
    switch (action) {
      case 'enable':
        await this.deps.plugins.setDisabled(id, false)
        return { ok: true }
      case 'disable':
        await this.deps.plugins.setDisabled(id, true)
        return { ok: true }
      case 'reload':
        await this.deps.plugins.reload(id)
        return { ok: true }
      case 'reloadAll':
        await this.deps.plugins.reloadAll()
        return { ok: true }
      case 'uninstall':
        await this.deps.plugins.uninstall(id)
        return { ok: true }
      case 'installDir':
        await this.deps.plugins.installFromDirectory(dir, { overwrite: Boolean(payload.overwrite) })
        return { ok: true }
      case 'installZip':
        await this.deps.plugins.installFromZip(dir, { overwrite: Boolean(payload.overwrite) })
        return { ok: true }
      case 'reveal': {
        const pluginDir = this.deps.plugins.dirOf(id)
        if (!pluginDir) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
        await this.deps.primitives.shellFor('kernel').reveal(pluginDir)
        return { ok: true }
      }
      case 'openData': {
        await this.deps.primitives.shellFor('kernel').openPath(this.deps.plugins.dataPathFor(id))
        return { ok: true }
      }
      case 'setKeywords': {
        // 界面化编辑别名：覆盖层落盘 + 当场重进注册表（不用重载插件，下一次搜索即生效）
        const { command, plugin } = this.requireOverrideTarget(id, payload)
        const keywords = Array.isArray(payload.keywords)
          ? payload.keywords.filter((k): k is string => typeof k === 'string')
          : []
        if (command) await this.deps.overrides.setCommandKeywords(plugin.id, command, keywords)
        else await this.deps.overrides.setPluginKeywords(plugin.id, keywords)
        this.deps.plugins.applyOverrides(plugin.id)
        return { ok: true, plugins: this.deps.plugins.info() }
      }
      case 'resetKeywords': {
        const { command, plugin } = this.requireOverrideTarget(id, payload)
        if (command) await this.deps.overrides.setCommandKeywords(plugin.id, command, null)
        else await this.deps.overrides.setPluginKeywords(plugin.id, null)
        this.deps.plugins.applyOverrides(plugin.id)
        return { ok: true, plugins: this.deps.plugins.info() }
      }
      case 'setCapability': {
        // 用户拒绝 / 恢复某项高风险能力（安装时确认的落点）
        const capability = typeof payload.capability === 'string' ? payload.capability : ''
        const denied = Boolean(payload.denied)
        const current = this.deps.config.get().denied
        const list = new Set(current[id] ?? [])
        if (denied) list.add(capability)
        else list.delete(capability)
        await this.deps.config.patch({ denied: { ...current, [id]: [...list] } })
        await this.deps.plugins.reloadOrLoad(id)
        return { ok: true }
      }
      default:
        throw new LauncherError('BAD_ARGS', `未知插件动作：${action}`)
    }
  }

  /** setKeywords / resetKeywords 的入参校验：插件必须存在，命令（若给）必须在清单里 */
  private requireOverrideTarget(id: string, payload: Record<string, unknown>): { command: string; plugin: PluginRecord } {
    const plugin = this.deps.plugins.get(id)
    if (!plugin) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
    const command = typeof payload.command === 'string' ? payload.command : ''
    if (command && !(plugin.manifest?.commands ?? []).some((decl) => decl.name === command)) {
      throw new LauncherError('NOT_FOUND', `命令不存在：${id}:${command}`)
    }
    return { command, plugin }
  }
}
