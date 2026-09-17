import type { ActionDecl, Config, ResultItem } from '@launcher/plugin-manifest'
import { LauncherError } from '@launcher/plugin-manifest'
import type { Kernel } from './kernel'
import type { HttpRequestContext } from './http/server'

function body<T extends Record<string, unknown>>(ctx: HttpRequestContext): T {
  return (ctx.body ?? {}) as T
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new LauncherError('BAD_ARGS', `${field} 必填`)
  return value
}

/** 注册启动台 UI ↔ 内核的全部 HTTP 接口（ADR-0001） */
export function registerApi(kernel: Kernel): void {
  const server = kernel.uiServer

  server.get('/api/health', () => ({ ok: true, version: kernel.version, ui: server.address }))

  server.get('/api/bootstrap', () => {
    const config = kernel.config.get()
    return {
      ok: true,
      version: kernel.version,
      platform: process.platform,
      dataRoot: kernel.dataRoot,
      config,
      theme: kernel.hostUi.state.theme,
      plugins: kernel.plugins.info(),
      snapshot: kernel.snapshot(),
      historyLimit: config.historyLimit,
    }
  })

  server.post('/api/search', async (ctx) => {
    const { query } = body<{ query?: string }>(ctx)
    kernel.hostUi.setQuery(String(query ?? ''))
    const result = await kernel.search.search(String(query ?? ''))
    return { ok: true, ...result }
  })

  /** 执行结果项的默认动作 / 指定命令 */
  server.post('/api/exec', async (ctx) => {
    const payload = body<{
      pluginId?: string
      command?: string
      args?: unknown
      item?: ResultItem
      action?: ActionDecl
    }>(ctx)
    const pluginId = required(payload.pluginId, 'pluginId')

    if (payload.action) {
      return { ok: true, result: await kernel.runAction(payload.action, { pluginId, command: payload.command ?? '' }) }
    }
    if (payload.item) {
      return {
        ok: true,
        result: await kernel.executeItem(pluginId, payload.item, payload.args, payload.command),
      }
    }
    const result = await kernel.invoke(`${pluginId}:${required(payload.command, 'command')}`, payload.args, 'ui')
    return { ok: true, result }
  })

  /** 只跑命令（不带结果项），主要用于 UI 内部（如托盘动作） */
  server.post('/api/invoke', async (ctx) => {
    const payload = body<{ id?: string; args?: unknown }>(ctx)
    const id = required(payload.id, 'id')
    return { ok: true, result: await kernel.invoke(id, payload.args, 'ui') }
  })

  server.get('/api/history', () => ({
    ok: true,
    items: kernel.history.allRecent(),
    pinned: kernel.history.pinnedList(),
    limit: kernel.config.get().historyLimit,
  }))

  server.post('/api/history/remove', async (ctx) => {
    const { key } = body<{ key?: string }>(ctx)
    kernel.history.remove(required(key, 'key'))
    return { ok: true }
  })

  server.post('/api/history/clear', async () => {
    kernel.history.clearHistory()
    kernel.bus.emit('history/changed', {})
    return { ok: true }
  })

  server.post('/api/pinned/toggle', async (ctx) => {
    const payload = body<{
      key?: string
      pluginId?: string
      command?: string
      title?: string
      subtitle?: string
      icon?: string
      args?: unknown
      action?: ActionDecl
    }>(ctx)
    const key = required(payload.key, 'key')
    if (kernel.history.isPinned(key)) {
      kernel.history.unpin(key)
      kernel.bus.emit('pinned/changed', { key, pinned: false })
      return { ok: true, pinned: false }
    }
    const item = {
      key,
      pluginId: required(payload.pluginId, 'pluginId'),
      command: required(payload.command, 'command'),
      title: required(payload.title, 'title'),
      ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
      ...(payload.icon ? { icon: payload.icon } : {}),
      ...(payload.args !== undefined ? { args: payload.args } : {}),
      ...(payload.action ? { action: payload.action } : {}),
    }
    kernel.history.pin(item)
    kernel.bus.emit('pinned/changed', { key, pinned: true })
    return { ok: true, pinned: true }
  })

  server.post('/api/pinned/reorder', async (ctx) => {
    const { keys } = body<{ keys?: string[] }>(ctx)
    if (!Array.isArray(keys)) throw new LauncherError('BAD_ARGS', 'keys 必须是数组')
    const list = kernel.history.reorder(keys)
    kernel.bus.emit('pinned/changed', { reordered: true })
    return { ok: true, pinned: list }
  })

  server.get('/api/config', () => ({ ok: true, config: kernel.config.get() }))

  server.post('/api/config', async (ctx) => {
    const patch = body<Record<string, unknown>>(ctx)
    // 写入收口在 `Kernel.patchConfig`（落盘 + 副作用 + 广播 `config/changed`），这里只负责转发
    const result = await kernel.patchConfig(patch as Partial<Config>)
    return { ok: true, ...result }
  })

  server.post('/api/ui/theme', async (ctx) => {
    const { theme } = body<{ theme?: string }>(ctx)
    kernel.hostUi.state.theme = theme === 'light' ? 'light' : 'dark'
    return { ok: true }
  })

  // ── 插件管理 ────────────────────────────────────────────────
  server.get('/api/plugins', () => ({ ok: true, plugins: kernel.plugins.info() }))

  server.post('/api/plugins/action', async (ctx) => {
    const payload = body<{
      action?: string
      id?: string
      path?: string
      command?: string
      keywords?: string[]
      capability?: string
      denied?: boolean
      overwrite?: boolean
    }>(ctx)
    return kernel.pluginAction(required(payload.action, 'action'), payload as Record<string, unknown>)
  })

  /** 开发模式：把 dev server 注册到运行中的内核（热更新免重启） */
  server.post('/api/dev/register', async (ctx) => {
    const payload = body<{ id?: string; devUrl?: string }>(ctx)
    const id = required(payload.id, 'id')
    const devUrl = required(payload.devUrl, 'devUrl')
    const config = kernel.config.get()
    const devPlugins = { ...config.devPlugins }
    if (devUrl === '') delete devPlugins[id]
    else devPlugins[id] = devUrl
    await kernel.config.patch({ devPlugins })
    await kernel.plugins.reloadOrLoad(id)
    return { ok: true }
  })

  /** 插件页 → 宿主（由启动台 UI 转发） */
  server.post('/api/bridge', async (ctx) => {
    const payload = body<{ sid?: string; token?: string; id?: number; method?: string; params?: Record<string, unknown> }>(ctx)
    const result = await kernel.bridge.dispatch({
      sid: required(payload.sid, 'sid'),
      token: required(payload.token, 'token'),
      id: Number(payload.id ?? 0),
      method: required(payload.method, 'method'),
      ...(payload.params ? { params: payload.params } : {}),
    })
    return result
  })

  server.post('/api/session/close', async (ctx) => {
    const { sid } = body<{ sid?: string }>(ctx)
    const closed = kernel.sessions.close(required(sid, 'sid'), 'ui')
    return { ok: closed }
  })

  server.post('/api/session/crashed', async (ctx) => {
    const { sid, reason } = body<{ sid?: string; reason?: string }>(ctx)
    const session = kernel.sessions.get(required(sid, 'sid'))
    if (session) kernel.plugins.markCrashed(session.pluginId, reason ?? '插件页崩溃')
    return { ok: true }
  })

  // ── 窗口 / 系统 ─────────────────────────────────────────────
  server.post('/api/window/show', async () => {
    await kernel.showWindowAnimated(true)
    return { ok: true }
  })
  server.post('/api/window/hide', async () => {
    await kernel.hideWindowAnimated()
    return { ok: true }
  })
  /**
   * UI 回执：离场动画的最后一帧**已经画出来了** → 现在可以真正隐藏了。
   *
   * 带回来的 `opacity` 是**证据**：它就是「下次唤出时会先亮出来的旧画面」的不透明度，
   * 必须是 0。哪天它又不为 0（而回执也照样来了），说明「先演再走」的时序又被谁改坏了。
   */
  server.post('/api/window/hidden', async (ctx) => {
    const payload = body<{ opacity?: number; elapsedMs?: number }>(ctx)
    kernel.log('debug', `[hide-ack] opacity=${payload.opacity ?? '-'} elapsed=${payload.elapsedMs ?? '-'}ms`)
    kernel.finishWindowHide()
    return { ok: true }
  })
  /** UI 挂载时问一次：窗口可能已经被壳显示过了（用户提前按了热键），
   *  不知道这一点就会先闪一下满不透明的界面再补入场动画 */
  server.get('/api/window/visible', async () => ({ ok: true, visible: await kernel.primitives.isVisible() }))
  server.post('/api/window/setHeight', async (ctx) => {
    const { height } = body<{ height?: number }>(ctx)
    const value = Number(height)
    if (!Number.isFinite(value)) throw new LauncherError('BAD_ARGS', 'height 必须是数字')
    await kernel.primitives.setHeight(Math.min(640, Math.max(320, Math.round(value))))
    return { ok: true }
  })
  server.post('/api/app/quit', async () => {
    // 不 await：`quit()` 会停掉 UI 服务，之后再写响应就来不及了 —— 先让本次响应出去，再收尾
    void kernel.quit()
    return { ok: true }
  })
  server.post('/api/app/autostart', async (ctx) => {
    const { enabled } = body<{ enabled?: boolean }>(ctx)
    await kernel.primitives.setAutostart(Boolean(enabled))
    return { ok: true }
  })
  server.post('/api/data/openDir', async () => {
    await kernel.primitives.shellFor('kernel').openPath(kernel.dataRoot)
    return { ok: true }
  })

  // ── 审计 ────────────────────────────────────────────────────
  server.get('/api/audit', (ctx) => {
    const limit = Number(ctx.query.get('limit') ?? 200)
    return { ok: true, records: kernel.audit.query({ limit: Number.isFinite(limit) ? limit : 200 }), file: '' }
  })
  server.post('/api/audit/clear', async () => {
    await kernel.audit.clear()
    return { ok: true }
  })

  // ── 壳 → 内核 的通知（壳通过 JSON-RPC 调用这些）────────────
  // 显隐切换的**结果**（不是"按键"）：壳已经完成了显示/隐藏，内核只广播状态。
  // 这里绝不能再自己 isVisible → hide/show 一遍 —— 那会让一次热键被 toggle 两遍
  // （壳刚显示 → 内核立刻隐藏），表现为"按热键窗口闪一下就消失"；托盘正常正是因为它不经过这里。
  kernel.link.handle('window/toggled', async (params) => {
    const visible = params.visible === true
    if (visible) {
      // 重新唤出要把还排在队里的那次隐藏作废：热键连按不能被上一次隐藏偷走窗口
      kernel.cancelPendingHide()
      // 显示晚一点广播：等窗口上屏 + webview 恢复绘制，否则入场动画会被吞
      await kernel.emitVisibleAnimated()
    } else {
      // 壳只报告「该隐藏了」这个意图：真正落地由内核在 UI 回执之后执行
      // （广播 + 等回执 + 兜底都在 `hideWindowAnimated` 里）。这里刻意不等它 ——
      // 否则热键连按时，显示那条通知会被上一次隐藏的回执拖住。
      void kernel.hideWindowAnimated()
    }
    return { ok: true }
  })
  kernel.link.handle('tray/menu', async (params) => {
    await kernel.handleTrayMenu(String(params.id ?? ''))
    return { ok: true }
  })
  kernel.link.handle('window/blurred', async () => {
    if (!kernel.config.get().hideOnBlur) return { ok: true }
    await kernel.hideWindowAnimated()
    return { ok: true }
  })
  kernel.link.handle('kernel/ready', async () => {
    kernel.link.markConnected()
    // 壳在 listen 之前就可能来问：必须显式给出 ready，并统一字段名为 uiPort
    if (!kernel.isReady) return { ok: false, ready: false }
    return {
      ok: true,
      ready: true,
      uiPort: kernel.uiServer.address,
      version: kernel.version,
      dataRoot: kernel.dataRoot,
    }
  })
  kernel.link.handle('app/shutdown', async () => {
    // 壳发起的退出：不必回请壳（它自己正在退）；延迟 exit 让这条响应先写出去
    await kernel.quit({ quitShell: false })
    return { ok: true }
  })
}

export type { ResultItem }
