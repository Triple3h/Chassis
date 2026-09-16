import path from 'node:path'
import { LauncherError, toErrorShape, type ActionResult, type ActionDecl, type ResultItem } from '@launcher/plugin-manifest'
import { AuditLog } from './audit'
import { ConfigStore, DEFAULT_CONFIG, type Config } from './config'
import { EventBus } from './events'
import { HistoryStore } from './history'
import { OverrideStore } from './overrides'
import { ShellLink } from './jsonrpc'
import { Pipeline } from './pipeline'
import { CommandRegistry, SearchResultHub } from './registry'
import { SearchEngine, pluginKeyOf } from './search'
import { SessionManager } from './session'
import { PluginManager, type PluginRecord } from './plugin'
import { LEGACY_ID_TO_CURRENT } from './legacy'
import { PluginServerPool } from './http/pluginServers'
import { UiServer } from './http/server'
import { createKernelServices } from './services/kernel'
import { ScriptRuntime } from './services/exec'
import { PluginStorage } from './services/storage'
import { Primitives } from './services/shell'
import { HostUiBridge } from './services/hostUi'
import { QuicklinkStore } from './services/quicklink'
import { BridgeDispatcher } from './services/bridge'
import { createSettingsService, type SettingsHost, type SettingsService } from './services/settings'
import type { ExecContext, KernelEvent } from './types'
import { itemKey } from './util/text'

/**
 * 隐藏的**兜底**时长（ms）：等不到 UI 的回执也只能落地。
 *
 * 正常路径根本不看这个数：UI 演完离场动画会回执 `/api/window/hidden`，内核拿到就立刻隐藏
 * （见 `hideWindowAnimated`）。回执才是「演完了」的准确信号 —— 广播穿过 内核 → SSE → webview
 * 的耗时不可控，任何固定时长都可能砍在淡出中途，把半透明的一帧留成「下一场唤出先亮的旧画面」。
 *
 * 这个数只防「UI 没了 / SSE 断了 / 回执丢了」：500ms 比正常回执（约 140+100ms）宽裕一倍多。
 */
export const HIDE_FALLBACK_MS = 500

/**
 * 「显示」这条广播的延迟（ms）。
 *
 * 壳的 `show()` 只是把窗口排进显示队列：窗口真正上屏、webview 从「隐藏」恢复绘制
 * 还要几十毫秒，而 **CSS 的时间线在这段时间里照走**。广播发早了，UI 的入场动画会在
 * 窗口还没有画面的时候播完 —— 用户看到的是「啪」一下整块出现（实测反馈：动效好像没实现）。
 * 留这一段时间让窗口先跑到「能画」的状态，是入场动画能被看见的前提。
 */
export const SHOW_ANIMATION_MS = 80

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface KernelOptions {
  dataRoot: string
  /** 出厂插件根目录（可多个；开发态默认就是仓库根的 `plugins/`） */
  builtinRoots: string[]
  uiDistDir: string | null
  uiDevUrl?: string
  version: string
  /** 只用内存（测试用，不落盘） */
  ephemeral?: boolean
}

