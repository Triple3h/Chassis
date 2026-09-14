import type { CommandDecl, HistoryItem, RankedResult, ResultItem } from '@launcher/plugin-manifest'
import type { AuditLog } from './audit'
import type { ConfigStore } from './config'
import type { EventBus } from './events'
import type { HistoryStore } from './history'
import { blendPluginScore, combinedScore, matchTarget, type SearchTarget } from './pinyin'
import type { CommandRegistry, RegisteredCommand, SearchResultHub } from './registry'
import type { SessionManager } from './session'
import type { ScriptRuntime } from './services/exec'
import type { Disposer } from './types'
import { itemKey, normalizeQuery } from './util/text'

export interface SearchResponse {
  token: number
  query: string
  groups: {
    pinned: RankedResult[]
    best: RankedResult[]
    recent: RankedResult[]
  }
  /** 折叠阈值（UI 用它决定是否显示「已固定 (N)」） */
  collapse: { pinned: number; recent: number }
  /** 命中的插件（用于 UI 提示哪些插件还在补位） */
  pending: string[]
}

export interface SearchDeps {
  registry: CommandRegistry
  hub: SearchResultHub
  history: HistoryStore
  sessions: SessionManager
  exec: ScriptRuntime
  audit: AuditLog
  bus: EventBus
  config: ConfigStore
  pluginTitleOf: (pluginId: string) => string
  /** 插件静态资源基址（相对路径图标 → 绝对 URL） */
  pluginBaseUrl: (pluginId: string) => string | null
  isCommandAlive: (pluginId: string, command: string) => boolean
}

const MAX_BEST = 20
const SEARCH_BUDGET_MS = 200

/**
 * 搜索调度（requirements §7.6）：
 * debounce 在 UI 侧（80ms），这里负责广播 / 合并 / 去重 / 排序。
 */
export class SearchEngine {
  private counter = 0
  private lastOrder = new Map<string, number>()
  private inFlight = new Map<string, Promise<SearchResponse>>()

  constructor(private readonly deps: SearchDeps) {}

  onRegistryChanged(fn: () => void): Disposer {
    return this.deps.registry.onChange(fn)
  }

  currentToken(): number {
    return this.counter
  }

  async search(rawQuery: string): Promise<SearchResponse> {
    const query = normalizeQuery(rawQuery)
    const token = ++this.counter
    this.deps.hub.setCurrent(token)

    if (!query) {
      return {
        token,
        query,
        groups: { pinned: this.pinnedResults(''), best: [], recent: this.recentResults('') },
        collapse: { pinned: 8, recent: 6 },
        pending: [],
      }
    }

    const cached = this.inFlight.get(query)
    if (cached) return cached

    const run = this.runSearch(query, token).finally(() => {
      this.inFlight.delete(query)
    })
    this.inFlight.set(query, run)
    return run
  }

