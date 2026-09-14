import type { ActionResult, CommandDecl, ResultItem } from '@launcher/plugin-manifest'
import { globalCommandId, splitGlobalCommandId } from '@launcher/plugin-manifest'
import type { Disposer, SearchSlot } from './types'

export interface RegisteredCommand {
  id: string
  pluginId: string
  pluginTitle: string
  decl: CommandDecl
  /** 命令级能力已并入插件级 */
  capabilities: string[]
}

/**
 * 命令注册表（requirements §7.2）。
 * 规则：插件内 name 唯一，全局 id = `${pluginId}:${name}`；停用插件其命令与结果全部撤回。
 */
export class CommandRegistry {
  private commands = new Map<string, RegisteredCommand>()
  private listeners = new Set<() => void>()
  private invokeImpl: (id: string, args: unknown, source: 'ui' | 'plugin') => Promise<ActionResult> = async () => ({
    ok: false,
    kind: 'host',
    error: { code: 'NOT_FOUND', message: 'invoke 尚未装配' },
  })

  bindInvoker(fn: (id: string, args: unknown, source: 'ui' | 'plugin') => Promise<ActionResult>): void {
    this.invokeImpl = fn
  }

  register(entry: RegisteredCommand): Disposer {
    const id = entry.id
    if (this.commands.has(id)) {
      throw new Error(`命令 id 冲突：${id}`)
    }
    const previous = this.commands.get(id)
    this.commands.set(id, entry)
    this.emit()
    return () => {
      const current = this.commands.get(id)
      if (current === entry) {
        this.commands.delete(id)
      } else if (previous) {
        this.commands.set(id, previous)
      }
      this.emit()
    }
  }

  update(id: string, patch: Partial<CommandDecl>): RegisteredCommand | undefined {
    const entry = this.commands.get(id)
    if (!entry) return undefined
    entry.decl = { ...entry.decl, ...patch, name: entry.decl.name }
    this.emit()
    return entry
  }

  get(id: string): RegisteredCommand | undefined {
    return this.commands.get(id)
  }

  has(id: string): boolean {
    return this.commands.has(id)
  }

  list(): RegisteredCommand[] {
    return [...this.commands.values()]
  }

  byPlugin(pluginId: string): RegisteredCommand[] {
    return this.list().filter((c) => c.pluginId === pluginId)
  }

  /** 参与搜索的命令（searchable 且未 hidden） */
  searchable(): RegisteredCommand[] {
    return this.list().filter((c) => c.decl.searchable && !c.decl.hidden)
  }

  /** 贡献型搜索源：需要拉起脚本 worker 的命令 */
  contributors(): RegisteredCommand[] {
    return this.list().filter((c) => c.decl.contributes && !c.decl.hidden)
  }

  onChange(fn: () => void): Disposer {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async invoke(id: string, args?: unknown, source: 'ui' | 'plugin' = 'ui'): Promise<ActionResult> {
    return this.invokeImpl(id, args, source)
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        /* 忽略监听器异常 */
      }
    }
  }
}

/**
 * 搜索槽：内核每次搜索开一个槽，按 token 校验新鲜度（requirements §7.6）。
 * 旧 token 的结果一律丢弃（不回滚已显示的）。
 */
export class SearchResultHub {
  private slots = new Map<number, SearchSlot>()
  private currentToken = 0

  open(token: number, query: string): SearchSlot {
    this.slots.set(token, { token, query, results: new Map(), settled: new Set(), closed: false })
    if (this.slots.size > 8) {
      const stale = [...this.slots.keys()].sort((a, b) => a - b).slice(0, this.slots.size - 8)
      for (const t of stale) this.slots.delete(t)
    }
    return this.slots.get(token)!
  }

  close(token: number): void {
    const slot = this.slots.get(token)
    if (slot) slot.closed = true
  }

  accept(token: number | undefined, pluginId: string, items: ResultItem[], mode: 'set' | 'append' | 'clear'): boolean {
    const effective = token ?? this.currentToken
    const slot = this.slots.get(effective)
    if (!slot || slot.closed) return false
    if (mode === 'clear') {
      slot.results.delete(pluginId)
      slot.settled.add(pluginId)
      return true
    }
    const next = mode === 'set' ? items : [...(slot.results.get(pluginId) ?? []), ...items]
    slot.results.set(pluginId, next)
    slot.settled.add(pluginId)
    return true
  }

  results(token: number): Map<string, ResultItem[]> {
    return this.slots.get(token)?.results ?? new Map()
  }

  setCurrent(token: number): void {
    this.currentToken = token
  }

  getCurrent(): number {
    return this.currentToken
  }
}

export function parseCommandId(id: string): { pluginId: string; command: string } {
  const parsed = splitGlobalCommandId(id)
  if (!parsed) throw new Error(`非法命令 id：${id}`)
  return { pluginId: parsed.pluginId, command: parsed.name }
}

export { globalCommandId }
