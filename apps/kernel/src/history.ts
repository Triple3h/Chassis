import path from 'node:path'
import type { HistoryItem, PinnedItem } from '@launcher/plugin-manifest'
import { createDebouncedWriter, readJson, writeJsonAtomic } from './util/fsx'

interface HistoryFile {
  version: number
  items: HistoryItem[]
}

interface PinnedFile {
  version: number
  items: PinnedItem[]
}

const FILE_VERSION = 1

/**
 * 最近使用 + 已固定（requirements §7.5）。
 * schema 能力无关：不出现任何「应用 / 文件」概念。
 */
export class HistoryStore {
  private history: HistoryItem[] = []
  private pinned: PinnedItem[] = []
  private historyLimit = 500
  private readonly historyWriter
  private readonly pinnedWriter

  constructor(private readonly dataRoot: string) {
    this.historyWriter = createDebouncedWriter(() => this.flushHistory(), 500)
    this.pinnedWriter = createDebouncedWriter(() => this.flushPinned(), 500)
  }

  get historyFile(): string {
    return path.join(this.dataRoot, 'history.json')
  }

  get pinnedFile(): string {
    return path.join(this.dataRoot, 'pinned.json')
  }

  async load(limit: number): Promise<void> {
    this.historyLimit = limit
    const h = await readJson<HistoryFile>(this.historyFile, { version: FILE_VERSION, items: [] })
    const p = await readJson<PinnedFile>(this.pinnedFile, { version: FILE_VERSION, items: [] })
    this.history = Array.isArray(h.items) ? h.items.filter(isHistoryItem) : []
    this.pinned = Array.isArray(p.items) ? p.items.filter(isPinnedItem).sort((a, b) => a.order - b.order) : []
    this.trim()
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = limit
    this.trim()
    this.historyWriter.schedule()
  }

  recent(limit = 6): HistoryItem[] {
    return [...this.history].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit)
  }

  allRecent(): HistoryItem[] {
    return [...this.history].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  pinnedList(): PinnedItem[] {
    return [...this.pinned].sort((a, b) => a.order - b.order)
  }

  find(key: string): HistoryItem | undefined {
    return this.history.find((h) => h.key === key)
  }

  isPinned(key: string): boolean {
    return this.pinned.some((p) => p.key === key)
  }

  /** 只在 execute 成功且 kind !== 'host' 时调用（requirements §7.5） */
  record(entry: Omit<HistoryItem, 'lastUsed' | 'count'>): HistoryItem {
    const existing = this.history.find((h) => h.key === entry.key)
    const now = Date.now()
    if (existing) {
      existing.lastUsed = now
      existing.count += 1
      existing.title = entry.title
      existing.subtitle = entry.subtitle
      existing.icon = entry.icon
      existing.args = entry.args
      existing.action = entry.action
      this.historyWriter.schedule()
      return existing
    }
    const item: HistoryItem = { ...entry, lastUsed: now, count: 1 }
    this.history.unshift(item)
    this.trim()
    this.historyWriter.schedule()
    return item
  }

  remove(key: string): void {
    const before = this.history.length
    this.history = this.history.filter((h) => h.key !== key)
    if (this.history.length !== before) this.historyWriter.schedule()
  }

  clearHistory(): void {
    this.history = []
    this.historyWriter.schedule()
  }

  /** 固定项恒在最前（按 order），不受搜索影响 */
  pin(item: Omit<PinnedItem, 'order'>): PinnedItem {
    const existing = this.pinned.find((p) => p.key === item.key)
    if (existing) return existing
    const order = this.pinned.length ? Math.max(...this.pinned.map((p) => p.order)) + 1 : 0
    const entry: PinnedItem = { ...item, order }
    this.pinned.push(entry)
    this.pinnedWriter.schedule()
    return entry
  }

  unpin(key: string): void {
    const before = this.pinned.length
    this.pinned = this.pinned.filter((p) => p.key !== key)
    if (this.pinned.length !== before) {
      this.reindexPinned()
      this.pinnedWriter.schedule()
    }
  }

  /** 拖拽重排 */
  reorder(keys: string[]): PinnedItem[] {
    const map = new Map(this.pinned.map((p) => [p.key, p]))
    const next: PinnedItem[] = []
    keys.forEach((key, index) => {
      const item = map.get(key)
      if (item) {
        item.order = index
        next.push(item)
        map.delete(key)
      }
    })
    for (const rest of map.values()) {
      rest.order = next.length
      next.push(rest)
    }
    this.pinned = next
    this.pinnedWriter.schedule()
    return this.pinnedList()
  }

  /**
   * 插件改名：把历史 / 固定项里的旧 `pluginId` 与 key 前缀一次性迁到新 id。
   * `map` 方向是 **旧 id → 新 id**（`apps/kernel/src/legacy.ts` 的 `LEGACY_ID_TO_CURRENT`）；
   * 只改写前缀、不动 args 哈希；迁移后同 key 的条目合并（历史取较新一条、次数相加，固定项保序）。
   * 调用点在启动装配期（插件还没加载，不会有新写入与它竞争）。
   */
  migratePluginIds(map: Record<string, string>): { history: number; pinned: number } {
    let history = 0
    let pinned = 0
    for (const item of this.history) if (renamePlugin(item, map)) history += 1
    for (const item of this.pinned) if (renamePlugin(item, map)) pinned += 1
    if (history > 0) {
      this.history = dedupeHistory(this.history)
      this.historyWriter.schedule()
    }
    if (pinned > 0) {
      this.pinned = dedupePinned(this.pinned)
      this.reindexPinned()
      this.pinnedWriter.schedule()
    }
    return { history, pinned }
  }

  /**
   * 按插件清掉历史条目（清单 `history: false`，如底座自身的设置 / 插件管理入口）。
   *
   * 只动历史、**不动固定项**：固定是用户的显式动作，不能被插件的一句声明抹掉。
   * 调用点在启动装配期（插件加载完、还没有新写入）。
   */
  dropHistoryBy(exclude: (pluginId: string) => boolean): number {
    const before = this.history.length
    this.history = this.history.filter((h) => !exclude(h.pluginId))
    const removed = before - this.history.length
    if (removed > 0) this.historyWriter.schedule()
    return removed
  }

  async flush(): Promise<void> {
    await this.historyWriter.flush()
    await this.pinnedWriter.flush()
  }

  private trim(): void {
    if (this.history.length <= this.historyLimit) return
    this.history.sort((a, b) => b.lastUsed - a.lastUsed)
    this.history = this.history.slice(0, this.historyLimit)
  }

  private reindexPinned(): void {
    this.pinned.sort((a, b) => a.order - b.order)
    this.pinned.forEach((p, i) => {
      p.order = i
    })
  }

  private async flushHistory(): Promise<void> {
    const snapshot: HistoryFile = { version: FILE_VERSION, items: this.history }
    await writeJsonAtomic(this.historyFile, snapshot)
  }

  private async flushPinned(): Promise<void> {
    const snapshot: PinnedFile = { version: FILE_VERSION, items: this.pinned }
    await writeJsonAtomic(this.pinnedFile, snapshot)
  }
}