export function createLogger() {
  return (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void => {
    const line = `[kernel:${level}] ${message}`
    // 日志一律走 stderr：stdout 是壳的 JSON-RPC 通道
    if (data === undefined) process.stderr.write(`${line}\n`)
    else process.stderr.write(`${line} ${safeStringify(data)}\n`)
  }
}

function safeStringify(data: unknown): string {
  try {
    if (data instanceof Error) return data.stack || data.message
    return typeof data === 'string' ? data : JSON.stringify(data)
  } catch {
    return String(data)
  }
}

/** 内核装配（requirements §4.2 / §5） */
export class Kernel {
  readonly log = createLogger()
  readonly bus = new EventBus()
  readonly config: ConfigStore
  readonly audit: AuditLog
  readonly history: HistoryStore
  /** 插件别名等用户覆盖（`<dataRoot>/plugin-overrides.json`） */
  readonly overrides: OverrideStore
  readonly registry = new CommandRegistry()
  readonly hub = new SearchResultHub()
  readonly sessions = new SessionManager()
  readonly pipeline = new Pipeline()
  readonly servers = new PluginServerPool((level, msg) => this.log(level, msg))
  readonly link = new ShellLink()
  readonly storage: PluginStorage
  readonly quicklinks: QuicklinkStore
  readonly primitives: Primitives
  readonly hostUi: HostUiBridge
  readonly exec: ScriptRuntime
  readonly plugins: PluginManager
  readonly search: SearchEngine
  readonly bridge: BridgeDispatcher
  readonly uiServer: UiServer
  private services!: ReturnType<typeof createKernelServices>['services']
  private binder!: ReturnType<typeof createKernelServices>['binder']
  private started = false
  private readyFlag = false
  /** 正在「演离场」的那次隐藏（同一时刻只允许一次） */
  private pendingHide: Promise<void> | null = null
  /** 撤销令牌：唤出时 +1，让已经排队的隐藏落地前自己失效 */
  private hideToken = 0
  /** 显示广播的令牌：排队中的那次「晚一点广播」被新的显隐动作作废 */
  private showToken = 0
  /** 兜底定时器：UI 的回执一直不来也要落地（见 HIDE_FALLBACK_MS） */
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  /** 「现在落地」的入口：回执与兜底共用；没有排队的隐藏时为 null */
  private landPendingHide: (() => void) | null = null
  /** 让 `/api/window/hide` 的调用方等到真正落地（回执或兜底）再返回 */
  private resolvePendingHide: (() => void) | null = null

  constructor(private readonly opts: KernelOptions) {
    this.config = new ConfigStore(opts.dataRoot)
    this.audit = new AuditLog(opts.dataRoot)
    this.history = new HistoryStore(opts.dataRoot)
    this.overrides = new OverrideStore(opts.dataRoot)
    this.storage = new PluginStorage(opts.dataRoot, this.audit)
    this.quicklinks = new QuicklinkStore(opts.dataRoot, this.audit)
    this.primitives = new Primitives(this.link, this.audit)
    this.hostUi = new HostUiBridge(this.bus, this.audit, () => this.hideWindowAnimated())

    this.exec = new ScriptRuntime({
      resolvePluginDir: (pluginId) => this.plugins?.dirOf(pluginId),
      dataPathFor: (pluginId) => path.join(opts.dataRoot, 'plugins', pluginId),
      dataRoot: opts.dataRoot,
      log: (level, message, data) => this.log(level, message, data),
      onFailure: (pluginId, command) => this.plugins?.noteFailure(pluginId, command),
      handleRpc: (pluginId, method, params) => this.handleScriptRpc(pluginId, method, params),
    })

    const built = createKernelServices({
      version: opts.version,
      dataRoot: opts.dataRoot,
      audit: this.audit,
      bus: this.bus,
      registry: this.registry,
      hub: this.hub,
      pipeline: this.pipeline,
      storage: this.storage,
      primitives: this.primitives,
      hostUi: this.hostUi,
      quicklinks: this.quicklinks,
      exec: this.exec,
      getSession: (sid) => this.sessions.get(sid),
      capabilitiesOf: (pluginId) => this.plugins?.capabilitiesOf(pluginId) ?? new Set<string>(),
      invokeCommand: (id, args, source) => this.invoke(id, args, source),
      registerCommand: (pluginId, pluginTitle, decl) => {
        const record = this.plugins.get(pluginId)
        return this.registry.register({
          id: `${pluginId}:${decl.name}`,
          pluginId,
          pluginTitle,
          decl,
          capabilities: [...new Set([...(record?.manifest?.capabilities ?? []), ...(decl.capabilities ?? [])])],
        })
      },
      unregisterCommand: (id) => void this.registry.update(id, {}),
    })
    this.services = built.services
    this.binder = built.binder

    this.registry.bindInvoker((id, args, source) => this.invoke(id, args, source))

    this.plugins = new PluginManager({
      dataRoot: opts.dataRoot,
      builtinRoots: opts.builtinRoots,
      config: this.config,
      overrides: this.overrides,
      audit: this.audit,
      bus: this.bus,
      registry: this.registry,
      sessions: this.sessions,
      servers: this.servers,
      binder: this.binder,
      services: this.services,
      exec: this.exec,
      settingsFor: (pluginId) => this.createSettingsService(pluginId) as unknown as Record<string, unknown>,
      log: (level, message, data) => this.log(level, message, data),
      onChanged: () => {
        void this.refreshTray()
      },
    })

    // 底座基础能力（essential）的调用不进审计：等价于底座自身行为，且调用量大
    this.audit.setExempt((pluginId) => this.plugins.isEssential(pluginId))

    this.search = new SearchEngine({
      registry: this.registry,
      hub: this.hub,
      history: this.history,
      sessions: this.sessions,
      exec: this.exec,
      audit: this.audit,
      bus: this.bus,
      config: this.config,
      pluginTitleOf: (pluginId) => this.plugins.titleOf(pluginId),
      pluginBaseUrl: (pluginId) => this.plugins.baseUrlFor(pluginId),
      isResultAlive: (pluginId, command) => this.plugins.isResultAlive(pluginId, command),
    })

    this.bridge = new BridgeDispatcher({
      sessions: this.sessions,
      registry: this.registry,
      hub: this.hub,
      audit: this.audit,
      bus: this.bus,
      storage: this.storage,
      primitives: this.primitives,
      hostUi: this.hostUi,
      quicklinks: this.quicklinks,
      exec: this.exec,
      version: opts.version,
      dataRoot: opts.dataRoot,
      invokeCommand: (id, args, source) => this.invoke(id, args, source),
      capabilitiesOf: (pluginId) => this.plugins.capabilitiesOf(pluginId),
      settingsFor: (pluginId) => this.createSettingsService(pluginId),
    })

    this.uiServer = new UiServer({
      uiDistDir: opts.uiDistDir,
      ...(opts.uiDevUrl ? { uiDevUrl: opts.uiDevUrl } : {}),
      log: (level, message) => this.log(level, message),
      allowedOrigins: opts.uiDevUrl ? [new URL(opts.uiDevUrl).origin] : [],
    })

    this.bus.setSink((event, payload) => this.uiServer.broadcast(event, payload))
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.config.init()
    const config = await this.config.load()
    // 覆盖层要在插件装配（plugins.init）之前就位，否则首轮注册拿不到用户别名
    await this.overrides.load()
    await this.audit.init()
    await this.history.load(config.historyLimit)
    // 插件改过 id：历史 / 固定项里的旧 pluginId 与 key 前缀一次性迁移（否则老条目一律被判「插件不可用」置灰）
    const migrated = this.history.migratePluginIds(LEGACY_ID_TO_CURRENT)
    if (migrated.history || migrated.pinned) {
      this.log('info', `历史 / 固定项插件 id 迁移：历史 ${migrated.history} 条、固定 ${migrated.pinned} 条`)
    }

    this.hostUi.state.theme = config.theme === 'light' ? 'light' : 'dark'

    await this.uiServer.start()
    await this.plugins.init()
    await this.plugins.startWatcher()

    // 会话回收：关闭时把理由一起广播给 UI（`reload` ⇒ 重载完成后重开页面，其余 ⇒ 卸载 iframe）
    this.sessions.on((session, kind, reason) => {
      if (kind !== 'close') return
      this.bus.emit('session/closed', {
        sid: session.sid,
        pluginId: session.pluginId,
        command: session.command,
        reason: reason ?? 'close',
      })
    })

    await this.registerTray()
    await this.applyHotkey(config)
    if (config.autostart) await this.primitives.setAutostart(true).catch(() => undefined)

    this.log('info', `内核就绪：UI http://127.0.0.1:${this.uiServer.address}，数据目录 ${this.opts.dataRoot}`)
  }

  async stop(): Promise<void> {
    // 收尾时把还没落地的隐藏丢掉：否则定时器会在 UI 服务停掉之后再去敲壳
    this.cancelPendingHide()
    await this.plugins.dispose()
    await this.exec.shutdown()
    await this.servers.stopAll()
    await this.history.flush()
    await this.storage.flushAll()
    await this.uiServer.stop()
    this.started = false
  }

  /**
   * 注册全局热键。
   * 壳在被占用时会自动回退到候选键 —— 这里把**实际生效的键**写回配置，
   * 这样下次启动就能直接用可用的那个（自用场景下避免"每次都在试 Alt+Space"）。
   */
  async applyHotkey(config: Config): Promise<{ ok: boolean; reason?: string; accelerator?: string }> {
    const requested = config.hotkey.accelerator
    const result = await this.primitives.registerHotkey(requested)
    if (result.ok && result.accelerator && result.accelerator !== requested) {
      await this.config.patch({ hotkey: { accelerator: result.accelerator } }).catch(() => undefined)
      this.log('warn', `热键 ${requested} 不可用，已改用 ${result.accelerator}（已写回配置）`)
      this.bus.emit('plugin/state', { hotkey: { accelerator: result.accelerator, fallback: true } })
    } else if (!result.ok) {
      this.log('warn', `全局热键注册失败（${requested}）：${result.reason ?? '可能被占用'}`)
      this.bus.emit('plugin/state', { hotkey: { accelerator: requested, ...result } })
    }
    return result
  }

  /** 托盘菜单由内核提供（便于插件加项），壳只负责渲染 */
  async registerTray(): Promise<void> {
    await this.primitives
      .setTrayMenu([
        { id: 'show', label: '唤出启动台' },
        { id: 'separator-1', label: '', type: 'separator' },
        { id: 'settings', label: '设置…' },
        { id: 'plugins', label: '插件管理…' },
        { id: 'reload', label: '重载全部插件' },
        { id: 'separator-2', label: '', type: 'separator' },
        { id: 'quit', label: '退出' },
      ])
      .catch(() => undefined)
  }

  async refreshTray(): Promise<void> {
    await this.registerTray()
  }

  async handleTrayMenu(id: string): Promise<void> {
    switch (id) {
      case 'show':
        await this.showWindowAnimated(true)
        break
      case 'settings':
        await this.invoke('internal-settings:settings', undefined, 'host')
        break
      case 'plugins':
        await this.invoke('internal-settings:manage', undefined, 'host')
        break
      case 'reload':
        await this.plugins.reloadAll()
        break
      case 'quit':
        await this.shutdown()
        break
      default:
        break
    }
  }

  private async shutdown(): Promise<void> {
    this.bus.emit('shell/visibility', { visible: false })
    await this.stop()
    await this.primitives.quit().catch(() => undefined)
    process.exit(0)
  }

  // ── 窗口显隐的唯一收口（与壳的分工见 tests/contract/shell-link.test.ts）──
  //
  // 壳仍然独占「什么时候该显、什么时候该隐」的裁决权，内核只负责**让这次显隐好看一点**：
  // 把广播和真正落地拆成两步，中间留给 UI 播动画的时间。所有跨进程路径都必须走这两个方法，
  // 否则就会出现「有的入口有动画、有的入口啪一下」这种最难查的不一致。

  /** 显示窗口：先落地，再等窗口真的能画了才广播（见 `SHOW_ANIMATION_MS`） */
  async showWindowAnimated(focus = true): Promise<void> {
    this.cancelPendingHide()
    try {
      await this.primitives.showWindow(focus)
    } finally {
      // 广播一定要发出去：敲壳失败（壳没连上 / 窗口没了）时 UI 更不能停在「隐藏态」——
      // 那正好是一块透明窗口，用户会以为启动台压根没打开。显示这条路径只加不减。
      await this.emitVisibleAnimated()
    }
  }

  /**
   * 「显示」这条广播要**晚一点发**：等窗口上屏、webview 恢复绘制之后再让 UI 起入场动画
   *（原因写在 `SHOW_ANIMATION_MS` 上）。延迟期间又来了隐藏 / 新的显示，这一次就作废。
   */
  async emitVisibleAnimated(): Promise<void> {
    const token = ++this.showToken
    await delay(SHOW_ANIMATION_MS)
    if (token !== this.showToken) return
    this.bus.emit('shell/visibility', { visible: true })
  }

  /**
   * 隐藏窗口：先广播（UI 演离场动画），**等 UI 回执「最后一帧画出来了」才真正落地**。
   *
   * 为什么不能定时落地：广播要穿过 内核 → SSE → webview 才变成 CSS 的起点，
   * 这段延迟不可控；任何固定时长都可能砍在淡出中途 —— 被砍掉的那一帧（半透明面板）
   * 会被 webview 留成「最后一帧」，下次唤出时合成器先亮它（用户：「闪一下，像打开了两次」）。
   * 回执把「演完了」交给唯一知道答案的一方；`HIDE_FALLBACK_MS` 只防回执永远不来。
   *
   * 重复调用会搭同一班车（一次 `ctx.hostUi.hide` 会同时从内核和 UI 两条路走回来）。
   */
  async hideWindowAnimated(): Promise<void> {
    if (this.pendingHide) return this.pendingHide
    // 排队中的「显示广播」一并作废：先显后隐的连按不能被它补一帧可见
    this.showToken += 1
    this.bus.emit('shell/visibility', { visible: false })
    const token = ++this.hideToken
    this.pendingHide = new Promise<void>((resolve) => {
      this.resolvePendingHide = resolve
      this.landPendingHide = () => {
        // 令牌被换过 = 这次已经作废（被唤出撤销、或已排了新的一次）：什么都不动
        if (token !== this.hideToken) return
        this.settlePendingHide()
        void this.hideWindowNow()
      }
      this.hideTimer = setTimeout(() => this.landPendingHide?.(), HIDE_FALLBACK_MS)
    })
    return this.pendingHide
  }

  /** UI 回执：离场动画的最后一帧已经画出来了 —— 现在可以落地了 */
  finishWindowHide(): void {
    this.landPendingHide?.()
  }

  /** 撤销尚在排队的隐藏（热键连按不能被上一次隐藏偷走窗口） */
  cancelPendingHide(): void {
    this.hideToken += 1
    this.settlePendingHide()
  }

  /** 收尾一次排队中的隐藏：定时器、入口、等待者一并清掉（重复调用无副作用） */
  private settlePendingHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.landPendingHide = null
    this.pendingHide = null
    const resolve = this.resolvePendingHide
    this.resolvePendingHide = null
    resolve?.()
  }

  /** 真正敲壳隐藏（回执与兜底共用的一条路） */
  private async hideWindowNow(): Promise<void> {
    // 只有**明确知道**已经被藏掉了才跳过；问不到（壳没连上）就照常走，隐藏本身会失败并静默
    if ((await this.primitives.isVisible()) === false) return
    await this.primitives.hideWindow().catch(() => undefined)
  }

  /** 执行命令（入口：UI / 插件 / 宿主） */
  async invoke(id: string, args: unknown, source: 'ui' | 'plugin' | 'host' = 'ui'): Promise<ActionResult> {
    const entry = this.registry.get(id)
    if (!entry) {
      return { ok: false, kind: 'host', error: { code: 'NOT_FOUND', message: `命令不存在：${id}` } }
    }
    if (!this.plugins.isActive(entry.pluginId)) {
      return { ok: false, kind: 'host', error: { code: 'NOT_FOUND', message: `插件未启用：${entry.pluginId}` } }
    }
    const ctx: ExecContext = {
      id,
      pluginId: entry.pluginId,
      command: entry.decl.name,
      mode: entry.decl.mode,
      args,
      source,
      meta: {},
    }

    try {
      const result = await this.pipeline.run(ctx, () => this.execute(ctx))
      if (result.ok && result.kind !== 'host') {
        const record = this.plugins.get(entry.pluginId)
        this.history.record({
          key: itemKey(entry.pluginId, entry.decl.name, args),
          pluginId: entry.pluginId,
          command: entry.decl.name,
          title: entry.decl.title,
          ...(entry.decl.subtitle ? { subtitle: entry.decl.subtitle } : {}),
          ...(entry.decl.icon ? { icon: entry.decl.icon } : {}),
          ...(args !== undefined ? { args } : {}),
          ...(record ? {} : {}),
        })
        this.bus.emit('history/changed', { key: itemKey(entry.pluginId, entry.decl.name, args) })
      }
      return result
    } catch (err) {
      return { ok: false, kind: 'host', error: toErrorShape(err) }
    }
  }

  private async execute(ctx: ExecContext): Promise<ActionResult> {
    const entry = this.registry.get(ctx.id)
    if (!entry) return { ok: false, kind: 'host', error: { code: 'NOT_FOUND', message: '命令已消失' } }

    if (ctx.mode === 'view') {
      return this.openSession(ctx.pluginId, ctx.command, ctx.args)
    }

    const data = await this.exec.run(ctx.pluginId, ctx.command, ctx.args, undefined)
    return { ok: true, kind: 'script', data }
  }

  /** 打开 view 会话（每次打开 = 新会话；生产用插件 listener，开发用 dev server） */
  async openSession(pluginId: string, command: string, args?: unknown): Promise<ActionResult> {
    const base = this.plugins.baseUrlFor(pluginId)
    const origin = this.plugins.sessionOriginFor(pluginId)
    if (!base || !origin) {
      return {
        ok: false,
        kind: 'view',
        error: { code: 'NOT_FOUND', message: `插件页不可用：${pluginId}` },
      }
    }
    const port = Number(new URL(origin).port || 0)
    const session = this.sessions.create({ pluginId, command, port })
    this.hostUi.state.searchContent = this.hostUi.state.searchContent
    const params = new URLSearchParams({
      sid: session.sid,
      cmd: command,
      theme: this.hostUi.state.theme,
      token: session.token,
    })
    if (args !== undefined) {
      try {
        params.set('args', JSON.stringify(args ?? null))
      } catch {
        /* args 不可序列化时忽略 */
      }
    }
    const url = `${base}/index.html?${params.toString()}`
    return {
      ok: true,
      kind: 'view',
      data: { sid: session.sid, url, pluginId, command, title: this.plugins.titleOf(pluginId) },
      // view 命令保持窗口可见：启动台切换到插件视图（requirements §3.2 二级面板）
      hideLauncher: false,
    }
  }

  /** 执行结果项的 ActionDecl（UI 点击 / Enter） */
  async runAction(
    action: ActionDecl,
    source: { pluginId: string; command: string },
  ): Promise<ActionResult> {
    const caps = this.plugins.capabilitiesOf(source.pluginId)
    switch (action.type) {
      case 'command':
        return this.invoke(`${source.pluginId}:${action.command}`, action.args, 'ui')
      case 'invoke':
        return this.invoke(`${action.pluginId}:${action.command}`, action.args, 'ui')
      case 'open': {
        if (!caps.has('shell.open')) {
          return { ok: false, kind: 'open', error: { code: 'CAPABILITY_DENIED', message: '插件未声明 shell.open' } }
        }
        try {
          if (action.targetKind === 'path' || action.targetKind === 'app') {
            await this.primitives.shellFor(source.pluginId).openPath(action.target)
          } else {
            await this.primitives.shellFor(source.pluginId).openUrl(action.target)
          }
          return { ok: true, kind: 'open', hideLauncher: true }
        } catch (err) {
          return { ok: false, kind: 'open', error: toErrorShape(err) }
        }
      }
      case 'copy': {
        if (!caps.has('clipboard.write')) {
          return { ok: false, kind: 'copy', error: { code: 'CAPABILITY_DENIED', message: '插件未声明 clipboard.write' } }
        }
        try {
          await this.primitives.clipboardFor(source.pluginId).writeText(action.text)
          return { ok: true, kind: 'copy', hideLauncher: true }
        } catch (err) {
          return { ok: false, kind: 'copy', error: toErrorShape(err) }
        }
      }
      case 'host': {
        if (action.method === 'hostUi.setSearchContent') {
          const value = typeof (action as { value?: unknown }).value === 'string' ? ((action as { value?: string }).value as string) : ''
          this.hostUi.state.searchContent = value
          this.bus.emit('ui/searchContent', { value })
          return { ok: true, kind: 'host' }
        }
        if (action.method === 'hostUi.hide') {
          await this.hideWindowAnimated()
          return { ok: true, kind: 'host', hideLauncher: true }
        }
        return { ok: false, kind: 'host', error: { code: 'NOT_FOUND', message: `未知 host 方法：${String(action.method)}` } }
      }
      default:
        return { ok: false, kind: 'host', error: { code: 'BAD_ARGS', message: '未知动作类型' } }
    }
  }

  /** 把一个结果项转换为可执行动作（列表项默认动作） */
  async executeItem(pluginId: string, item: ResultItem, args?: unknown, command?: string): Promise<ActionResult> {
    const targetCommand = command ?? (item.action.type === 'command' ? item.action.command : '')
    const action: ActionDecl = args !== undefined ? ({ ...item.action, args } as ActionDecl) : item.action
    if (targetCommand && action.type === 'command' && action.command !== undefined) {
      return this.invoke(`${pluginId}:${action.command}`, args ?? action.args, 'ui')
    }
    const result = await this.runAction(action, { pluginId, command: targetCommand })
    this.rememberItemResult(pluginId, item, action, result)
    return result
  }

  /**
   * 非命令结果项（应用 / 文件 / 网址）执行成功也写历史 —— 否则「最近使用」永远只有命令（§7.5）。
   * key 与搜索侧 `rankPluginItem` 完全一致，最近使用才能和最佳匹配对上号。
   */
  private rememberItemResult(pluginId: string, item: ResultItem, action: ActionDecl, result: ActionResult): void {
    if (!result.ok || result.kind === 'host') return
    const key = itemKey(pluginId, pluginKeyOf(item), item.action)
    this.history.record({
      key,
      pluginId,
      command: pluginKeyOf(item),
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.icon ? { icon: item.icon } : {}),
      action,
    })
    this.bus.emit('history/changed', { key })
  }

  /** 供 UI 查询：命令 + 固定/最近（空输入的本地快照） */
  snapshot(): {
    commands: Array<{ id: string; pluginId: string; pluginTitle: string; title: string; subtitle?: string; icon?: string; mode: string; placeholder?: string }>
    pinned: unknown[]
    recent: unknown[]
  } {
    const commands = this.registry
      .list()
      .filter((c) => !c.decl.hidden)
      .map((c) => ({
        id: c.id,
        pluginId: c.pluginId,
        pluginTitle: c.pluginTitle,
        title: c.decl.title,
        ...(c.decl.subtitle ? { subtitle: c.decl.subtitle } : {}),
        ...(c.decl.icon ? { icon: c.decl.icon } : {}),
        mode: c.decl.mode,
        ...(c.decl.placeholder ? { placeholder: c.decl.placeholder } : {}),
      }))
    return {
      commands,
      pinned: this.history.pinnedList(),
      recent: this.history.recent(50),
    }
  }

  /** 管理面（internal 插件）特权服务的宿主实现 */
  createSettingsService(pluginId: string): SettingsService {
    return createSettingsService(this.settingsHost(), pluginId)
  }

  private settingsHost(): SettingsHost {
    return {
      getConfig: () => this.config.get(),
      patchConfig: async (patch) => {
        const before = this.config.get()
        const config = await this.config.patch(patch)
        if (patch.historyLimit !== undefined) this.history.setHistoryLimit(config.historyLimit)
        if (patch.autostart !== undefined && config.autostart !== before.autostart) {
          await this.primitives.setAutostart(config.autostart).catch(() => undefined)
        }
        if (patch.hotkey && config.hotkey.accelerator !== before.hotkey.accelerator) {
          const hotkey = await this.applyHotkey(config)
          return { config, hotkey }
        }
        return { config }
      },
      setAutostart: async (enabled) => {
        await this.config.patch({ autostart: enabled })
        await this.primitives.setAutostart(enabled).catch(() => undefined)
      },
      setHistoryLimit: async (limit) => {
        await this.config.patch({ historyLimit: limit })
        this.history.setHistoryLimit(limit)
      },
      listPlugins: async () => this.plugins.info(),
      pluginAction: (action, payload) => this.pluginAction(action, payload),
      queryAudit: async (limit) => this.audit.query({ limit }),
      clearAudit: () => this.audit.clear(),
      clearHistory: async () => {
        this.history.clearHistory()
        this.emit('history/changed', {})
      },
      openDataDir: async () => {
        await this.primitives.shellFor('kernel').openPath(this.dataRoot)
      },
      revealPath: async (target) => {
        await this.primitives.shellFor('kernel').reveal(target)
      },
      hostInfo: () => ({
        version: this.opts.version,
        platform: process.platform,
        dataRoot: this.dataRoot,
        node: process.version,
      }),
    }
  }

  /** 插件管理动作（托盘、设置面板、HTTP API 共用同一条路径） */
  async pluginAction(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = typeof payload.id === 'string' ? payload.id : ''
    const dir = typeof payload.path === 'string' ? payload.path : ''
    switch (action) {
      case 'enable':
        await this.plugins.setDisabled(id, false)
        return { ok: true }
      case 'disable':
        await this.plugins.setDisabled(id, true)
        return { ok: true }
      case 'reload':
        await this.plugins.reload(id)
        return { ok: true }
      case 'reloadAll':
        await this.plugins.reloadAll()
        return { ok: true }
      case 'uninstall':
        await this.plugins.uninstall(id)
        return { ok: true }
      case 'installDir':
        await this.plugins.installFromDirectory(dir, { overwrite: Boolean(payload.overwrite) })
        return { ok: true }
      case 'installZip':
        await this.plugins.installFromZip(dir, { overwrite: Boolean(payload.overwrite) })
        return { ok: true }
      case 'reveal': {
        const pluginDir = this.plugins.dirOf(id)
        if (!pluginDir) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
        await this.primitives.shellFor('kernel').reveal(pluginDir)
        return { ok: true }
      }
      case 'openData': {
        await this.primitives.shellFor('kernel').openPath(this.plugins.dataPathFor(id))
        return { ok: true }
      }
      case 'setKeywords': {
        // 界面化编辑别名：覆盖层落盘 + 当场重进注册表（不用重载插件，下一次搜索即生效）
        const { command, plugin } = this.requireOverrideTarget(id, payload)
        const keywords = Array.isArray(payload.keywords)
          ? payload.keywords.filter((k): k is string => typeof k === 'string')
          : []
        if (command) await this.overrides.setCommandKeywords(plugin.id, command, keywords)
        else await this.overrides.setPluginKeywords(plugin.id, keywords)
        this.plugins.applyOverrides(plugin.id)
        return { ok: true, plugins: this.plugins.info() }
      }
      case 'resetKeywords': {
        const { command, plugin } = this.requireOverrideTarget(id, payload)
        if (command) await this.overrides.setCommandKeywords(plugin.id, command, null)
        else await this.overrides.setPluginKeywords(plugin.id, null)
        this.plugins.applyOverrides(plugin.id)
        return { ok: true, plugins: this.plugins.info() }
      }
      case 'setCapability': {
        // 用户拒绝 / 恢复某项高风险能力（安装时确认的落点）
        const capability = typeof payload.capability === 'string' ? payload.capability : ''
        const denied = Boolean(payload.denied)
        const current = this.config.get().denied
        const list = new Set(current[id] ?? [])
        if (denied) list.add(capability)
        else list.delete(capability)
        await this.config.patch({ denied: { ...current, [id]: [...list] } })
        await this.plugins.reload(id).catch(() => this.plugins.load(id))
        return { ok: true }
      }
      default:
        throw new LauncherError('BAD_ARGS', `未知插件动作：${action}`)
    }
  }

  /** setKeywords / resetKeywords 的入参校验：插件必须存在，命令（若给）必须在清单里 */
  private requireOverrideTarget(id: string, payload: Record<string, unknown>): { command: string; plugin: PluginRecord } {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
    const command = typeof payload.command === 'string' ? payload.command : ''
    if (command && !(plugin.manifest?.commands ?? []).some((decl) => decl.name === command)) {
      throw new LauncherError('NOT_FOUND', `命令不存在：${id}:${command}`)
    }
    return { command, plugin }
  }

  /** 脚本（worker）侧的宿主调用，统一过审计（P6） */
  private async handleScriptRpc(
    pluginId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const caps = this.plugins.capabilitiesOf(pluginId)
    if (method.startsWith('storage.')) {
      if (!caps.has('storage')) throw new LauncherError('CAPABILITY_DENIED', '未声明能力：storage')
      const service = this.storage.serviceFor(pluginId, 'script')
      switch (method) {
        case 'storage.get':
          return service.get(String(params.key ?? ''))
        case 'storage.set':
          return service.set(String(params.key ?? ''), params.value)
        case 'storage.remove':
          return service.remove(String(params.key ?? ''))
        case 'storage.all':
          return service.all()
        case 'storage.clear':
          return service.clear()
        default:
          break
      }
    }
    throw new LauncherError('NOT_FOUND', `未知脚本 RPC：${method}`)
  }

  emit(event: KernelEvent, payload?: unknown): void {
    this.bus.emit(event, payload)
  }

  get defaultConfig(): Config {
    return DEFAULT_CONFIG
  }

  get dataRoot(): string {
    return this.opts.dataRoot
  }

  get builtinRoots(): readonly string[] {
    return this.opts.builtinRoots
  }

  assertStarted(): void {
    if (!this.started) throw new LauncherError('INTERNAL', '内核尚未启动')
  }

  /** 就绪标志：壳问 `kernel/ready` 时用来区分「进程活着」与「UI 端口可用」 */
  markReady(): void {
    this.readyFlag = true
  }

  get isReady(): boolean {
    return this.readyFlag
  }
}
