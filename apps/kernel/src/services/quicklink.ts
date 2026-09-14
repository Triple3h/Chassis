import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { LauncherError } from '@launcher/plugin-manifest'
import type { AuditLog } from '../audit'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { audited } from './audited'
import type { Quicklink } from '../types'
import type { QuicklinkService } from './types'

interface QuicklinkFile {
  version: number
  items: Quicklink[]
}

/** 快捷链接（宿主级共享数据，插件经 `ctx.quicklink` 增删改查） */
export class QuicklinkStore {
  private items: Quicklink[] = []
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly dataRoot: string,
    private readonly audit: AuditLog,
  ) {}

  private get file(): string {
    return path.join(this.dataRoot, 'quicklinks.json')
  }

  serviceFor(pluginId: string): QuicklinkService {
    return {
      all: async () =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.quicklink.all', 'quicklink', undefined, async () => {
          await this.load()
          return [...this.items]
        }),
      add: async (link) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.quicklink.add', 'quicklink', link, async () => {
          await this.load()
          if (!link?.url) throw new LauncherError('BAD_ARGS', 'url 必填')
          const item: Quicklink = { id: randomUUID(), name: link.name || link.url, url: link.url }
          if (link.icon) item.icon = link.icon
          this.items.push(item)
          this.persist()
          return item
        }),
      edit: async (id, patch) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.quicklink.edit', 'quicklink', { id, patch }, async () => {
          await this.load()
          const item = this.items.find((i) => i.id === id)
          if (!item) throw new LauncherError('NOT_FOUND', `快捷链接不存在：${id}`)
          Object.assign(item, patch)
          this.persist()
        }),
      remove: async (id) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.quicklink.remove', 'quicklink', { id }, async () => {
          await this.load()
          this.items = this.items.filter((i) => i.id !== id)
          this.persist()
        }),
    }
  }

  async load(): Promise<Quicklink[]> {
    if (this.loaded) return this.items
    const raw = await readJson<QuicklinkFile>(this.file, { version: 1, items: [] })
    this.items = Array.isArray(raw.items) ? raw.items.filter((i) => i && typeof i.url === 'string') : []
    this.loaded = true
    return this.items
  }

  private persist(): void {
    const snapshot: QuicklinkFile = { version: 1, items: this.items }
    this.queue = this.queue.then(
      () => writeJsonAtomic(this.file, snapshot),
      () => writeJsonAtomic(this.file, snapshot),
    )
  }
}
