/**
 * 宿主调用的**公共语义**：超时、哨兵值、localStorage 兜底。
 *
 * 为什么和 `host-adapter.ts` 分开：宿主差异（谁叫什么方法）与宿主无关的策略（超时多久、
 * 失败怎么退）是两件正交的事。这里对两个宿主必须**逐字相同** ——
 * 如快侧的边缘行为要与改造前一致，所以这段逻辑要能脱离浏览器单测（见 shared/test/）。
 *
 * 本文件不碰 `window` / `location`（只有兜底分支用 `localStorage`），宿主探测在 platform.ts。
 */

import type { HostBridge } from './host-adapter'

/** 宿主调用超时（毫秒）：沿用改造前的取值，别改，改了如快侧的边缘行为会变 */
export const HOST_TIMEOUT = {
  context: 400,
  storage: 600,
  action: 1200,
}

/** 底部操作栏按钮（两个宿主共有的字段；两个 SDK 都接受数组形态） */
export type FooterButton =
  | {
      type: 'button'
      label?: string
      id?: string
      icon?: string
      keys?: string[]
      onClick?: () => void | Promise<void>
    }
  | {
      type: 'action-panel'
      label?: string
      id?: string
      icon?: string
      keys?: string[]
      title?: string
      items: Array<{ name: string; id?: string; icon?: string; keys?: string[]; onSelect?: () => void | Promise<void> }>
    }

/**
 * 宿主调用一律加超时。
 * 宿主不可用（浏览器里 npm run dev）时，SDK 的 postMessage 请求不会有人应答，
 * Promise 会永远挂着——没有超时的话插件会卡死在启动阶段。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

const FALLBACK_PREFIX = 'sof:'
const TIMEOUT = Symbol('host-timeout')

export type BridgeProvider = () => Promise<HostBridge | null>

/**
 * 把「桥」组装成插件页真正使用的那组函数。
 * `getBridge()` 每次调用都会执行，但实现里是缓存的探测结论（platform.ts 的 detectBridge）。
 */
