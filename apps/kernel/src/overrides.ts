import path from 'node:path'
import type { CommandDecl, PluginManifest } from '@launcher/plugin-manifest'
import { readJson, writeJsonAtomic } from './util/fsx'

/**
 * 插件别名的**用户覆盖层**。
 *
 * 为什么不写进清单：插件产物里的 `package.json` 是**构建产物** —— 重装 / 重打包即丢，
 * 用户改出来的别名不能写进去。所以单独存 `<dataRoot>/plugin-overrides.json`，
 * 装配命令时与清单合并（`mergeCommandDecls`），改完只需 `registry.update` 即可生效。
 *
 * 两层语义（与 plugin-spec §3.1 / §3.2 一致）：
 * - 插件级 keywords：兜底给该插件**全部**入口命令（搜「totp」能命中 totp 的入口命令）；
 * - 命令级 keywords：只作用于该命令；
 * - 实际参与搜索 = 插件级 ∪ 命令级（`mergeKeywords` 去重保序）。
 *
 * `undefined` = 未覆盖（用清单原值），`[]` = 用户显式清空 —— 两者必须区分，
 * 否则「恢复默认」与「删光别名」会变成同一件事。
 */
export const MAX_KEYWORDS = 10

export interface CommandOverride {
  keywords?: string[]
}

export interface PluginOverride {
  keywords?: string[]
  commands?: Record<string, CommandOverride>
}

export type OverridesFile = Record<string, PluginOverride>

/** 归一化用户输入：去空白 / 去空串 / 忽略大小写去重 / 截断到 MAX_KEYWORDS（非数组 → undefined） */
export function sanitizeKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const keyword = raw.trim()
    if (!keyword) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(keyword)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

export function sanitizeOverrides(raw: unknown): OverridesFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: OverridesFile = {}
  for (const [pluginId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!pluginId || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const source = value as PluginOverride
    const entry: PluginOverride = {}
    const keywords = sanitizeKeywords(source.keywords)
    if (keywords) entry.keywords = keywords
    const commands = source.commands
    if (commands && typeof commands === 'object' && !Array.isArray(commands)) {
      const parsed: Record<string, CommandOverride> = {}
      for (const [name, command] of Object.entries(commands as Record<string, unknown>)) {
        if (!name || !command || typeof command !== 'object') continue
        const commandKeywords = sanitizeKeywords((command as CommandOverride).keywords)
        if (commandKeywords) parsed[name] = { keywords: commandKeywords }
      }
      if (Object.keys(parsed).length > 0) entry.commands = parsed
    }
    if (Object.keys(entry).length > 0) out[pluginId] = entry
  }
  return out
}

/** 插件级有效别名：覆盖优先（显式空数组 = 用户清空，不再回落到清单值） */
export function pluginKeywordsOf(
  manifestKeywords: string[] | undefined,
  override: PluginOverride | undefined,
): string[] {
  return override?.keywords ?? manifestKeywords ?? []
}

/** 命令级有效别名：覆盖优先 */
export function commandKeywordsOf(
  declaredKeywords: string[] | undefined,
  override: PluginOverride | undefined,
  commandName: string,
): string[] {
  return override?.commands?.[commandName]?.keywords ?? declaredKeywords ?? []
}

/** 实际参与搜索的别名 = 插件级 + 命令级（忽略大小写去重，保序） */
export function mergeKeywords(pluginKeywords: string[], commandKeywords: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const keyword of [...pluginKeywords, ...commandKeywords]) {
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(keyword)
  }
  return out
}

/** 装配用：清单 + 覆盖 → 最终注册进 CommandRegistry 的命令声明 */
export function mergeCommandDecls(manifest: PluginManifest, override: PluginOverride | undefined): CommandDecl[] {
  const pluginKeywords = pluginKeywordsOf(manifest.keywords, override)
  return manifest.commands.map((decl) => ({
    ...decl,
    keywords: mergeKeywords(pluginKeywords, commandKeywordsOf(decl.keywords, override, decl.name)),
  }))
}

export class OverrideStore {
  readonly file: string
  private cache: OverridesFile = {}
  private queue: Promise<void> = Promise.resolve()

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'plugin-overrides.json')
  }

  async load(): Promise<OverridesFile> {
    this.cache = sanitizeOverrides(await readJson<unknown>(this.file, {}))
    return this.cache
  }

  get(): OverridesFile {
    return this.cache
  }

  getFor(pluginId: string): PluginOverride | undefined {
    return this.cache[pluginId]
  }

  /** keywords = null ⇒ 恢复默认（删掉覆盖项） */
  async setPluginKeywords(pluginId: string, keywords: string[] | null): Promise<void> {
    const entry: PluginOverride = { ...(this.cache[pluginId] ?? {}) }
    if (keywords === null) delete entry.keywords
    else entry.keywords = sanitizeKeywords(keywords) ?? []
    await this.commit(pluginId, entry)
  }

  /** keywords = null ⇒ 恢复默认（删掉该命令的覆盖项） */
  async setCommandKeywords(pluginId: string, commandName: string, keywords: string[] | null): Promise<void> {
    const entry: PluginOverride = { ...(this.cache[pluginId] ?? {}) }
    const commands: Record<string, CommandOverride> = { ...(entry.commands ?? {}) }
    if (keywords === null) delete commands[commandName]
    else commands[commandName] = { keywords: sanitizeKeywords(keywords) ?? [] }
    if (Object.keys(commands).length > 0) entry.commands = commands
    else delete entry.commands
    await this.commit(pluginId, entry)
  }

  /** 卸载插件时一并清掉覆盖（否则重装后还带着上一份别名） */
  async clear(pluginId: string): Promise<void> {
    if (!this.cache[pluginId]) return
    await this.commit(pluginId, null)
  }

  private async commit(pluginId: string, entry: PluginOverride | null): Promise<void> {
    const next: OverridesFile = { ...this.cache }
    if (!entry || Object.keys(entry).length === 0) delete next[pluginId]
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