  private async runSearch(query: string, token: number): Promise<SearchResponse> {
    const config = this.deps.config.get()
    this.deps.hub.open(token, query)

    const localCommands = this.scoreCommands(query)
    const pinned = this.pinnedResults(query)
    const recent = config.historyInSearch ? this.recentResults(query) : []

    const pending: string[] = []

    // 1) 贡献型：脚本 worker（常驻）
    const contributors = this.deps.registry.contributors()
    const scriptTasks = contributors
      .filter((c) => c.decl.mode !== 'view')
      .map((c) => {
        pending.push(c.pluginId)
        return this.deps.exec
          .querySearchSource(c.pluginId, c.decl.name, query, SEARCH_BUDGET_MS, token)
          .then((items) => {
            if (items) this.deps.hub.accept(token, c.pluginId, items, 'set')
          })
          .catch(() => undefined)
      })

    // 2) 贡献型：活跃 view 会话（postMessage 广播）
    for (const session of this.deps.sessions.all()) {
      const contributes = this.deps.registry
        .byPlugin(session.pluginId)
        .some((c) => c.decl.contributes && !c.decl.hidden)
      if (!contributes) continue
      session.lastSearchToken = token
      pending.push(session.pluginId)
      this.deps.bus.emit('search/query', { sid: session.sid, query, token })
    }

    await Promise.race([
      Promise.allSettled(scriptTasks),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, SEARCH_BUDGET_MS + 30)
        timer.unref?.()
      }),
    ])

    this.deps.hub.close(token)

    // 3) 合并插件贡献
    const contributed: RankedResult[] = []
    for (const [pluginId, items] of this.deps.hub.results(token)) {
      for (const item of items) {
        contributed.push(this.rankPluginItem(pluginId, item, query))
      }
    }

    const merged = this.dedupe([...localCommands, ...contributed])
    const best = this.stableSort(merged).slice(0, MAX_BEST)
    this.rememberOrder(best)

    return {
      token,
      query,
      groups: { pinned, best, recent },
      collapse: { pinned: 8, recent: 6 },
      pending: [...new Set(pending)],
    }
  }

  /** searchable 命令参与搜索（入口型） */
  private scoreCommands(query: string): RankedResult[] {
    const out: RankedResult[] = []
    for (const entry of this.deps.registry.searchable()) {
      const target = commandTarget(entry)
      const match = matchTarget(query, target)
      if (match.score < 0) continue
      const history = this.deps.history.find(itemKey(entry.pluginId, entry.decl.name, undefined))
      const score = history ? combinedScore(match.score, history.lastUsed, history.count) : match.score * 0.9
      out.push({
        pluginId: entry.pluginId,
        pluginTitle: entry.pluginTitle,
        command: entry.decl.name,
        item: {
          id: `command:${entry.decl.name}`,
          title: entry.decl.title,
          ...(entry.decl.subtitle ? { subtitle: entry.decl.subtitle } : {}),
          ...(entry.decl.icon ? { icon: entry.decl.icon } : {}),
          action: { type: 'command', command: entry.decl.name },
        },
        itemKey: itemKey(entry.pluginId, entry.decl.name, undefined),
        score,
        titleMatch: match.span,
      })
    }
    return out
  }

  private rankPluginItem(pluginId: string, item: ResultItem, query: string): RankedResult {
    const key = itemKey(pluginId, pluginKeyOf(item), item.action)
    const target: SearchTarget = {
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    }
    const match = matchTarget(query, target)
    const kernelScore = match.score < 0 ? 0.3 : match.score
    const history = this.deps.history.find(key)
    const usage = history ? combinedScore(kernelScore, history.lastUsed, history.count) : kernelScore
    return {
      pluginId,
      pluginTitle: this.deps.pluginTitleOf(pluginId),
      command: this.deps.registry.get(itemKey(pluginId, pluginKeyOf(item)))?.pluginId === pluginId
        ? pluginKeyOf(item)
        : pluginKeyOf(item),
      item: this.withIcon(pluginId, item),
      itemKey: key,
      score: blendPluginScore(item.score, usage),
      titleMatch: match.span,
      pinned: this.deps.history.isPinned(key),
    }
  }

  private pinnedResults(query: string): RankedResult[] {
    const list = this.deps.history.pinnedList()
    const results: RankedResult[] = []
    for (const pin of list) {
      const alive = this.deps.isCommandAlive(pin.pluginId, pin.command)
      const target: SearchTarget = { title: pin.title, ...(pin.subtitle ? { subtitle: pin.subtitle } : {}) }
      const match = query ? matchTarget(query, target) : { score: 1, span: null }
      if (query && match.score < 0) continue
      results.push({
        pluginId: pin.pluginId,
        pluginTitle: this.deps.pluginTitleOf(pin.pluginId),
        command: pin.command,
        item: {
          id: `pinned:${pin.key}`,
          title: pin.title,
          ...(pin.subtitle ? { subtitle: pin.subtitle } : {}),
          ...(pin.icon ? { icon: this.resolveIcon(pin.pluginId, pin.icon) } : {}),
          action: { type: 'command', command: pin.command, args: pin.args },
        },
        itemKey: pin.key,
        score: 1,
        titleMatch: match.span,
        pinned: true,
        ...(alive ? {} : { stale: true }),
      })
    }
    return results
  }

  private recentResults(query: string): RankedResult[] {
    const items: HistoryItem[] = this.deps.history.allRecent()
    const results: RankedResult[] = []
    for (const item of items) {
      const alive = this.deps.isCommandAlive(item.pluginId, item.command)
      const target: SearchTarget = { title: item.title, ...(item.subtitle ? { subtitle: item.subtitle } : {}) }
      const match = query ? matchTarget(query, target) : { score: 1, span: null }
      if (query && match.score < 0) continue
      const score = query ? combinedScore(match.score, item.lastUsed, item.count) : 1
      results.push({
        pluginId: item.pluginId,
        pluginTitle: this.deps.pluginTitleOf(item.pluginId),
        command: item.command,
        item: {
          id: `history:${item.key}`,
          title: item.title,
          ...(item.subtitle ? { subtitle: item.subtitle } : {}),
          ...(item.icon ? { icon: this.resolveIcon(item.pluginId, item.icon) } : {}),
          action: { type: 'command', command: item.command, args: item.args },
        },
        itemKey: item.key,
        score,
        titleMatch: match.span,
        fromHistory: true,
        pinned: this.deps.history.isPinned(item.key),
        ...(alive ? {} : { stale: true }),
      })
    }
    return results
  }

  /** 按 id 去重，保留 score 高者（requirements §7.6.4） */
  private dedupe(items: RankedResult[]): RankedResult[] {
    const map = new Map<string, RankedResult>()
    for (const item of items) {
      const key = `${item.pluginId}:${item.item.id}`
      const existing = map.get(key)
      if (!existing || item.score > existing.score) map.set(key, item)
    }
    return [...map.values()]
  }

  /** 防抖稳定：集合不变时保持上次顺序（requirements §7.6.5） */
  private stableSort(items: RankedResult[]): RankedResult[] {
    const known = items.filter((i) => this.lastOrder.has(i.itemKey))
    const unknown = items.filter((i) => !this.lastOrder.has(i.itemKey))
    const sameSet = known.length === items.length && items.length === this.lastOrder.size
    known.sort((a, b) => (this.lastOrder.get(a.itemKey) ?? 0) - (this.lastOrder.get(b.itemKey) ?? 0))
    if (!sameSet) unknown.sort((a, b) => b.score - a.score)
    else unknown.sort((a, b) => b.score - a.score)
    if (sameSet) return known
    return [...unknown.sort((a, b) => b.score - a.score), ...known].sort((a, b) => b.score - a.score)
  }

  private rememberOrder(items: RankedResult[]): void {
    this.lastOrder.clear()
    items.forEach((item, index) => this.lastOrder.set(item.itemKey, index))
  }

  private withIcon(pluginId: string, item: ResultItem): ResultItem {
    if (!item.icon) return item
    const icon = this.resolveIcon(pluginId, item.icon)
    return icon === item.icon ? item : { ...item, icon }
  }

  private resolveIcon(pluginId: string, icon: string | undefined): string | undefined {
    if (!icon) return undefined
    if (/^(data:|https?:|lucide:|[a-z0-9-]+$)/i.test(icon)) return icon
    const base = this.deps.pluginBaseUrl(pluginId)
    if (!base) return icon
    const clean = icon.replace(/^\.?\//, '')
    return `${base}/${clean}`
  }
}

function commandTarget(entry: RegisteredCommand): SearchTarget {
  const target: SearchTarget = { title: entry.decl.title }
  if (entry.decl.subtitle) target.subtitle = entry.decl.subtitle
  if (entry.decl.keywords?.length) target.keywords = entry.decl.keywords
  return target
}

function pluginKeyOf(item: ResultItem): string {
  const action = item.action
  if (action.type === 'command') return action.command
  return item.id
}

export type { CommandDecl, ResultItem }
