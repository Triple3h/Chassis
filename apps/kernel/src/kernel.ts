import { LauncherError, toErrorShape, type ActionResult, type ActionDecl, type ResultItem } from '@launcher/plugin-manifest'
import { AuditLog } from './audit'
import { ConfigStore, type Config } from './config'
import { EventBus } from './events'
import { HistoryStore } from './history'
import { OverrideStore } from './overrides'
import { PluginSettingStore } from './pluginSettings'
import { ShellLink } from './jsonrpc'
import { Pipeline } from './pipeline'
import { CommandRegistry, SearchResultHub } from './registry'
import { SearchEngine, pluginKeyOf } from './search'
import { SessionManager } from './session'
import { PluginManager, type PluginRecord } from './plugin'
import { LEGACY_ID_TO_CURRENT } from './legacy'
import { PluginServerPool } from './http/pluginServers'
import { UiServer } from './http/server'
import { createServiceBinder } from './services/kernel'
import { ScriptRuntime } from './services/exec'
import { PluginStorage } from './services/storage'
import { Primitives } from './services/shell'
import { HostUiBridge } from './services/hostUi'
import { QuicklinkStore } from './services/quicklink'
import { BridgeDispatcher } from './services/bridge'
import { createSettingsService, type SettingsHost, type SettingsService } from './services/settings'
import { createSettingsHost } from './services/settingsHost'
import { PluginAdmin } from './pluginAdmin'
import { WindowVisibility } from './windowVisibility'
import type { ExecContext } from './types'
import { pluginDataPath } from './util/fsx'
import { itemKey } from './util/text'

// 显隐时序常量与状态机都在 `WindowVisibility`（`windowVisibility.ts`）；
// 这里 re-export 保持既有导入路径（tests/contract/shell-link.test.ts）继续可用
export { HIDE_FALLBACK_MS, SHOW_ANIMATION_MS } from './windowVisibility'

export interface KernelOptions {
  dataRoot: string
  /** 出厂插件根目录（可多个；开发态默认就是仓库根的 `plugins/`） */
  builtinRoots: string[]
  uiDistDir: string | null
  uiDevUrl?: string
  version: string
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
  /** 插件设置的用户值（`<dataRoot>/plugin-settings.json`） */
  readonly pluginSettings: PluginSettingStore
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
  /** 窗口显隐（广播 + 等回执 + 兜底）：状态机与常量都在 `WindowVisibility` */
  readonly visibility: WindowVisibility
  /** 插件管理动作（托盘 / 设置面板 / HTTP API 共用） */
  readonly admin: PluginAdmin
  private binder!: ReturnType<typeof createServiceBinder>
  /** 管理面（internal 插件）特权服务的宿主实现（组装见 `services/settingsHost.ts`） */
  private settingsHost!: SettingsHost
  private started = false
  private readyFlag = false
  /** 退出只允许发生一次（三条退出路径可能同时被人碰到） */
  private quitting = false

