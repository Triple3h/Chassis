import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  COMMAND_NAME_RE,
  LauncherError,
  PLUGIN_ID_RE,
  globalCommandId,
  scriptEntryCandidates,
  validateManifest,
  type CommandDecl,
  type ManifestErrorCode,
  type PluginManifest,
  type PluginRuntimeInfo,
} from '@launcher/plugin-manifest'
import type { AuditLog } from './audit'
import type { ConfigStore } from './config'
import { createPluginContext, disposeContext, type ServiceBinder } from './context'
import type { EventBus } from './events'
import type { CommandRegistry } from './registry'
import type { SessionManager } from './session'
import type { KernelServices, PluginContext } from './services/types'
import type { ScriptRuntime } from './services/exec'
import type { Disposer, SessionCloseReason } from './types'
import { ensureDir, listDirSafe, pathExists } from './util/fsx'
import type { PluginServerPool } from './http/pluginServers'
import { LEGACY_PLUGIN_IDS } from './legacy'
import {
  commandKeywordsOf,
  mergeCommandDecls,
  mergeKeywords,
  pluginKeywordsOf,
  type OverrideStore,
} from './overrides'

export type PluginState =
  | 'discovered'
  | 'validating'
  | 'loading'
  | 'active'
  | 'disabled'
  | 'error'
  | 'crashed'
  | 'degraded'

export interface PluginRecord {
  id: string
  dir: string
  builtin: boolean
  manifest: PluginManifest | null
  state: PluginState
  error?: string
  /** 实际授予的能力 = 声明 − 用户拒绝 */
  capabilities: Set<string>
  denied: Set<string>
  devUrl?: string
  commandErrors: Map<string, string>
  failureCount: number
  listenerPort?: number
}

export interface PluginManagerDeps {
  dataRoot: string
  /** 出厂插件根目录（可多个；开发态默认就是仓库根的 `plugins/`；靠后的同名插件覆盖靠前的） */
  builtinRoots: string[]
  config: ConfigStore
  /** 用户覆盖层（别名等）：装配命令时与清单合并 */
  overrides: OverrideStore
  audit: AuditLog
  bus: EventBus
  registry: CommandRegistry
  sessions: SessionManager
  servers: PluginServerPool
  binder: ServiceBinder
  services: KernelServices
  exec: ScriptRuntime
  /** 管理面特权服务工厂（仅 id 以 internal- 开头的插件会被注入） */
  settingsFor?: (pluginId: string) => Record<string, unknown>
  log: (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown) => void
  onChanged: () => void
}

interface LoadedPlugin {
  ctx: PluginContext
  disposers: Array<{ fn: Disposer; label: string }>
}

/**
 * 插件生命周期（requirements §7.4）：
 * discovered → validating → loading → active → (disabled | error | crashed | degraded)
 */
export class PluginManager {
  private records = new Map<string, PluginRecord>()
  private loaded = new Map<string, LoadedPlugin>()
  private watcher: { close: () => Promise<void> } | null = null

  constructor(private readonly deps: PluginManagerDeps) {}

