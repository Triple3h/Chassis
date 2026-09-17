import type { Disposer, KernelEvent } from './types'

export type EventHandler = (payload: unknown) => void

/** 极简事件总线：内核内部广播 + 桥接给插件页 / 启动台 UI */
export class EventBus {
  private handlers = new Map<KernelEvent, Set<EventHandler>>()
  private onEmit?: (event: KernelEvent, payload: unknown) => void

  /** UI / 插件桥的扇出钩子（SSE、postMessage） */
  setSink(sink: (event: KernelEvent, payload: unknown) => void): void {
    this.onEmit = sink
  }

  on(event: KernelEvent, fn: EventHandler): Disposer {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn)
    return () => {
      set?.delete(fn)
    }
  }

  emit(event: KernelEvent, payload?: unknown): void {
    const set = this.handlers.get(event)
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(payload)
        } catch {
          /* 单个订阅者异常不影响其它订阅者 */
        }
      }
    }
    try {
      this.onEmit?.(event, payload)
    } catch {
      /* ignore */
    }
  }
}