export function createHostCalls(getBridge: BridgeProvider) {
  /** 宿主可用性的缓存结论：null = 还没结论 */
  let inHostCache: boolean | null = null

  /** 探测本身出问题时按「没有宿主」处理：宁可降级，也不能让插件白屏 */
  async function bridgeOrNull(): Promise<HostBridge | null> {
    try {
      return await getBridge()
    } catch {
      return null
    }
  }

  /** 包一层超时，超时用哨兵值区分「宿主没应答」与「正常返回」 */
  async function hostCall<T>(fn: () => Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
    const result = await withTimeout(
      fn().then((value) => {
        inHostCache = true
        return { value }
      }),
      ms,
      { value: TIMEOUT as unknown as T },
    )
    return result.value
  }

  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      const bridge = await bridgeOrNull()
      if (bridge) {
        try {
          const value = await hostCall(() => bridge.storage.get(key), HOST_TIMEOUT.storage)
          if (value !== TIMEOUT && value !== undefined) return value as T
        } catch {
          /* fallthrough */
        }
      }
      if (inHostCache) return undefined
      try {
        const raw = localStorage.getItem(FALLBACK_PREFIX + key)
        return raw == null ? undefined : (JSON.parse(raw) as T)
      } catch {
        return undefined
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      const bridge = await bridgeOrNull()
      if (bridge) {
        try {
          const result = await hostCall(() => bridge.storage.set(key, value), HOST_TIMEOUT.storage)
          if (result !== TIMEOUT) return
        } catch {
          /* fallthrough */
        }
      }
      try {
        localStorage.setItem(FALLBACK_PREFIX + key, JSON.stringify(value))
      } catch {
        /* 忽略 */
      }
    },
    async remove(key: string): Promise<void> {
      const bridge = await bridgeOrNull()
      if (bridge) {
        try {
          const result = await hostCall(() => bridge.storage.remove(key), HOST_TIMEOUT.storage)
          if (result !== TIMEOUT) return
        } catch {
          /* fallthrough */
        }
      }
      try {
        localStorage.removeItem(FALLBACK_PREFIX + key)
      } catch {
        /* 忽略 */
      }
    },
    async all<T extends Record<string, unknown>>(): Promise<T> {
      const bridge = await bridgeOrNull()
      if (bridge) {
        try {
          const value = await hostCall(() => bridge.storage.all(), HOST_TIMEOUT.storage)
          if (value !== TIMEOUT && value) return value as T
        } catch {
          /* fallthrough */
        }
      }
      if (inHostCache) return {} as T
      const out: Record<string, unknown> = {}
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (!k?.startsWith(FALLBACK_PREFIX)) continue
          try {
            out[k.slice(FALLBACK_PREFIX.length)] = JSON.parse(localStorage.getItem(k) as string)
          } catch {
            /* 跳过坏数据 */
          }
        }
      } catch {
        /* 忽略 */
      }
      return out as T
    },
  }

  return {
    /** 是否运行在宿主内（开发环境下为 false） */
    async inHost(): Promise<boolean> {
      return (await bridgeOrNull()) !== null
    },

    async getSearchContent(): Promise<string> {
      const bridge = await bridgeOrNull()
      if (bridge) {
        try {
          return (await withTimeout(bridge.getSearchContent(), HOST_TIMEOUT.context, '')) ?? ''
        } catch {
          /* fallthrough */
        }
      }
      return ''
    },

    async setSearchContent(value: string): Promise<void> {
      const bridge = await bridgeOrNull()
      try {
        if (bridge) await withTimeout(bridge.setSearchContent(value), HOST_TIMEOUT.context, false)
      } catch {
        /* 忽略：宿主不支持 set */
      }
    },

    async clearSearchContent(): Promise<void> {
      const bridge = await bridgeOrNull()
      try {
        if (bridge) await withTimeout(bridge.clearSearchContent(), HOST_TIMEOUT.context, false)
      } catch {
        /* 忽略 */
      }
    },

    /** 监听宿主搜索框，返回取消函数（宿主不可用时为空操作） */
    watchSearchContent(cb: (val: string) => void): () => void {
      let stop: (() => void) | undefined
      let disposed = false
      void bridgeOrNull().then((bridge) => {
        if (disposed || !bridge) return
        try {
          stop = bridge.watchSearchContent(cb)
        } catch {
          /* 忽略 */
        }
      })
      return () => {
        disposed = true
        try {
          stop?.()
        } catch {
          /* 忽略 */
        }
      }
    },

    /** 注册底部操作栏（footer），宿主不可用时静默失败 */
    async setFooter(buttons: unknown): Promise<boolean> {
      const bridge = await bridgeOrNull()
      try {
        if (!bridge) return false
        return (await withTimeout(bridge.setFooter(buttons), HOST_TIMEOUT.action, false)) ?? false
      } catch {
        return false
      }
    },

    /** 触发宿主截图流程（截图结果通常进入系统剪贴板） */
    async triggerScreenshot(): Promise<boolean> {
      const bridge = await bridgeOrNull()
      try {
        if (!bridge) return false
        return (await withTimeout(bridge.triggerScreenshot(), 8000, false)) ?? false
      } catch {
        return false
      }
    },

    /** 调用同插件下 `mode: "script"` 的 Node Worker 脚本 */
    async runScript<T>(command: string, args?: unknown, timeoutMs = 10_000): Promise<T | null> {
      const bridge = await bridgeOrNull()
      try {
        if (!bridge) return null
        // 超时与「脚本没返回」统一落成 null，调用方只需判空（与改造前一致）
        const value = await withTimeout<unknown>(bridge.runScript(command, args, timeoutMs), timeoutMs, null)
        return (value ?? null) as T | null
      } catch {
        return null
      }
    },

    storage,
  }
}

export type HostCalls = ReturnType<typeof createHostCalls>