  constructor(private readonly opts: KernelOptions) {
    this.config = new ConfigStore(opts.dataRoot)
    this.audit = new AuditLog(opts.dataRoot)
    this.history = new HistoryStore(opts.dataRoot)
    this.overrides = new OverrideStore(opts.dataRoot)
    this.pluginSettings = new PluginSettingStore(opts.dataRoot)
    this.storage = new PluginStorage(opts.dataRoot, this.audit)
    this.quicklinks = new QuicklinkStore(opts.dataRoot, this.audit)
    this.primitives = new Primitives(this.link, this.audit)
    this.hostUi = new HostUiBridge(this.bus, this.audit, () => this.hideWindowAnimated())

    this.exec = new ScriptRuntime({
      resolvePluginDir: (pluginId) => this.plugins?.dirOf(pluginId),
      dataPathFor: (pluginId) => pluginDataPath(opts.dataRoot, pluginId),
      dataRoot: opts.dataRoot,
      // 延迟求值：exec 比 plugins 先构造，worker 真正启动时 plugins 早已就绪
      settingsFor: (pluginId) => this.plugins?.settingsOf(pluginId) ?? {},
      log: (level, message, data) => this.log(level, message, data),
      onFailure: (pluginId, command) => this.plugins?.noteFailure(pluginId, command),
      handleRpc: (pluginId, method, params) => this.handleScriptRpc(pluginId, method, params),
    })

    this.binder = createServiceBinder({
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
    })

    this.registry.bindInvoker((id, args, source) => this.invoke(id, args, source))

    this.plugins = new PluginManager({
      dataRoot: opts.dataRoot,
      builtinRoots: opts.builtinRoots,
      config: this.config,
      overrides: this.overrides,
      pluginSettings: this.pluginSettings,
      audit: this.audit,
      bus: this.bus,
      registry: this.registry,
      sessions: this.sessions,
      servers: this.servers,
      binder: this.binder,
      exec: this.exec,
      settingsFor: (pluginId) => this.createSettingsService(pluginId) as unknown as Record<string, unknown>,
      log: (level, message, data) => this.log(level, message, data),
      onChanged: () => void this.registerTray(),
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

    // 三块「自成一体」的职责各自成类：显隐状态机 / 插件管理 / 管理面宿主
    this.visibility = new WindowVisibility({ primitives: this.primitives, bus: this.bus })
    this.admin = new PluginAdmin({
      plugins: this.plugins,
      overrides: this.overrides,
      pluginSettings: this.pluginSettings,
      config: this.config,
      primitives: this.primitives,
    })
    this.settingsHost = createSettingsHost({
      version: opts.version,
      dataRoot: opts.dataRoot,
      config: this.config,
      history: this.history,
      audit: this.audit,
      bus: this.bus,
      primitives: this.primitives,
      plugins: this.plugins,
      patchConfig: (patch) => this.patchConfig(patch),
      pluginAction: (action, payload) => this.pluginAction(action, payload),
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.config.init()
    const config = await this.config.load()
    // 覆盖层要在插件装配（plugins.init）之前就位，否则首轮注册拿不到用户别名
    await this.overrides.load()
    // 设置值同理：搜索 worker 的预热在装配期就发生，晚加载会让首个 worker 读到空设置
    await this.pluginSettings.load()
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

    // 清单声明 `history: false` 的插件（底座自身入口：设置 / 插件管理 / 应用启动 / 文件搜索）：
    // 光"以后不写"不够 —— 界面上那条旧记录会一直留着，看起来就是"改了没生效"。
    const droppedHistory = this.history.dropHistoryBy((pluginId) => this.plugins.excludesHistory(pluginId))
    if (droppedHistory > 0) {
      this.log('info', `最近使用清理：摘掉 ${droppedHistory} 条「不计入历史」插件的条目`)
    }

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
        await this.quit()
        break
      default:
        break
    }
  }

  /**
   * 退出内核的**唯一收口**：托盘「退出」、`/api/app/quit`、壳的 `app/shutdown` 全走这里。
   *
   * 之前三条路径各写一遍「stop + quit + exit」，细节互不相同（有的回请壳、有的直接 exit、
   * 有的带 120ms 延迟），差异只能靠逐个读才发现。统一为：广播退出（UI 先知道）→ 收尾 →
   * 回请壳退出（壳发起的退出不必回请）→ 延迟 120ms 让在途响应写出去再 exit。
   */
  async quit(options: { quitShell?: boolean } = {}): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    this.bus.emit('shell/visibility', { visible: false })
    this.bus.emit('app/quit', {})
    await this.stop()
    if (options.quitShell !== false) await this.primitives.quit().catch(() => undefined)
    setTimeout(() => process.exit(0), 120)
  }

  // ── 窗口显隐（与壳的分工见 tests/contract/shell-link.test.ts）──
  //
  // 壳仍然独占「什么时候该显、什么时候该隐」的裁决权，内核只负责**让这次显隐好看一点**。
  // 状态机（广播 → 等 UI 回执 → 兜底落地）整体在 `WindowVisibility` 里，
  // 下面这几个方法是薄转发 —— 保留它们是为了让所有调用点读起来仍是「kernel.xxxAnimated()」。

  /** 显示窗口：先落地，再等窗口真的能画了才广播（见 `SHOW_ANIMATION_MS`） */
  async showWindowAnimated(focus = true): Promise<void> {
    await this.visibility.show(focus)
  }

  /** 「显示」这条广播要晚一点发：等窗口上屏、webview 恢复绘制之后再让 UI 起入场动画 */
  emitVisibleAnimated(): Promise<void> {
    return this.visibility.emitVisible()
  }

  /** 隐藏窗口：先广播（UI 演离场），等回执才真正落地（兜底 `HIDE_FALLBACK_MS`） */
  hideWindowAnimated(): Promise<void> {
    return this.visibility.hide()
  }

  /** UI 回执：离场动画的最后一帧已经画出来了 —— 现在可以落地了 */
  finishWindowHide(): void {
    this.visibility.finishHide()
  }

  /** 撤销尚在排队的隐藏（热键连按不能被上一次隐藏偷走窗口） */
  cancelPendingHide(): void {
    this.visibility.cancelPendingHide()
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
      // `history: false` 的插件（底座自身入口）不进「最近使用」—— 它们一用就占满整个分区
      if (result.ok && result.kind !== 'host' && !this.plugins.excludesHistory(entry.pluginId)) {
        this.history.record({
          key: itemKey(entry.pluginId, entry.decl.name, args),
          pluginId: entry.pluginId,
          command: entry.decl.name,
          title: entry.decl.title,
          ...(entry.decl.subtitle ? { subtitle: entry.decl.subtitle } : {}),
          ...(entry.decl.icon ? { icon: entry.decl.icon } : {}),
          ...(args !== undefined ? { args } : {}),
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
    if (this.plugins.excludesHistory(pluginId)) return
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

  /**
   * 配置写入的**唯一收口**：落盘 → 副作用（历史上限 / 自启 / 热键）→ 广播 `config/changed`。
   *
   * 谁写配置都得走这里。主题 / 主题色 / 密度只有启动台 UI 知道怎么落到 CSS 变量上
   * （`data-theme` / `--color-accent` / `data-density`），漏一次广播 = 用户看到「改了没反应」，
   * 而配置文件其实早写进去了。
   *
   * 这条广播补过两次：第一次只补了 `POST /api/config`，用户从**设置页**改依旧没反应 ——
   * 设置页走的是 `ctx.settings.patch`（管理面特权），当时那条路直接改 `config.patch`，绕过了广播。
   * 所以别再在调用点上补，收在这里。
   */
  async patchConfig(
    patch: Partial<Config>,
  ): Promise<{ config: Config; hotkey?: { ok: boolean; reason?: string; accelerator?: string } }> {
    const before = this.config.get()
    const config = await this.config.patch(patch)
    if (config.historyLimit !== before.historyLimit) this.history.setHistoryLimit(config.historyLimit)
    this.bus.emit('config/changed', { config })
    if (patch.autostart !== undefined && config.autostart !== before.autostart) {
      await this.primitives.setAutostart(config.autostart).catch(() => undefined)
    }
    if (patch.hotkey && config.hotkey.accelerator !== before.hotkey.accelerator) {
      const hotkey = await this.applyHotkey(config)
      return { config, hotkey }
    }
    return { config }
  }

  /** 管理面（internal 插件）特权服务：宿主实现见 `services/settingsHost.ts` */
  createSettingsService(pluginId: string): SettingsService {
    return createSettingsService(this.settingsHost, pluginId)
  }

  /** 插件管理动作（托盘、设置面板、HTTP API 共用同一条路径；实现在 `PluginAdmin`） */
  async pluginAction(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.admin.run(action, payload)
  }

  /** 脚本（worker）侧的宿主调用，统一过审计（P6） */
  private async handleScriptRpc(
    pluginId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method.startsWith('storage.')) {
      if (!this.plugins.capabilitiesOf(pluginId).has('storage')) {
        throw new LauncherError('CAPABILITY_DENIED', '未声明能力：storage')
      }
      // 转发与 view 桥共用同一实现（PluginStorage.call），这里只做能力校验
      return this.storage.call(pluginId, 'script', method.slice('storage.'.length), params)
    }
    throw new LauncherError('NOT_FOUND', `未知脚本 RPC：${method}`)
  }

  get dataRoot(): string {
    return this.opts.dataRoot
  }

  /** 内核版本：HTTP 接口 / 握手一律从这里取，别再写字面量 */
  get version(): string {
    return this.opts.version
  }

  /** 就绪标志：壳问 `kernel/ready` 时用来区分「进程活着」与「UI 端口可用」 */
  markReady(): void {
    this.readyFlag = true
  }

  get isReady(): boolean {
    return this.readyFlag
  }
}
