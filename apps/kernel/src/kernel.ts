import path from 'node:path'
import { LauncherError, toErrorShape, type ActionResult, type ActionDecl, type ResultItem } from '@launcher/plugin-manifest'
import { AuditLog } from './audit'
import { ConfigStore, DEFAULT_CONFIG, type Config } from './config'
import { EventBus } from './events'
import { HistoryStore } from './history'
import { ShellLink } from './jsonrpc'
import { Pipeline } from './pipeline'
import { CommandRegistry, SearchResultHub } from './registry'
import { SearchEngine, pluginKeyOf } from './search'
import { SessionManager } from './session'
import { PluginManager } from './plugin'
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

  constructor(private readonly opts: KernelOptions) {
    this.config = new ConfigStore(opts.dataRoot)
    this.audit = new AuditLog(opts.dataRoot)
    this.history = new HistoryStore(opts.dataRoot)
    this.storage = new PluginStorage(opts.dataRoot, this.audit)
    this.quicklinks = new QuicklinkStore(opts.dataRoot, this.audit)
    this.primitives = new Primitives(this.link, this.audit)
    this.hostUi = new HostUiBridge(this.bus, this.audit, async () => {
      await this.primitives.hideWindow()
      this.bus.emit('shell/visibility', { visible: false })
    })

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
    await this.audit.init()
    await this.history.load(config.historyLimit)

    this.hostUi.state.theme = config.theme === 'light' ? 'light' : 'dark'

    await this.uiServer.start()
    await this.plugins.init()
    await this.plugins.startWatcher()

    // 会话回收：会话关闭时通知 UI 卸载 iframe
    this.sessions.on((session, kind) => {
      this.bus.emit('plugin/state', { session: session.sid, kind })
    })

    await this.registerTray()
    await this.applyHotkey(config)
    if (config.autostart) await this.primitives.setAutostart(true).catch(() => undefined)

    this.log('info', `内核就绪：UI http://127.0.0.1:${this.uiServer.address}，数据目录 ${this.opts.dataRoot}`)
  }

  async stop(): Promise<void> {
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
        await this.primitives.showWindow(true)
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
          await this.primitives.hideWindow()
          this.bus.emit('shell/visibility', { visible: false })
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