  // ── 查询 ────────────────────────────────────────────────────
  list(): PluginRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id)
  }

  dirOf(id: string): string | undefined {
    return this.records.get(id)?.dir
  }

  titleOf(id: string): string {
    return this.records.get(id)?.manifest?.title ?? id
  }

  dataPathFor(id: string): string {
    return path.join(this.deps.dataRoot, 'plugins', id)
  }

  /**
   * 插件改过 id 时，把旧数据目录整体搬到新 id 下（只复制不删除；新目录已存在则不动）。
   * 映射见 LEGACY_PLUGIN_IDS；失败只记日志，不阻塞加载。
   */
  private async adoptLegacyDataDir(id: string): Promise<void> {
    const legacyId = LEGACY_PLUGIN_IDS[id]
    if (!legacyId) return
    const next = this.dataPathFor(id)
    const prev = this.dataPathFor(legacyId)
    if (await pathExists(next)) return
    if (!(await pathExists(prev))) return
    try {
      await fsp.cp(prev, next, { recursive: true })
      this.deps.log('info', `已迁移旧插件数据目录：${legacyId} → ${id}`)
    } catch (err) {
      this.deps.log(
        'warn',
        `旧插件数据目录迁移失败：${legacyId} → ${id}（${err instanceof Error ? err.message : String(err)}）`,
      )
    }
  }

  capabilitiesOf(id: string): ReadonlySet<string> {
    return this.records.get(id)?.capabilities ?? new Set<string>()
  }

  isActive(id: string): boolean {
    const state = this.records.get(id)?.state
    return state === 'active' || state === 'degraded'
  }

  /**
   * 底座基础能力：出厂 bundle 里声明了 `essential` 的插件 —— **不可禁用**。
   *
   * 只认出厂声明（`builtin`）：第三方插件即使在清单里写 `essential: true` 也不生效，
   * 否则它就能把自己变成「用户关不掉」的插件（权限提升）。
   */
  isEssential(id: string): boolean {
    const record = this.records.get(id)
    return Boolean(record?.builtin && record.manifest?.essential)
  }

  /**
   * 该插件的条目是否不进「最近使用」（清单 `history: false`）。
   *
   * 与 `isEssential` 不同，这里**不限制**只有出厂插件能声明：把自己的条目从最近使用里摘掉，
   * 影响面只有它自己（既不提权、也不影响别人），第三方插件有同样需求时无需改底座。
   */
  excludesHistory(id: string): boolean {
    return this.records.get(id)?.manifest?.history === false
  }

  isCommandAlive(pluginId: string, command: string): boolean {
    if (!this.isActive(pluginId)) return false
    const record = this.records.get(pluginId)
    if (!record?.manifest) return false
    return record.manifest.commands.some((c) => c.name === command)
  }

  /**
   * 历史/固定项里的「这条结果还能用吗」（requirements §7.5 的置灰判定）。
   * `command` 可能不是命令名而是结果项 id（`pluginKeyOf`：`app:/…`、`web:…`），
   * 那种情况无从校验，只要插件仍可用就不置灰。
   */
  isResultAlive(pluginId: string, command: string): boolean {
    if (!this.isActive(pluginId)) return false
    if (!COMMAND_NAME_RE.test(command)) return true
    return this.isCommandAlive(pluginId, command)
  }

  /** 插件静态资源基址（相对路径图标 → 绝对 URL） */
  baseUrlFor(pluginId: string): string | null {
    const record = this.records.get(pluginId)
    if (!record) return null
    if (record.devUrl) return record.devUrl.replace(/\/$/, '')
    if (record.listenerPort) return `http://127.0.0.1:${record.listenerPort}`
    return null
  }

  /** 会话的期望 origin（UI 侧用它校验 postMessage 来源） */
  sessionOriginFor(pluginId: string): string | null {
    const record = this.records.get(pluginId)
    if (!record) return null
    if (record.devUrl) {
      try {
        return new URL(record.devUrl).origin
      } catch {
        return null
      }
    }
    if (record.listenerPort) return `http://127.0.0.1:${record.listenerPort}`
    return null
  }

  info(): PluginRuntimeInfo[] {
    return this.list().map((record) => {
      const override = this.deps.overrides.getFor(record.id)
      const pluginKeywords = pluginKeywordsOf(record.manifest?.keywords, override)
      return {
        id: record.id,
        title: record.manifest?.title ?? record.id,
        version: record.manifest?.version ?? '0.0.0',
        ...(record.manifest?.description ? { description: record.manifest.description } : {}),
        ...(record.manifest?.author ? { author: record.manifest.author } : {}),
        ...(record.manifest?.icon ? { icon: record.manifest.icon } : {}),
        apiVersion: record.manifest?.apiVersion ?? '1',
        capabilities: [...record.capabilities],
        deniedCapabilities: [...record.denied],
        // 插件级别名（兜底给全部入口命令）；customized = 被用户覆盖层改过（界面显示「恢复默认」）
        keywords: pluginKeywords,
        keywordsCustomized: override?.keywords !== undefined,
        commands: (record.manifest?.commands ?? []).map((decl) => ({
          name: decl.name,
          title: decl.title,
          mode: decl.mode,
          searchable: Boolean(decl.searchable),
          contributes: Boolean(decl.contributes),
          hidden: Boolean(decl.hidden),
          ...(decl.placeholder ? { placeholder: decl.placeholder } : {}),
          // 命令**自己**的别名（不含插件级；实际参与搜索的 = 插件级 ∪ 命令级）
          keywords: commandKeywordsOf(decl.keywords, override, decl.name),
          keywordsCustomized: override?.commands?.[decl.name]?.keywords !== undefined,
          ...(record.commandErrors.has(decl.name) ? { error: record.commandErrors.get(decl.name) } : {}),
        })),
        state: record.state,
        ...(record.error ? { error: record.error } : {}),
        builtin: record.builtin,
        essential: this.isEssential(record.id),
        dir: record.dir,
        ...(record.devUrl ? { devUrl: record.devUrl } : {}),
      }
    })
  }

  /**
   * 覆盖层改动后重新落进命令注册表（不用重载插件、更不用重启）。
   * 只是登记表里的 `keywords` 变了 —— 下一次搜索立刻用新值。
   */
  applyOverrides(pluginId: string): void {
    const record = this.records.get(pluginId)
    if (!record?.manifest) return
    const override = this.deps.overrides.getFor(pluginId)
    const pluginKeywords = pluginKeywordsOf(record.manifest.keywords, override)
    for (const decl of record.manifest.commands) {
      this.deps.registry.update(globalCommandId(pluginId, decl.name), {
        keywords: mergeKeywords(pluginKeywords, commandKeywordsOf(decl.keywords, override, decl.name)),
      })
    }
  }

  // ── 装配 ────────────────────────────────────────────────────
  async init(): Promise<void> {
    await this.scan()
    await this.pruneEssentialDisabled()
    for (const record of this.list()) {
      if (this.deps.config.get().disabled.includes(record.id)) {
        record.state = 'disabled'
        continue
      }
      await this.load(record.id).catch((err) => {
        this.deps.log('error', `插件加载失败：${record.id}`, err)
      })
    }
    const active = this.list().filter((r) => this.isActive(r.id)).length
    this.deps.log('info', `插件装配完成：${active}/${this.records.size} 激活`)
  }

  /**
   * 基础能力不可禁用：配置里若残留它们的禁用项（手改配置 / 旧版本留下的），一律忽略并清掉 ——
   * 否则「设置与插件管理」被禁用后就再没有界面能把它改回来（自救入口没了）。
   */
  private async pruneEssentialDisabled(): Promise<void> {
    const disabled = this.deps.config.get().disabled
    if (disabled.length === 0) return
    const kept: string[] = []
    const dropped: string[] = []
    for (const id of disabled) {
      const record = this.records.get(id)
      if (!record?.builtin) {
        kept.push(id)
        continue
      }
      // 装配还没开始，manifest 只能现读一次（插件数量少，代价可忽略）
      const result = await readManifest(record.dir)
      if (result.ok && result.manifest.essential) dropped.push(id)
      else kept.push(id)
    }
    if (dropped.length === 0) return
    await this.deps.config.patch({ disabled: kept })
    this.deps.log('info', `基础能力不可禁用：已忽略配置中的禁用项（${dropped.join(', ')}）`)
  }

  /** 监听 extensions/（chokidar）：新增/更新/删除自动热重载 */
  async startWatcher(): Promise<void> {
    const dir = path.join(this.deps.dataRoot, 'extensions')
    await ensureDir(dir)
    try {
      const chokidar = await import('chokidar')
      const watcher = chokidar.watch(dir, {
        depth: 3,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignored: (p: string) => path.basename(p).startsWith('.'),
      })
      watcher.on('add', (file) => this.onFsChange(file))
      watcher.on('change', (file) => this.onFsChange(file))
      watcher.on('unlink', (file) => this.onFsChange(file))
      watcher.on('unlinkDir', (target) => this.onFsChange(target))
      watcher.on('addDir', (target) => this.onFsChange(target))
      this.watcher = { close: async () => watcher.close() }
    } catch (err) {
      this.deps.log('warn', 'extensions/ 目录监听未启用（chokidar 不可用）', err)
    }
  }

  private fsTimer: NodeJS.Timeout | null = null
  private fsPending = new Set<string>()

  private onFsChange(file: string): void {
    const rel = path.relative(path.join(this.deps.dataRoot, 'extensions'), file)
    const pluginId = rel.split(path.sep)[0]
    if (!pluginId || pluginId.startsWith('.')) return
    this.fsPending.add(pluginId)
    if (this.fsTimer) return
    this.fsTimer = setTimeout(() => {
      this.fsTimer = null
      const ids = [...this.fsPending]
      this.fsPending.clear()
      void this.reconcile(ids)
    }, 400)
    this.fsTimer.unref?.()
  }

  private async reconcile(ids: string[]): Promise<void> {
    await this.scan()
    for (const id of ids) {
      const record = this.records.get(id)
      if (!record) {
        const loaded = this.loaded.get(id)
        if (loaded) await this.disable(id)
        continue
      }
      if (this.deps.config.get().disabled.includes(id)) continue
      try {
        await this.reload(id)
      } catch (err) {
        this.deps.log('error', `目录变化重载失败：${id}`, err)
      }
    }
  }

  /**
   * 扫描出厂 bundle 与用户 extensions 目录。
   * 目录识别规则（统一 installFromDirectory 与 scan）：
   *   若 `<dir>/dist/package.json` 存在，则 `<dir>/dist` 才是插件根（源码工程 / 构建产物分离）；
   *   否则 `<dir>` 本身是插件根（zip 安装后的形态，也是 plugin-spec §2.2 的 dist 内容）。
   * 插件 id 以清单里的 `name` 为准（目录名只作兜底）。
   */
  async scan(): Promise<void> {
    const found = new Map<string, { dir: string; builtin: boolean }>()
    const roots: Array<[string, boolean]> = [
      // 出厂 bundle 可以由多个来源目录组成（内置 + 预置），用户 extensions 永远最后扫、优先级最高
      ...this.deps.builtinRoots.map((root): [string, boolean] => [root, true]),
      [path.join(this.deps.dataRoot, 'extensions'), false],
    ]
    for (const [root, builtin] of roots) {
      for (const name of await listDirSafe(root)) {
        if (name.startsWith('.')) continue
        const dir = path.join(root, name)
        const candidate = (await pathExists(path.join(dir, 'dist', 'package.json'))) ? path.join(dir, 'dist') : dir
        const pkgPath = path.join(candidate, 'package.json')
        if (!(await pathExists(pkgPath))) continue
        let id = name
        try {
          const raw = JSON.parse(await fsp.readFile(pkgPath, 'utf8')) as { name?: unknown }
          if (typeof raw.name === 'string' && PLUGIN_ID_RE.test(raw.name)) id = raw.name
        } catch {
          /* 清单坏了也先登记，加载时报 MANIFEST_INVALID */
        }
        // 用户级优先（同 id 覆盖出厂 bundle）
        if (builtin || !found.has(id)) found.set(id, { dir: candidate, builtin })
      }
    }

    for (const [id, entry] of found) {
      const existing = this.records.get(id)
      if (existing) {
        existing.dir = entry.dir
        existing.builtin = entry.builtin
        continue
      }
      this.records.set(id, {
        id,
        dir: entry.dir,
        builtin: entry.builtin,
        manifest: null,
        state: 'discovered',
        capabilities: new Set(),
        denied: new Set(),
        commandErrors: new Map(),
        failureCount: 0,
      })
    }

    for (const [id] of [...this.records]) {
      if (found.has(id)) continue
      await this.disable(id).catch(() => undefined)
      this.records.delete(id)
    }
  }

  // ── 加载 / 停用 ─────────────────────────────────────────────
  async load(id: string): Promise<PluginRecord> {
    const record = this.records.get(id)
    if (!record) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
    if (this.isActive(id)) return record

    record.state = 'validating'
    record.error = undefined
    record.commandErrors.clear()

    const manifestResult = await readManifest(record.dir)
    if (!manifestResult.ok) {
      record.state = 'error'
      record.error = manifestResult.message
      this.emitChanged()
      throw new LauncherError(manifestResult.code, manifestResult.message)
    }
    const manifest = manifestResult.manifest
    record.manifest = manifest

    const declared = resolveCapabilities(manifest)
    const denied = new Set((this.deps.config.get().denied[id] ?? []).filter((c) => declared.has(c)))
    record.capabilities = new Set([...declared].filter((c) => !denied.has(c)))
    record.denied = denied
    for (const cap of denied) {
      this.deps.audit.record({
        pluginId: id,
        channel: 'kernel',
        method: 'capability.denied',
        ok: false,
        ms: 0,
        capability: cap,
        error: { code: 'CAPABILITY_DENIED', message: `用户拒绝了能力：${cap}` },
      })
    }

    await this.validateEntries(record, manifest)

    // 插件改过 id：旧数据目录整体搬到新 id 下（只复制不删除，见 LEGACY_PLUGIN_IDS）
    await this.adoptLegacyDataDir(id).catch(() => undefined)

    record.state = 'loading'
    const devUrl = this.deps.config.get().devPlugins[id]
    if (devUrl) {
      record.devUrl = devUrl
      record.listenerPort = undefined
    } else {
      record.devUrl = undefined
      try {
        const listener = await this.deps.servers.start(id, record.dir)
        record.listenerPort = listener.port
      } catch (err) {
        record.state = 'error'
        record.error = `插件页服务启动失败：${err instanceof Error ? err.message : String(err)}`
        this.emitChanged()
        return record
      }
    }

    const disposers: Array<{ fn: Disposer; label: string }> = []
    const extra =
      id.startsWith('internal-') && this.deps.settingsFor ? { settings: this.deps.settingsFor(id) } : undefined
    const ctx = createPluginContext({
      pluginId: id,
      capabilities: record.capabilities,
      services: this.deps.services,
      binder: this.deps.binder,
      bus: this.deps.bus,
      ...(extra ? { extra } : {}),
      disposeSink: {
        register: (_pluginId, fn, label) => disposers.push({ fn, label }),
      },
      // 装配期裁剪是**正常**行为（P5）：记为 ok:true 的事实，而不是失败。
      // 真正的越权调用由 BridgeDispatcher / ScriptRuntime 记为 ok:false。
      onDenied: (pluginId, service, capability) => {
        this.deps.audit.record({
          pluginId,
          channel: 'kernel',
          method: 'context.mount',
          ok: true,
          ms: 0,
          capability,
          args: { service, mounted: false },
        })
      },
    })

    // 注册的是「清单 + 用户覆盖层」的合并结果：keywords = 插件级 ∪ 命令级
    for (const decl of mergeCommandDecls(manifest, this.deps.overrides.getFor(id))) {
      if (record.commandErrors.has(decl.name)) continue
      const dispose = this.deps.registry.register({
        id: globalCommandId(id, decl.name),
        pluginId: id,
        pluginTitle: manifest.title,
        decl,
        capabilities: [...new Set([...manifest.capabilities, ...(decl.capabilities ?? [])])],
      })
      disposers.push({ fn: dispose, label: `command(${decl.name})` })
    }

    this.loaded.set(id, { ctx, disposers })
    record.state = 'active'
    this.deps.log('info', `插件已激活：${id}（${manifest.commands.length} 条命令）`)
    this.emitChanged()
    this.prewarmSearchSources(id, record, manifest)
    return record
  }

  /** 贡献型搜索源：激活后延迟预热，避免第一次输入吃冷启动超时 */
  private prewarmSearchSources(id: string, record: PluginRecord, manifest: PluginManifest): void {
    for (const decl of manifest.commands) {
      if (!decl.contributes || decl.mode === 'view' || record.commandErrors.has(decl.name)) continue
      const timer = setTimeout(() => {
        void this.deps.exec.prewarm(id, decl.name)
      }, 800)
      timer.unref?.()
    }
  }

  async disable(id: string, reason: SessionCloseReason = 'disable'): Promise<void> {
    const loaded = this.loaded.get(id)
    if (loaded) {
      this.loaded.delete(id)
      disposeContext(loaded.ctx)
      for (const { fn, label } of [...loaded.disposers].reverse()) {
        try {
          fn()
        } catch (err) {
          this.deps.log('warn', `disposer 失败（${id}/${label}）`, err)
        }
      }
    }
    this.deps.exec.releasePlugin(id)
    this.deps.sessions.closePlugin(id, reason)
    await this.deps.servers.stop(id)
    const record = this.records.get(id)
    if (record) {
      record.state = 'disabled'
      record.listenerPort = undefined
      record.devUrl = undefined
    }
    this.emitChanged()
  }

  async enable(id: string): Promise<PluginRecord> {
    const cfg = this.deps.config.get()
    if (cfg.disabled.includes(id)) {
      await this.deps.config.patch({ disabled: cfg.disabled.filter((x) => x !== id) })
    }
    return this.load(id)
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    if (disabled && this.isEssential(id)) {
      throw new LauncherError('FORBIDDEN', `「${this.titleOf(id)}」是底座基础能力，不可禁用`)
    }
    const cfg = this.deps.config.get()
    const next = disabled ? [...new Set([...cfg.disabled, id])] : cfg.disabled.filter((x) => x !== id)
    await this.deps.config.patch({ disabled: next })
    if (disabled) await this.disable(id)
    else await this.load(id)
  }

  /**
   * 热重载（requirements §7.4）：停用 → 重新读盘 → 加载。
   *
   * 原来开着的插件页会话会随停用一起关闭（listener 端口已消失，页面必然失效）；
   * 重载结束广播 `plugin/reloaded`，由启动台 UI 用同一命令重开页面（新会话 / 新端口）——
   * 否则在插件自己的页面里点「重载」（插件管理页重载自己 / 全部重载）会把当前页面打死。
   */
  async reload(id: string): Promise<PluginRecord> {
    const record = this.records.get(id)
    if (!record) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
    const wasDisabled = record.state === 'disabled' || this.deps.config.get().disabled.includes(id)
    // 停用前记下开着的 view 命令，重载成功后交给 UI 重开
    const views = this.deps.sessions.byPlugin(id).map((session) => session.command)
    await this.disable(id, 'reload')
    if (wasDisabled) {
      record.state = 'disabled'
      return record
    }
    try {
      const loaded = await this.load(id)
      this.deps.bus.emit('plugin/reloaded', { pluginId: id, commands: views, ok: this.isActive(id) })
      return loaded
    } catch (err) {
      // 加载失败也要通知：UI 不能把死掉的旧页面留在窗口里
      this.deps.bus.emit('plugin/reloaded', { pluginId: id, commands: views, ok: false })
      throw err
    }
  }

  async reloadAll(): Promise<void> {
    for (const record of this.list()) {
      if (record.state === 'disabled') continue
      await this.reload(record.id).catch((err) => this.deps.log('error', `重载失败：${record.id}`, err))
    }
  }

  /** view 页崩溃：标记 crashed，不影响其它插件 */
  markCrashed(id: string, reason: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.state = 'crashed'
    record.error = reason
    this.deps.log('error', `插件页崩溃：${id} ${reason}`)
    this.emitChanged()
  }

  /** 脚本失败计数：连续 3 次 → degraded */
  noteFailure(id: string, command: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.failureCount += 1
    if (record.failureCount >= 3 && record.state === 'active') {
      record.state = 'degraded'
      record.error = `命令 ${command} 连续失败 ${record.failureCount} 次`
      this.deps.log('warn', `插件降级：${id}（${record.error}）`)
      this.emitChanged()
    }
  }

  // ── 安装 / 卸载 ─────────────────────────────────────────────
  async installFromDirectory(sourceInput: string, opts: { overwrite?: boolean } = {}): Promise<PluginRecord> {
    // 便利：源码工程（含 dist/）直接拖进来时，装的是 dist/ 的内容（plugin-spec §2.2）
    const sourceDir = (await pathExists(path.join(sourceInput, 'dist', 'package.json')))
      ? path.join(sourceInput, 'dist')
      : sourceInput
    const manifestResult = await readManifest(sourceDir)
    if (!manifestResult.ok) throw new LauncherError(manifestResult.code, manifestResult.message)
    const id = manifestResult.manifest.name

    await ensureDir(path.join(this.deps.dataRoot, 'extensions'))
    const target = path.join(this.deps.dataRoot, 'extensions', id)
    const existing = this.records.get(id)
    if (existing && !opts.overwrite) {
      throw new LauncherError('PLUGIN_ID_CONFLICT', `插件已存在：${id}`)
    }
    if (existing) await this.disable(id)

    await fsp.rm(target, { recursive: true, force: true })
    await fsp.cp(sourceDir, target, { recursive: true, dereference: true })

    await this.scan()
    const record = this.records.get(id)
    if (!record) throw new LauncherError('MANIFEST_INVALID', '安装后未找到插件目录')
    record.dir = target
    record.builtin = false
    if (!this.deps.config.get().disabled.includes(id)) await this.load(id)
    return record
  }

  /**
   * 从 zip 安装（requirements §3.5 / §9「供应链」）：
   * 只解压到目标目录，拒绝绝对路径、`..`，单文件 ≤ 50MB。
   */
  async installFromZip(zipPath: string, opts: { overwrite?: boolean } = {}): Promise<PluginRecord> {
    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    if (entries.length === 0) throw new LauncherError('BAD_ARGS', 'zip 是空的')

    const MAX_FILE = 50 * 1024 * 1024
    let total = 0
    for (const entry of entries) {
      const name = entry.entryName
      if (name.includes('\0') || name.includes('..') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
        throw new LauncherError('BAD_ARGS', `zip 内含非法路径：${name}`)
      }
      total += entry.header.size
      if (entry.header.size > MAX_FILE) throw new LauncherError('BAD_ARGS', `zip 内单文件超过 50MB：${name}`)
    }
    if (total > 200 * 1024 * 1024) throw new LauncherError('BAD_ARGS', 'zip 解压后超过 200MB')

    // 允许一层包裹目录
    const hasRootPkg = entries.some((e) => e.entryName === 'package.json')
    const prefixes = new Set(entries.map((e) => e.entryName.split('/')[0]))
    const wrapped = !hasRootPkg && prefixes.size === 1 ? [...prefixes][0] : null

    const staging = path.join(this.deps.dataRoot, '.staging', `install-${Date.now()}`)
    await ensureDir(staging)
    try {
      for (const entry of entries) {
        if (entry.isDirectory) continue
        let rel = entry.entryName
        if (wrapped) {
          if (!rel.startsWith(`${wrapped}/`)) continue
          rel = rel.slice(wrapped.length + 1)
        }
        if (!rel) continue
        const dest = path.join(staging, rel)
        const guard = path.relative(staging, dest)
        if (guard.startsWith('..') || path.isAbsolute(guard)) {
          throw new LauncherError('BAD_ARGS', `zip 条目越界：${entry.entryName}`)
        }
        await ensureDir(path.dirname(dest))
        await fsp.writeFile(dest, entry.getData())
      }
      return await this.installFromDirectory(staging, opts)
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async uninstall(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new LauncherError('NOT_FOUND', `插件不存在：${id}`)
    if (record.builtin) throw new LauncherError('FORBIDDEN', '出厂插件不可卸载（可禁用）')
    await this.disable(id, 'uninstall')
    await fsp.rm(record.dir, { recursive: true, force: true })
    // 覆盖层跟着插件走：重装后不该还带着上一份别名
    await this.deps.overrides.clear(id)
    this.records.delete(id)
    this.emitChanged()
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined)
      this.watcher = null
    }
    for (const record of this.list()) {
      await this.disable(record.id, 'shutdown').catch(() => undefined)
    }
  }

  private async validateEntries(record: PluginRecord, manifest: PluginManifest): Promise<void> {
    const hasView = manifest.commands.some((c) => c.mode === 'view')
    if (hasView && !(await pathExists(path.join(record.dir, 'index.html')))) {
      for (const decl of manifest.commands) {
        if (decl.mode === 'view') record.commandErrors.set(decl.name, '缺少 index.html')
      }
    }
    for (const decl of manifest.commands) {
      if (decl.mode === 'view') continue
      const found = await Promise.all(
        scriptEntryCandidates(decl.name).map((c) => pathExists(path.join(record.dir, c))),
      )
      if (!found.some(Boolean)) record.commandErrors.set(decl.name, `缺少 ${decl.name}.mjs`)
    }
    for (const [name, message] of record.commandErrors) {
      this.deps.log('warn', `插件 ${record.id} 命令 ${name} 不可用：${message}`)
      this.deps.audit.record({
        pluginId: record.id,
        channel: 'kernel',
        method: 'plugin.validateEntry',
        ok: false,
        ms: 0,
        capability: '',
        error: { code: 'ENTRY_MISSING', message },
      })
    }
  }

  private emitChanged(): void {
    this.deps.bus.emit('plugin/state', { plugins: this.info() })
    this.deps.onChanged()
  }
}

export function resolveCapabilities(manifest: PluginManifest): Set<string> {
  const set = new Set<string>(manifest.capabilities)
  for (const decl of manifest.commands) {
    for (const cap of decl.capabilities ?? []) set.add(cap)
  }
  return set
}

export async function readManifest(
  dir: string,
): Promise<{ ok: true; manifest: PluginManifest } | { ok: false; code: ManifestErrorCode; message: string }> {
  let raw: unknown
  try {
    raw = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
  } catch (err) {
    return {
      ok: false,
      code: 'MANIFEST_INVALID',
      message: `package.json 无法解析：${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const result = validateManifest(raw)
  if (!result.ok) return { ok: false, code: result.code, message: result.message }
  return { ok: true, manifest: result.manifest }
}

export type { CommandDecl }
