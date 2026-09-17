import path from 'node:path'
import type { SettingDecl } from '@launcher/plugin-manifest'
import { readJson, writeJsonAtomic } from './util/fsx'

/**
 * 插件设置的**用户值层**。
 *
 * 与别名覆盖层（`overrides.ts`）同款思路：清单里的 `settings` 只描述「有哪些设置、长什么样」，
 * 用户改过的值单独存 `<dataRoot>/plugin-settings.json` —— 插件产物是构建产物，重装 / 更新即丢，
 * 用户改出来的值不能写进去。
 *
 * 生效值 = 用户值 ?? 声明里的 `default`（`effectiveSettings`）。
 * 设置页改完由 `PluginAdmin` 重载插件：script / no-view 的设置在 worker 启动时注入
 * （`ctx().settings`），重载后新值才会被读到。
 */
export type SettingValue = string | boolean

/** `<pluginId> → { <settingKey>: value }`（只存用户改过的键） */
export type PluginSettingsFile = Record<string, Record<string, SettingValue>>

export const MAX_TEXT_SETTING_LENGTH = 200

/** 值是否合法（按声明逐项校验；设置页与 HTTP API 共用这一份） */
export function isValidSettingValue(decl: SettingDecl, value: unknown): value is SettingValue {
  if (decl.type === 'switch') return typeof value === 'boolean'
  if (typeof value !== 'string') return false
  if (value.length > MAX_TEXT_SETTING_LENGTH) return false
  if (decl.type === 'select') return (decl.options ?? []).some((option) => option.value === value)
  return true
}

/** 按当前声明过滤用户值：清单里删掉的键、类型对不上的值一律丢弃（清单更新后不留残渣） */
export function sanitizeSettingValues(raw: unknown, decls: SettingDecl[]): Record<string, SettingValue> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, SettingValue> = {}
  for (const decl of decls) {
    const value = source[decl.key]
    if (isValidSettingValue(decl, value)) out[decl.key] = value
  }
  return out
}

/** 生效值：用户值优先，缺省回落到清单 default（都没有则不出现在结果里） */
export function effectiveSettings(
  decls: SettingDecl[],
  values: Record<string, SettingValue> | undefined,
): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const decl of decls) {
    const value = values?.[decl.key] ?? decl.default
    if (value !== undefined) out[decl.key] = value
  }
  return out
}

/** 文件级粗过滤（此时不知道插件声明，只保证「值是 string | boolean」） */
export function sanitizeSettingsFile(raw: unknown): PluginSettingsFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PluginSettingsFile = {}
  for (const [pluginId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!pluginId || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry: Record<string, SettingValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!key) continue
      if (typeof item === 'string' || typeof item === 'boolean') entry[key] = item
    }
    if (Object.keys(entry).length > 0) out[pluginId] = entry
  }
  return out
}

export class PluginSettingStore {
  readonly file: string
  private cache: PluginSettingsFile = {}
  private queue: Promise<void> = Promise.resolve()

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'plugin-settings.json')
  }

  async load(): Promise<PluginSettingsFile> {
    this.cache = sanitizeSettingsFile(await readJson<unknown>(this.file, {}))
    return this.cache
  }

  getFor(pluginId: string): Record<string, SettingValue> | undefined {
    return this.cache[pluginId]
  }

  async set(pluginId: string, key: string, value: SettingValue): Promise<void> {
    const entry = { ...(this.cache[pluginId] ?? {}), [key]: value }
    await this.commit(pluginId, entry)
  }

  /** 恢复默认：删掉用户值（而不是写一份 default —— 清单以后改了默认值要能跟上） */
  async reset(pluginId: string, key: string): Promise<void> {
    const entry = { ...(this.cache[pluginId] ?? {}) }
    delete entry[key]
    await this.commit(pluginId, entry)
  }

  /** 卸载插件时一并清掉（重装后不该还带着上一份设置） */
  async clear(pluginId: string): Promise<void> {
    if (!this.cache[pluginId]) return
    await this.commit(pluginId, {})
  }

  private async commit(pluginId: string, entry: Record<string, SettingValue>): Promise<void> {
    const next: PluginSettingsFile = { ...this.cache }
    if (Object.keys(entry).length === 0) delete next[pluginId]
    else next[pluginId] = entry
    this.cache = next
    const snapshot = this.cache
    this.queue = this.queue.then(
      () => writeJsonAtomic(this.file, snapshot),
      () => writeJsonAtomic(this.file, snapshot),
    )
    await this.queue
  }
}
