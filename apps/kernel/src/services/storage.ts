import path from 'node:path'
import { LauncherError } from '@launcher/plugin-manifest'
import type { StorageService } from './types'
import type { AuditLog } from '../audit'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { audited } from './audited'

/**
 * 插件私有 KV：`<dataRoot>/plugins/<pluginId>/storage.json`（P7：数据与代码分离）。
 * 写入 debounce + 原子写。
 */
export class PluginStorage {
  private cache = new Map<string, Record<string, unknown>>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly dataRoot: string,
    private readonly audit: AuditLog,
  ) {}

  pluginDir(pluginId: string): string {
    return path.join(this.dataRoot, 'plugins', pluginId)
  }

  fileFor(pluginId: string): string {
    return path.join(this.pluginDir(pluginId), 'storage.json')
  }

  serviceFor(pluginId: string, channel: 'ui' | 'script' = 'ui'): StorageService {
    return {
      get: async <T>(key: string): Promise<T | undefined> => {
        return audited(this.audit, { pluginId, channel }, 'ctx.storage.get', 'storage', { key }, async () => {
          const data = await this.load(pluginId)
          return data[key] as T | undefined
        })
      },
      set: async (key: string, value: unknown): Promise<void> => {
        await audited(this.audit, { pluginId, channel }, 'ctx.storage.set', 'storage', { key }, async () => {
          if (typeof key !== 'string' || !key) throw new LauncherError('BAD_ARGS', 'key 必须是非空字符串')
          const data = await this.load(pluginId)
          data[key] = value
          this.schedule(pluginId)
        })
      },
      remove: async (key: string): Promise<void> => {
        await audited(this.audit, { pluginId, channel }, 'ctx.storage.remove', 'storage', { key }, async () => {
          const data = await this.load(pluginId)
          delete data[key]
          this.schedule(pluginId)
        })
      },
      all: async (): Promise<Record<string, unknown>> => {
        return audited(this.audit, { pluginId, channel }, 'ctx.storage.all', 'storage', undefined, async () => ({
          ...(await this.load(pluginId)),
        }))
      },
      clear: async (): Promise<void> => {
        await audited(this.audit, { pluginId, channel }, 'ctx.storage.clear', 'storage', undefined, async () => {
          this.cache.set(pluginId, {})
          this.schedule(pluginId)
        })
      },
    }
  }

  /** 只读访问（宿主内部用，比如 internal-settings 的插件列表） */
  async snapshot(pluginId: string): Promise<Record<string, unknown>> {
    return { ...(await this.load(pluginId)) }
  }

  async removePluginData(pluginId: string): Promise<void> {
    const timer = this.timers.get(pluginId)
    if (timer) clearTimeout(timer)
    this.timers.delete(pluginId)
    this.cache.delete(pluginId)
  }

  async flushAll(): Promise<void> {
    for (const pluginId of this.timers.keys()) {
      await this.flush(pluginId)
    }
  }

  private async load(pluginId: string): Promise<Record<string, unknown>> {
    const cached = this.cache.get(pluginId)
    if (cached) return cached
    const data = await readJson<Record<string, unknown>>(this.fileFor(pluginId), {})
    const safe = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    this.cache.set(pluginId, safe)
    return safe
  }

  private schedule(pluginId: string): void {
    const existing = this.timers.get(pluginId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(pluginId)
      void this.flush(pluginId)
    }, 200)
    timer.unref?.()
    this.timers.set(pluginId, timer)
  }

  private async flush(pluginId: string): Promise<void> {
    const timer = this.timers.get(pluginId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(pluginId)
    }
    const data = this.cache.get(pluginId)
    if (!data) return
    await writeJsonAtomic(this.fileFor(pluginId), data)
  }
}
