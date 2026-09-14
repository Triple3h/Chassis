/**
 * 宿主能力封装（插件页唯一出口）。
 *
 * 双宿主：**启动台（@launcher/api）** 与 **如快 Sofast（@sofastapp/api）**。
 * 4 个插件的业务代码只认这里导出的函数名，宿主差异全部收敛在本文件 + `host-adapter.ts`。
 *
 * 三层分工：
 *   platform.ts      —— 宿主探测（本文件）＋ 对外导出（签名与宿主无关）
 *   host-adapter.ts  —— 「谁来接这个调用」：两套 SDK → 一个 HostBridge
 *   host-calls.ts    —— 「怎么调」：超时 / 哨兵值 / localStorage 兜底（两个宿主逐字相同）
 *
 * 设计要点：
 * 1. 两个 SDK 都走**动态 import** —— 插件在浏览器里 `npm run dev` 时没有宿主，
 *    顶层静态 import 会让开发调试直接炸掉；
 * 2. 所有调用都吞掉异常并加超时（见 host-calls.ts）；
 * 3. 宿主探测**不能只看 `window.top !== window` / `sid` 参数** —— 如快的 `inSofastIframe()`
 *    与新底座的 `isLauncher()` 在对方宿主里同样为真。所以这里对两个宿主各发一次
 *    「只读探针」，谁先应答就是谁。
 *
 * 契约：导出函数的签名与返回值语义**不得**随宿主改变（docs/first-batch-plugins.md §8）。
 */

import { createLauncherBridge, createSofastBridge, type HostBridge, type LauncherLike, type SofastLike } from './host-adapter'
import { createHostCalls } from './host-calls'

export interface SessionInfo {
  /** 宿主为本次会话分配的 id */
  sid: string;
  /** 当前命令名，一个 index.html 可通过它做内部路由 */
  cmd: string;
  /** 宿主可能透传的主题 */
  theme: 'dark' | 'light' | ''
}

export function readSession(): SessionInfo {
  const q = new URLSearchParams(location.search)
  const theme = q.get('theme')
  return {
    sid: q.get('sid') ?? '',
    cmd: q.get('cmd') ?? '',
    theme: theme === 'dark' || theme === 'light' ? theme : '',
  }
}

/** 宿主探针超时：本地一次 postMessage 往返是毫秒级，300ms 已经是「对方没在听」 */
const PROBE_TIMEOUT = 300

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

async function importLauncher(): Promise<LauncherLike | null> {
  try {
    const mod = (await import('@launcher/api')) as unknown as LauncherLike
    return mod?.host ? mod : null
  } catch {
    return null // 构建期兜底 / 未打进产物
  }
}

async function importSofast(): Promise<SofastLike | null> {
  try {
    const mod = (await import('@sofastapp/api')) as unknown as SofastLike
    return mod?.Context ? mod : null
  } catch {
    return null
  }
}

/**
 * 启动台探针：`host.info` 只读，且只有真底座会按原生协议（`__launcher: 1`）应答。
 * 如快收到这条消息会当噪声忽略 ⇒ 必然超时。
 */
async function probeLauncher(api: LauncherLike): Promise<boolean> {
  const info = await withTimeout(
    api.host.info().then(
      (value) => value,
      () => null,
    ),
    PROBE_TIMEOUT,
    null,
  )
  return Boolean(info && typeof (info as { pluginId?: unknown }).pluginId === 'string')
}

/** 如快探针：读一次搜索框内容，同样只读、无副作用 */
async function probeSofast(api: SofastLike): Promise<boolean> {
  try {
    if (!api.inSofastIframe?.()) return false
  } catch {
    return false
  }
  const value = await withTimeout(
    api.Context.getSearchContent().then(
      (v) => v,
      () => undefined,
    ),
    PROBE_TIMEOUT,
    undefined,
  )
  // 如快对未知/失配的请求不会应答；能拿到字符串说明桥是活的
  return typeof value === 'string'
}

let bridgePromise: Promise<HostBridge | null> | null = null

/** 探测宿主（结论缓存，整个会话只探一次）。两个宿主都认不出 ⇒ null（浏览器 dev） */
function detectBridge(): Promise<HostBridge | null> {
  bridgePromise ??= (async () => {
    const [launcher, sofast] = await Promise.all([importLauncher(), importSofast()])

    let launcherUsable = false
    try {
      launcherUsable = Boolean(launcher?.host?.isLauncher?.())
    } catch {
      launcherUsable = false
    }

    // 两个探针并发：谁先应答就是谁，两个都不应 ⇒ 无宿主。
    // 顺序上启动台优先（原生协议是底座自己的，如快那条只是兼容）。
    const [okLauncher, okSofast] = await Promise.all([
      launcherUsable && launcher ? probeLauncher(launcher) : Promise.resolve(false),
      sofast ? probeSofast(sofast) : Promise.resolve(false),
    ])

    if (okLauncher && launcher) return createLauncherBridge(launcher)
    if (okSofast && sofast) return createSofastBridge(sofast)
    return null
  })()
  return bridgePromise
}

const calls = createHostCalls(detectBridge)

export const inHost = calls.inHost
export const getSearchContent = calls.getSearchContent
export const setSearchContent = calls.setSearchContent
export const clearSearchContent = calls.clearSearchContent
export const watchSearchContent = calls.watchSearchContent
export const setFooter = calls.setFooter
export const triggerScreenshot = calls.triggerScreenshot
export const runScript = calls.runScript
export const storage = calls.storage

export { HOST_TIMEOUT } from './host-calls'
export type { FooterButton } from './host-calls'
