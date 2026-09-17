import type { Config } from '@launcher/plugin-manifest'
import type { AuditLog } from '../audit'
import type { ConfigStore } from '../config'
import type { EventBus } from '../events'
import type { HistoryStore } from '../history'
import type { PluginManager } from '../plugin'
import type { Primitives } from './shell'
import type { SettingsHost } from './settings'

export interface SettingsHostDeps {
  version: string
  dataRoot: string
  config: ConfigStore
  history: HistoryStore
  audit: AuditLog
  bus: EventBus
  primitives: Primitives
  plugins: PluginManager
  /** 配置写入的唯一收口（`Kernel.patchConfig`） */
  patchConfig: (patch: Partial<Config>) => Promise<{ config: Config; hotkey?: { ok: boolean; reason?: string; accelerator?: string } }>
  /** 插件管理动作（`Kernel.pluginAction` → PluginAdmin） */
  pluginAction: (action: string, payload: Record<string, unknown>) => Promise<unknown>
}

/**
 * 管理面（internal 插件）特权服务的**宿主实现**：把 `Kernel` 上的那些能力包成
 * `SettingsHost` 形状（谁能用由 `createSettingsService` 的 guard 决定，这里不做权限判断）。
 *
 * 从 `Kernel` 里抽出来：它是一层纯粹的转发，和内核的状态机 / 搜索 / 会话毫无关系。
 */
export function createSettingsHost(deps: SettingsHostDeps): SettingsHost {
  return {
    getConfig: () => deps.config.get(),
    // 副作用（历史上限 / 自启 / 热键）与 `config/changed` 广播都在 patchConfig 里，这里只转发
    patchConfig: (patch) => deps.patchConfig(patch),
    setAutostart: async (enabled) => {
      await deps.patchConfig({ autostart: enabled })
    },
    setHistoryLimit: async (limit) => {
      await deps.patchConfig({ historyLimit: limit })
    },
    listPlugins: async () => deps.plugins.info(),
    pluginAction: (action, payload) => deps.pluginAction(action, payload),
    queryAudit: async (limit) => deps.audit.query({ limit }),
    clearAudit: () => deps.audit.clear(),
    clearHistory: async () => {
      deps.history.clearHistory()
      deps.bus.emit('history/changed', {})
    },
    openDataDir: async () => {
      await deps.primitives.shellFor('kernel').openPath(deps.dataRoot)
    },
    revealPath: async (target) => {
      await deps.primitives.shellFor('kernel').reveal(target)
    },
    hostInfo: () => ({
      version: deps.version,
      platform: process.platform,
      dataRoot: deps.dataRoot,
      node: process.version,
    }),
  }
}
