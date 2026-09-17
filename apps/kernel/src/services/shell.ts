import { execFile } from 'node:child_process'
import { URL } from 'node:url'
import { LauncherError } from '@launcher/plugin-manifest'
import type { AuditLog } from '../audit'
import type { ShellLink } from '../jsonrpc'
import { audited } from './audited'
import type { ClipboardService, NotifyService, ScreenshotService, ShellService } from './types'

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * 系统原语（requirements §6.1）。壳只提供原语，不做业务；
 * 这里做参数校验 + 审计，再转发给壳。
 */
export class Primitives {
  constructor(
    private readonly link: ShellLink,
    private readonly audit: AuditLog,
  ) {}

  // ── 插件侧视图 ──────────────────────────────────────────────
  shellFor(pluginId: string): ShellService {
    return {
      openUrl: async (url: string) => {
        await audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.shell.openUrl', 'shell.open', { url }, async () => {
          assertHttpUrl(url)
          await this.link.request('open.url', { url })
        })
      },
      openPath: async (target: string) => {
        await audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.shell.openPath', 'shell.open', { target }, async () => {
          assertPath(target)
          await this.link.request('open.path', { path: target })
        })
      },
      reveal: async (target: string) => {
        await audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.shell.reveal', 'shell.open', { target }, async () => {
          assertPath(target)
          await this.link.request('open.reveal', { path: target })
        })
      },
    }
  }

  clipboardFor(pluginId: string): ClipboardService {
    return {
      readText: async () =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.clipboard.readText', 'clipboard.read', undefined, async () => {
          const text = await this.link.request<{ text?: string } | string>('clipboard.readText')
          if (typeof text === 'string') return text
          return text?.text ?? ''
        }),
      writeText: async (text: string) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.clipboard.writeText', 'clipboard.write', { text }, async () => {
          await this.link.request('clipboard.writeText', { text: String(text ?? '') })
        }),
    }
  }

  notifyFor(pluginId: string): NotifyService {
    return {
      show: async (opts) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.notify.show', 'notify.show', opts, async () => {
          const res = await this.link.request<{ ok?: boolean; reason?: string }>('notify.show', {
            title: opts?.title ?? '',
            body: opts?.body ?? '',
            silent: Boolean(opts?.silent),
          })
          return res?.ok !== false
        }),
    }
  }

  screenshotFor(pluginId: string): ScreenshotService {
    return {
      start: async () =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.screenshot.start', 'screenshot', undefined, async () => {
          // 区域截图 → 系统剪贴板（requirements §8.6：只返回是否成功触发）。
          //
          // 注意：这里是内核里**唯一**直接执行系统命令的地方 —— 理想形态是壳提供 `screenshot`
          // 原语（与 clipboard / notify / opener 并列），交互式截图（`-i`）无法自动化验证、
          // 下沉要重打包实机确认，所以先在 `docs/architecture.md` 差异清单 D18 记录现状。
          if (process.platform !== 'darwin') return false
          return new Promise<boolean>((resolve) => {
            execFile('screencapture', ['-i', '-c'], (err) => resolve(!err))
          })
        }),
    }
  }

  // ── 宿主内部（UI / 内核自己调用，不审计插件）────────────────
  /**
   * 显示窗口。返回壳在**上屏之前**读到的前台选中文本（读不到就是 undefined）。
   * 时机只有壳抓得住：窗口一显示，前台 App 就成了自己（requirements §3.1）。
   */
  async showWindow(focus = true): Promise<{ selection?: string }> {
    const res = await this.link.request<{ selection?: unknown }>('window.show', { focus })
    const selection = typeof res?.selection === 'string' ? res.selection : ''
    return selection ? { selection } : {}
  }

  async hideWindow(): Promise<void> {
    await this.link.request('window.hide')
  }

  /** 无边框窗口：UI 在拖拽区 mousedown 时调用（系统接管后续移动） */
  async startDragging(): Promise<void> {
    await this.link.request('window.startDragging')
  }

  /** 无边框窗口的四边 / 四角缩放（方向见 `window.rs` 的映射表） */
  async startResizeDragging(direction: string): Promise<void> {
    await this.link.request('window.startResizeDragging', { direction })
  }

  /**
   * 窗口当前是否可见。**问不到就返回 `null`，绝不退化成 `false`。**
   *
   * 「壳没连上（standalone / `pnpm dev`）」和「窗口确实被藏起来了」是两件完全不同的事。
   * 混成一个 `false` 的后果不是少一次动画，而是 UI 把整个界面调成透明
   * —— 浏览器里开发启动台时会直接白屏，且现象完全不指向根因。
   */
  async isVisible(): Promise<boolean | null> {
    if (!this.link.connected) return null
    try {
      return Boolean(await this.link.request<boolean>('window.isVisible'))
    } catch {
      return null
    }
  }

  async setHeight(height: number): Promise<void> {
    await this.link.request('window.setHeight', { height })
  }

  /**
   * 用户记忆的窗口尺寸（宽高一起给）。与 `setHeight` 是两条路：
   * 前者是内容自适应的紧凑弹窗，这个是"用户拉过、我们记住了"的形态。
   * 越界值由壳与配置两侧各自钳制（壳是最后一道，防止 UI 算错）。
   */
  async setSize(width: number, height: number): Promise<void> {
    await this.link.request('window.setSize', { width, height })
  }

  /**
   * 壳进程自身的占用（常驻内存 + 累计 CPU 毫秒）—— 状态条要"启动台一共占多少"，
   * 内核算得了自己那一半，壳那一半只有壳知道（见 `primitives/usage.rs`）。
   *
   * 壳没连上 / 老版本壳不认这个原语 / 超时：一律返回 `null`，
   * 由调用方退化成"只报内核" —— 状态条不能因为这个数字拿不到就整个消失。
   */
  async appUsage(): Promise<{ rss: number; cpuMs: number } | null> {
    if (!this.link.connected) return null
    try {
      // 800ms：它串在 3s 一次的状态条请求里，别用默认 3s 超时拖住整次采样
      const res = await this.link.request<{ ok?: boolean; rss?: unknown; cpuMs?: unknown }>('app.usage', {}, 800)
      if (!res || res.ok === false) return null
      const rss = Number(res.rss)
      const cpuMs = Number(res.cpuMs)
      if (!Number.isFinite(rss) || !Number.isFinite(cpuMs) || rss <= 0) return null
      return { rss, cpuMs }
    } catch {
      return null
    }
  }

  async registerHotkey(
    accelerator: string,
  ): Promise<{ ok: boolean; reason?: string; accelerator?: string; fallback?: boolean }> {
    try {
      const res = await this.link.request<{
        ok?: boolean
        reason?: string
        accelerator?: string
        fallback?: boolean
      }>('hotkey.register', { accelerator })
      return {
        ok: res?.ok !== false,
        ...(res?.reason ? { reason: res.reason } : {}),
        ...(res?.accelerator ? { accelerator: res.accelerator } : {}),
        ...(res?.fallback ? { fallback: true } : {}),
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : '热键注册失败' }
    }
  }

  async setAutostart(enabled: boolean): Promise<void> {
    await this.link.request('app.setAutostart', { enabled })
  }

  async setTrayMenu(items: Array<{ id: string; label: string; type?: 'item' | 'separator' }>): Promise<void> {
    await this.link.request('tray.setMenu', { items })
  }

  async quit(): Promise<void> {
    await this.link.request('app.quit')
  }
}

export function assertHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LauncherError('BAD_ARGS', `非法 URL：${url}`)
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new LauncherError('BAD_ARGS', `只允许 http/https/mailto：${parsed.protocol}`)
  }
}

export function assertPath(target: string): void {
  if (typeof target !== 'string' || !target.trim()) {
    throw new LauncherError('BAD_ARGS', 'path 必须是非空字符串')
  }
}
