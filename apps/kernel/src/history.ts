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

  /** 清理失效项（插件已卸载 / 命令已不存在） */
  pruneInvalid(isValid: (item: { pluginId: string; command: string }) => boolean): { history: number; pinned: number } {
    const hBefore = this.history.length
    const pBefore = this.pinned.length
    this.history = this.history.filter((h) => isValid(h))
    this.pinned = this.pinned.filter((p) => isValid(p))
    if (this.history.length !== hBefore) this.historyWriter.schedule()
    if (this.pinned.length !== pBefore) {
      this.reindexPinned()
      this.pinnedWriter.schedule()
    }
    return { history: hBefore - this.history.length, pinned: pBefore - this.pinned.length }
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
