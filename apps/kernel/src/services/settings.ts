import type { AuditRecord, Config, PluginRuntimeInfo } from '@launcher/plugin-manifest'
import { LauncherError } from '@launcher/plugin-manifest'

/**
 * 管理面特权服务（P2 的「仅管理面除外」）：
 * 只有 internal 插件（`internal-settings`）在装配期获得该服务，第三方插件拿不到，
 * 因此「设置 / 插件管理」不需要往通用 API 里塞配置读写（P1/P5 不被污染）。
 */
export interface SettingsHost {
  getConfig(): Config
  patchConfig(patch: Partial<Config>): Promise<{ config: Config; hotkey?: { ok: boolean; reason?: string } }>
  setAutostart(enabled: boolean): Promise<void>
  setHistoryLimit(limit: number): Promise<void>
  listPlugins(): Promise<PluginRuntimeInfo[]>
  pluginAction(action: string, payload: Record<string, unknown>): Promise<unknown>
  queryAudit(limit: number): Promise<AuditRecord[]>
  clearAudit(): Promise<void>
  clearHistory(): Promise<void>
  openDataDir(): Promise<void>
  revealPath(target: string): Promise<void>
  hostInfo(): { version: string; platform: string; dataRoot: string; node: string }
}

export interface SettingsService {
  get(): Promise<Config>
  patch(patch: Partial<Config>): Promise<{ config: Config; hotkey?: { ok: boolean; reason?: string } }>
  setAutostart(enabled: boolean): Promise<void>
  setHistoryLimit(limit: number): Promise<void>
  plugins(): Promise<PluginRuntimeInfo[]>
  pluginAction(action: string, payload?: Record<string, unknown>): Promise<unknown>
  audit(limit?: number): Promise<AuditRecord[]>
  clearAudit(): Promise<void>
  clearHistory(): Promise<void>
  openDataDir(): Promise<void>
  revealPlugin(id: string): Promise<void>
  info(): Promise<{ version: string; platform: string; dataRoot: string; node: string }>
}

export function createSettingsService(host: SettingsHost, pluginId: string): SettingsService {
  const guard = (action: string): void => {
    if (!pluginId.startsWith('internal-')) {
      throw new LauncherError('FORBIDDEN', `仅管理面插件可调用 settings.${action}`)
    }
  }
  return {
    get: async () => {
      guard('get')
      return host.getConfig()
    },
    patch: async (patch) => {
      guard('patch')
      // 副作用（历史上限 / 自启 / 热键）与 `config/changed` 广播都在宿主的 `patchConfig` 里，
      // 这里只转发 —— 在这里再补一遍等于同一件事有两个收口，迟早分叉
      return host.patchConfig(patch)
    },
    setAutostart: async (enabled) => {
      guard('setAutostart')
      await host.setAutostart(enabled)
    },
    setHistoryLimit: async (limit) => {
      guard('setHistoryLimit')
      await host.setHistoryLimit(limit)
    },
    plugins: async () => {
      guard('plugins')
      return host.listPlugins()
    },
    pluginAction: async (action, payload) => {
      guard('pluginAction')
      if (!action) throw new LauncherError('BAD_ARGS', 'action 必填')
      return host.pluginAction(action, payload ?? {})
    },
    audit: async (limit) => {
      guard('audit')
      return host.queryAudit(Math.min(500, Math.max(1, limit ?? 100)))
    },
    clearAudit: async () => {
      guard('clearAudit')
      await host.clearAudit()
    },
    clearHistory: async () => {
      guard('clearHistory')
      await host.clearHistory()
    },
    openDataDir: async () => {
      guard('openDataDir')
      await host.openDataDir()
    },
    revealPlugin: async (id) => {
      guard('revealPlugin')
      const plugins = await host.listPlugins()
      const record = plugins.find((p) => p.id === id)
      if (!record) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
      await host.revealPath(record.dir)
    },
    info: async () => {
      guard('info')
      return host.hostInfo()
    },
  }
}
