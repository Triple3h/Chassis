/**
 * 宿主适配：把两套 SDK 折叠成同一组调用。
 *
 * 为什么要有这一层（而不是在 platform.ts 里 if/else）：
 *  - 两个宿主的**语义不同但用法相同** —— 如快是 `Context.getSearchContent()`，
 *    启动台是 `hostUi.getSearchContent()`；适配后上层只认一套；
 *  - 这里只做「调用映射」，**不含**超时、哨兵值、localStorage 兜底（那些在 platform.ts，
 *    对两个宿主必须完全一致，见 docs/first-batch-plugins.md §8 风险表）；
 *  - 纯函数 + 结构化入参 ⇒ 可以直接拿假宿主单测，不需要浏览器、不需要真 SDK。
 *
 * 约束：本文件不接受任何 `window` / `localStorage` 依赖，保证在 Node 里可测。
 */

/** 适配层需要的最小宿主面（启动台 SDK 侧） */
export interface LauncherLike {
  host: {
    isLauncher(): boolean
    /** 探针用：只有真底座会应答原生协议（platform.ts 的 detectBridge） */
    info(): Promise<unknown>
  }
  hostUi: {
    getSearchContent(): Promise<string>
    setSearchContent(value: string): Promise<boolean>
    clearSearchContent(): Promise<boolean>
    setFooter(buttons: unknown): Promise<boolean>
    watchSearchContent(fn: (value: string) => void): () => void
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<unknown>
    remove(key: string): Promise<unknown>
    all(): Promise<Record<string, unknown>>
  }
  exec: {
    run(payload: { command: string; args?: unknown; timeoutMs?: number }): Promise<unknown>
  }
  screenshot: {
    start(): Promise<boolean>
  }
}

/** 适配层需要的最小宿主面（如快 SDK 侧） */
export interface SofastLike {
  inSofastIframe?: () => boolean
  Context: {
    getSearchContent(): Promise<string>
    setSearchContent(value: string): Promise<boolean>
    clearSearchContent(): Promise<boolean>
    setFooter(buttons: unknown): Promise<boolean>
    watchSearchContent(fn: (value: string) => void): () => void
  }
  LocalStorage: {
    getItem(key: string): Promise<unknown>
    setItem(key: string, value: unknown): Promise<unknown>
    removeItem(key: string): Promise<unknown>
    allItems(): Promise<Record<string, unknown>>
  }
  Backend: {
    run(command: string, args?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  }
  Screenshot: {
    start(): Promise<boolean>
  }
}

/** 统一后的宿主调用面 */
export interface HostBridge {
  /** 命中的是哪个宿主（排障与埋点用） */
  readonly kind: 'launcher' | 'sofast'
  getSearchContent(): Promise<string>
  setSearchContent(value: string): Promise<boolean>
  clearSearchContent(): Promise<boolean>
  watchSearchContent(cb: (value: string) => void): () => void
  setFooter(buttons: unknown): Promise<boolean>
  triggerScreenshot(): Promise<boolean>
  runScript(command: string, args: unknown, timeoutMs: number): Promise<unknown>
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<unknown>
    remove(key: string): Promise<unknown>
    all(): Promise<Record<string, unknown>>
  }
}

export function createLauncherBridge(api: LauncherLike): HostBridge {
  return {
    kind: 'launcher',
    getSearchContent: () => api.hostUi.getSearchContent(),
    setSearchContent: (value) => api.hostUi.setSearchContent(value),
    clearSearchContent: () => api.hostUi.clearSearchContent(),
    watchSearchContent: (cb) => api.hostUi.watchSearchContent(cb),
    setFooter: (buttons) => api.hostUi.setFooter(buttons),
    triggerScreenshot: () => api.screenshot.start(),
    // 启动台把「跑本插件脚本」收在 exec.run；超时由调用方给（脚本可能是提权等待，很长）
    runScript: (command, args, timeoutMs) => api.exec.run({ command, args, timeoutMs }),
    storage: {
      get: (key) => api.storage.get(key),
      set: (key, value) => api.storage.set(key, value),
      remove: (key) => api.storage.remove(key),
      all: () => api.storage.all(),
    },
  }
}

export function createSofastBridge(api: SofastLike): HostBridge {
  return {
    kind: 'sofast',
    getSearchContent: () => api.Context.getSearchContent(),
    setSearchContent: (value) => api.Context.setSearchContent(value),
    clearSearchContent: () => api.Context.clearSearchContent(),
    watchSearchContent: (cb) => api.Context.watchSearchContent(cb),
    setFooter: (buttons) => api.Context.setFooter(buttons),
    triggerScreenshot: () => api.Screenshot.start(),
    // 如快把「跑本插件脚本」叫 Backend.run(command, args, { timeoutMs })
    runScript: (command, args, timeoutMs) => api.Backend.run(command, args, { timeoutMs }),
    storage: {
      get: (key) => api.LocalStorage.getItem(key),
      set: (key, value) => api.LocalStorage.setItem(key, value),
      remove: (key) => api.LocalStorage.removeItem(key),
      all: () => api.LocalStorage.allItems(),
    },
  }
}