/** 改写条目的 pluginId 与 key 前缀（`itemKey` 恒以 `${pluginId}:` 开头）；不是旧 id 就不动 */
function renamePlugin<T extends { pluginId: string; key: string }>(item: T, map: Record<string, string>): boolean {
  const next = map[item.pluginId]
  if (!next) return false
  const prefix = `${item.pluginId}:`
  if (item.key.startsWith(prefix)) item.key = `${next}:${item.key.slice(prefix.length)}`
  item.pluginId = next
  return true
}

/** 合并同 key 的历史项（新旧 id 并存时）：保留最近使用的一条，次数相加 */
function dedupeHistory(items: HistoryItem[]): HistoryItem[] {
  const map = new Map<string, HistoryItem>()
  for (const item of items) {
    const existing = map.get(item.key)
    if (!existing) {
      map.set(item.key, item)
      continue
    }
    const newer = item.lastUsed > existing.lastUsed ? item : existing
    const older = newer === item ? existing : item
    map.set(item.key, { ...newer, count: newer.count + older.count })
  }
  return [...map.values()]
}

/** 合并同 key 的固定项：保留 order 最小的一条（其余由 reindexPinned 重新编号） */
function dedupePinned(items: PinnedItem[]): PinnedItem[] {
  const map = new Map<string, PinnedItem>()
  for (const item of [...items].sort((a, b) => a.order - b.order)) {
    if (!map.has(item.key)) map.set(item.key, item)
  }
  return [...map.values()]
}

function isHistoryItem(v: unknown): v is HistoryItem {
  const o = v as HistoryItem
  return Boolean(o && typeof o.key === 'string' && typeof o.pluginId === 'string' && typeof o.command === 'string' && typeof o.title === 'string')
}

function isPinnedItem(v: unknown): v is PinnedItem {
  const o = v as PinnedItem
  return Boolean(
    o && typeof o.key === 'string' && typeof o.pluginId === 'string' && typeof o.command === 'string' && typeof o.title === 'string' && typeof o.order === 'number',
  )
}
