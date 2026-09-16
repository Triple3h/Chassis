import fs from 'node:fs/promises'
import path from 'node:path'
import type { AuditRecord } from '@launcher/plugin-manifest'
import { ensureDir } from './util/fsx'
import { truncateForAudit } from './util/text'
import { toErrorShape, type ErrorShape } from '@launcher/plugin-manifest'

const RING_SIZE = 500
const KEEP_DAYS = 7

export interface AuditInput {
  pluginId: string
  channel: AuditRecord['channel']
  method: string
  ok: boolean
  ms: number
  capability?: string
  error?: ErrorShape
  args?: unknown
}

export interface AuditQuery {
  pluginId?: string
  method?: string
  ok?: boolean
  limit?: number
}

/**
 * 统一审计（requirements §7.7 / P6）。
 * 所有 `插件 → 宿主` 的调用都必须经过这里，没有旁路；
 * 唯一例外是底座基础能力（`essential` 出厂插件）——由 `setExempt` 豁免，不进环形缓冲与日志文件。
 */
export class AuditLog {
  readonly dir: string
  private ring: AuditRecord[] = []
  private queue: Promise<void> = Promise.resolve()
  private ready = false
  /** 豁免判定：返回 true 的插件不落审计（装配期由内核注入，见 Kernel 构造器） */
  private exempt: (pluginId: string) => boolean = () => false

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, 'logs')
  }

  /** 底座基础能力（essential）的调用等价于底座自身的行为，不记审计 */
  setExempt(fn: (pluginId: string) => boolean): void {
    this.exempt = fn
  }

  async init(): Promise<void> {
    await ensureDir(this.dir)
    this.ready = true
    await this.rotate()
  }

  record(input: AuditInput): AuditRecord {
    const rec: AuditRecord = {
      ts: Date.now(),
      pluginId: input.pluginId,
      channel: input.channel,
      method: input.method,
      ok: input.ok,
      ms: Math.max(0, Math.round(input.ms)),
      capability: input.capability ?? '',
    }
    if (input.error) rec.error = input.error
    // 基础能力不落审计：它们不可禁用、随底座一同发布，且调用量大得多（设置页轮询、应用扫描、文件搜索），
    // 记进来只会挤满环形缓冲与日志文件，把真正需要追溯的第三方插件记录淹掉
    if (this.exempt(input.pluginId)) return rec

    const argsText = input.args === undefined ? '' : truncateForAudit(input.args)
    if (argsText) rec.truncatedArgs = argsText

    this.ring.push(rec)
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    this.persist(rec)
    return rec
  }

  /** 包装一次调用：自动记 ms / 错误 / 能力 */
  async wrap<T>(
    input: Omit<AuditInput, 'ok' | 'ms' | 'error'>,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const start = Date.now()
    try {
      const result = await fn()
      this.record({ ...input, ok: true, ms: Date.now() - start })
      return result
    } catch (err) {
      this.record({ ...input, ok: false, ms: Date.now() - start, error: toErrorShape(err) })
      throw err
    }
  }

  ringBuffer(): AuditRecord[] {
    return [...this.ring].reverse()
  }

  query(q: AuditQuery = {}): AuditRecord[] {
    let list = this.ringBuffer()
    if (q.pluginId) list = list.filter((r) => r.pluginId === q.pluginId)
    if (q.method) list = list.filter((r) => r.method.includes(q.method as string))
    if (q.ok !== undefined) list = list.filter((r) => r.ok === q.ok)
    return list.slice(0, q.limit ?? 200)
  }

  private persist(rec: AuditRecord): void {
    if (!this.ready) return
    const line = `${JSON.stringify(rec)}\n`
    const file = path.join(this.dir, `audit-${dayKey(rec.ts)}.jsonl`)
    this.queue = this.queue
      .then(() => fs.appendFile(file, line, 'utf8'))
      .catch(() => undefined)
  }

  async todayFile(): Promise<string> {
    return path.join(this.dir, `audit-${dayKey(Date.now())}.jsonl`)
  }

  /** 滚动保留 7 天 */
  async rotate(): Promise<void> {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    let entries: string[] = []
    try {
      entries = await fs.readdir(this.dir)
    } catch {
      return
    }
    for (const name of entries) {
      const m = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (!m) continue
      const ts = Date.parse(`${m[1]}T00:00:00Z`)
      if (Number.isFinite(ts) && ts < cutoff) {
        await fs.rm(path.join(this.dir, name), { force: true }).catch(() => undefined)
      }
    }
  }

  async clear(): Promise<void> {
    this.ring = []
    let entries: string[] = []
    try {
      entries = await fs.readdir(this.dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) await fs.rm(path.join(this.dir, name), { force: true }).catch(() => undefined)
    }
  }
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
