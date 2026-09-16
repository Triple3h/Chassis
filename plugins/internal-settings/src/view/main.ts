/**
 * 设置 + 插件管理（管理面 view 插件）。
 * 用原生 DOM 渲染（体积小、无需框架），所有数据来自 `ctx.settings`（仅 internal 插件可用）。
 */
import { host, settings } from '@launcher/api'

interface ConfigLike {
  hotkey: { accelerator: string }
  autostart: boolean
  hideOnBlur: boolean
  keepQuery: boolean
  language: string
  theme: 'system' | 'light' | 'dark'
  accent: string
  density: 'comfortable' | 'compact'
  historyLimit: number
  historyInSearch: boolean
}

interface CommandLike {
  name: string
  title: string
  mode: string
  searchable: boolean
  contributes: boolean
  hidden: boolean
  /** 命令**自己**的别名（实际参与搜索 = 插件级 ∪ 命令级） */
  keywords: string[]
  /** 被用户覆盖层改过（显示「恢复默认」） */
  keywordsCustomized: boolean
  error?: string
}

interface PluginLike {
  id: string
  title: string
  version: string
  description?: string
  author?: string
  state: string
  error?: string
  builtin: boolean
  /** 底座基础能力：不可禁用（列表里带「基础」标记、不渲染开关） */
  essential: boolean
  dir: string
  capabilities: string[]
  deniedCapabilities: string[]
  apiVersion: string
  /** 插件级别名：兜底给全部入口命令 */
  keywords: string[]
  keywordsCustomized: boolean
  commands: CommandLike[]
}

interface AuditLike {
  ts: number
  pluginId: string
  method: string
  ok: boolean
  ms: number
  capability: string
  error?: { code: string; message: string }
}

type TabId = 'general' | 'appearance' | 'plugins' | 'data' | 'about'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'appearance', label: '外观' },
  { id: 'plugins', label: '插件' },
  { id: 'data', label: '数据' },
  { id: 'about', label: '关于' },
]

const tabsEl = document.getElementById('tabs') as HTMLElement
const panelEl = document.getElementById('panel') as HTMLElement

let config: ConfigLike | null = null
let plugins: PluginLike[] = []
let audit: AuditLike[] = []
let activeTab: TabId = 'general'

// ── 插件页（主从两栏）状态 ──────────────────────────────────────
type PluginFilter = 'all' | 'active' | 'disabled' | 'error'

const MAX_KEYWORDS = 10

let pluginQuery = ''
let pluginFilter: PluginFilter = 'all'
let selectedPluginId: string | null = null
let installOpen = false
/** 未落盘的别名编辑（key = `${pluginId}:${command ?? '*'}`） */
const keywordEdits = new Map<string, string[]>()
const keywordTimers = new Map<string, number>()
/** 列表摘要：轮询只在真的变了的时候重渲染 */
let pluginsDigest = ''

function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function toast(message: string): void {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 1800)
}

async function guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败')
    return fallback
  }
}

function stateBadge(plugin: PluginLike): string {
  const map: Record<string, [string, string]> = {
    active: ['已启用', 'ok'],
    degraded: ['降级', 'warn'],
    disabled: ['已禁用', ''],
    error: ['加载失败', 'err'],
    crashed: ['已崩溃', 'err'],
    discovered: ['待加载', ''],
  }
  const [label, cls] = map[plugin.state] ?? [plugin.state, '']
  return `<span class="badge ${cls}">${label}</span>`
}

// ── 各页渲染 ───────────────────────────────────────────────────
function renderGeneral(): string {
  const c = config
  if (!c) return '<p class="muted">加载中…</p>'
  return `
    <h2>通用</h2>
    <div class="row">
      <div class="label">全局热键<div class="hint">形如 Alt+Space、Cmd+Shift+Space（注册失败会提示换键）</div></div>
      <input id="hotkey" type="text" value="${escapeHtml(c.hotkey.accelerator)}" />
      <button class="btn" id="apply-hotkey">应用</button>
    </div>
    <div class="row">
      <div class="label">开机自启</div>
      <input id="autostart" type="checkbox" ${c.autostart ? 'checked' : ''} />
    </div>
    <div class="row">
      <div class="label">失焦自动隐藏</div>
      <input id="hideOnBlur" type="checkbox" ${c.hideOnBlur ? 'checked' : ''} />
    </div>
    <div class="row">
      <div class="label">唤出时保留上次输入</div>
      <input id="keepQuery" type="checkbox" ${c.keepQuery ? 'checked' : ''} />
    </div>
    <div class="row">
      <div class="label">语言</div>
      <select id="language">
        <option value="zh-CN" ${c.language === 'zh-CN' ? 'selected' : ''}>简体中文</option>
        <option value="en-US" ${c.language === 'en-US' ? 'selected' : ''}>English</option>
      </select>
    </div>
  `
}

function renderAppearance(): string {
  const c = config
  if (!c) return '<p class="muted">加载中…</p>'
  return `
    <h2>外观</h2>
    <div class="row">
      <div class="label">主题</div>
      <select id="theme">
        <option value="system" ${c.theme === 'system' ? 'selected' : ''}>跟随系统</option>
        <option value="light" ${c.theme === 'light' ? 'selected' : ''}>浅色</option>
        <option value="dark" ${c.theme === 'dark' ? 'selected' : ''}>深色</option>
      </select>
    </div>
    <div class="row">
      <div class="label">主题色</div>
      <input id="accent" type="color" value="${escapeHtml(c.accent)}" />
    </div>
    <div class="row">
      <div class="label">结果密度</div>
      <select id="density">
        <option value="comfortable" ${c.density === 'comfortable' ? 'selected' : ''}>宽松</option>
        <option value="compact" ${c.density === 'compact' ? 'selected' : ''}>紧凑</option>
      </select>
    </div>
  `
}

// ── 插件页：主从两栏（左列表 / 右详情，别名就地编辑）──────────────
function editKey(pluginId: string, command?: string): string {
  return `${pluginId}:${command ?? '*'}`
}

function parseEditKey(key: string): { pluginId: string; command?: string } {
  const index = key.lastIndexOf(':')
  if (index < 0) return { pluginId: key }
  const command = key.slice(index + 1)
  const pluginId = key.slice(0, index)
  return command && command !== '*' ? { pluginId, command } : { pluginId }
}

function pluginById(id: string | null): PluginLike | null {
  return id ? (plugins.find((plugin) => plugin.id === id) ?? null) : null
}

/** 别名现值：编辑中的用未落盘的编辑态，其余用内核回传的权威值 */
function keywordsOf(plugin: PluginLike, command?: string): string[] {
  const edited = keywordEdits.get(editKey(plugin.id, command))
  if (edited) return edited
  if (command) return plugin.commands.find((item) => item.name === command)?.keywords ?? []
  return plugin.keywords ?? []
}

function customizedOf(plugin: PluginLike, command?: string): boolean {
  if (keywordEdits.has(editKey(plugin.id, command))) return true
  if (command) return plugin.commands.find((item) => item.name === command)?.keywordsCustomized ?? false
  return plugin.keywordsCustomized
}

/** 列表摘要：轮询只在真的变了的时候重渲染（否则会打断正在输入的用户） */
function digestOf(list: PluginLike[]): string {
  return JSON.stringify(
    list.map((plugin) => [
      plugin.id,
      plugin.state,
      plugin.error ?? '',
      plugin.capabilities,
      plugin.deniedCapabilities,
      plugin.keywords ?? [],
      plugin.commands.map((command) => [command.name, command.keywords ?? [], command.error ?? '']),
    ]),
  )
}

function stateDot(state: string): string {
  const cls = state === 'active' || state === 'degraded' ? 'ok' : state === 'disabled' ? '' : 'err'
  return `<span class="dot ${cls}"></span>`
}

function pluginBucket(plugin: PluginLike): Exclude<PluginFilter, 'all'> {
  if (plugin.state === 'active' || plugin.state === 'degraded') return 'active'
  if (plugin.state === 'disabled') return 'disabled'
  return 'error'
}

function matchQuery(plugin: PluginLike): boolean {
  if (pluginFilter !== 'all' && pluginBucket(plugin) !== pluginFilter) return false
  const query = pluginQuery.trim().toLowerCase()
  if (!query) return true
  const haystack = [
    plugin.id,
    plugin.title,
    plugin.description ?? '',
    ...plugin.commands.map((command) => `${command.name} ${command.title}`),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function filteredPlugins(): PluginLike[] {
  // 基础能力置顶（sort 稳定：其余保持内核返回的 id 序）
  return plugins.filter(matchQuery).sort((a, b) => Number(b.essential) - Number(a.essential))
}

function renderPluginList(): string {
  return (
    filteredPlugins()
      .map((plugin) => {
        const active = plugin.id === selectedPluginId ? ' active' : ''
        const custom =
          plugin.keywordsCustomized || plugin.commands.some((command) => command.keywordsCustomized)
        // 基础能力没有开关（内核也拒绝禁用）；其余插件的开关：已禁用常显、启用中半透明常显、hover 全显。
        // role=switch + tabindex：键盘也能操作（Enter / 空格），可访问树里才看得见这个开关
        const enabled = plugin.state !== 'disabled'
        const toggle = plugin.essential
          ? ''
          : `<span class="mtoggle${enabled ? ' on' : ''}" data-toggle="${escapeHtml(plugin.id)}" role="switch" aria-checked="${enabled}" tabindex="0" title="${
              enabled ? '禁用' : '启用'
            }"></span>`
        return `
        <button class="mitem${active}" data-select="${escapeHtml(plugin.id)}">
          ${stateDot(plugin.state)}
          <span class="mname">${escapeHtml(plugin.title)}</span>
          ${plugin.essential ? '<span class="tag">基础</span>' : ''}
          ${custom ? '<span class="mdot" title="别名被改过"></span>' : ''}
          ${toggle}
          <span class="mmeta">${plugin.commands.length}</span>
        </button>
      `
      })
      .join('') || '<p class="muted" style="padding:12px">没有匹配的插件</p>'
  )
}

/** chip 编辑器外壳（内容由 chipsInnerHtml 生成，增删时只重建这一个容器） */
function renderChips(plugin: PluginLike, command?: string): string {
  const key = editKey(plugin.id, command)
  return `<div class="kwords" data-chips="${escapeHtml(key)}">${chipsInnerHtml(plugin, command)}</div>`
}

function renderPluginDetail(): string {
  const plugin = pluginById(selectedPluginId)
  if (!plugin) return '<div class="dempty muted">选择左侧的插件查看详情</div>'

  const capabilities = plugin.capabilities
    .map((cap) => `<button class="cap" data-cap="${escapeHtml(cap)}" title="点击拒绝该能力">${escapeHtml(cap)}</button>`)
    .join('')
  const denied = plugin.deniedCapabilities
    .map(
      (cap) =>
        `<button class="cap denied" data-cap="${escapeHtml(cap)}" title="点击恢复该能力">${escapeHtml(cap)}（已拒绝）</button>`,
    )
    .join('')
  const capabilityHtml = capabilities || denied ? `${capabilities}${denied}` : '<span class="muted">无</span>'

  const commands =
    plugin.commands
      .map((command) => {
        const badges = [`<span class="badge">${escapeHtml(command.mode)}</span>`]
        if (command.searchable) badges.push('<span class="badge ok">可搜索</span>')
        if (command.contributes) badges.push('<span class="badge ok">贡献结果</span>')
        if (command.hidden) badges.push('<span class="badge">隐藏</span>')
        const editable = command.searchable || command.contributes
        return `
        <div class="cmd">
          <div class="cmd-head">
            <code>${escapeHtml(command.name)}</code>
            <span>${escapeHtml(command.title)}</span>
            ${badges.join(' ')}
          </div>
          ${
            editable
              ? renderChips(plugin, command.name)
              : '<div class="hint">该命令不参与搜索，不需要别名</div>'
          }
          ${command.error ? `<div class="hint danger-text">${escapeHtml(command.error)}</div>` : ''}
        </div>
      `
      })
      .join('') || '<p class="muted">没有命令</p>'

  const actions = [
    plugin.essential
      ? ''
      : plugin.state === 'disabled'
        ? `<button class="btn" data-action="enable" data-id="${escapeHtml(plugin.id)}">启用</button>`
        : `<button class="btn" data-action="disable" data-id="${escapeHtml(plugin.id)}">禁用</button>`,
    `<button class="btn" data-action="reload" data-id="${escapeHtml(plugin.id)}">重载</button>`,
    `<button class="btn" data-action="reveal" data-id="${escapeHtml(plugin.id)}">打开目录</button>`,
    `<button class="btn" data-action="openData" data-id="${escapeHtml(plugin.id)}">数据目录</button>`,
    plugin.builtin
      ? ''
      : `<button class="btn danger" data-action="uninstall" data-id="${escapeHtml(plugin.id)}">卸载</button>`,
  ].join('')

  return `
    <div class="dhead">
      <div class="dtitle">
        <strong>${escapeHtml(plugin.title)}</strong>
        <span class="muted">${escapeHtml(plugin.version)}</span>
        ${stateBadge(plugin)}
        ${
          plugin.essential
            ? '<span class="badge accent">基础能力</span>'
            : plugin.builtin
              ? '<span class="badge">出厂自带</span>'
              : ''
        }
      </div>
      ${plugin.description ? `<div class="hint">${escapeHtml(plugin.description)}</div>` : ''}
      <div class="hint">${escapeHtml(plugin.id)} ｜ apiVersion ${escapeHtml(plugin.apiVersion)}${
        plugin.author ? ` ｜ ${escapeHtml(plugin.author)}` : ''
      }</div>
      ${plugin.error ? `<div class="hint danger-text">${escapeHtml(plugin.error)}</div>` : ''}
    </div>

    <section class="dsec">
      <h3>能力 <span class="hint">点一下即可拒绝 / 恢复（会重载该插件）</span></h3>
      <div class="caps">${capabilityHtml}</div>
    </section>

    <section class="dsec">
      <h3>插件别名 <span class="hint">兜底给该插件的全部入口命令</span></h3>
      ${renderChips(plugin)}
    </section>

    <section class="dsec">
      <h3>命令（${plugin.commands.length}）</h3>
      ${commands}
    </section>

    <section class="dsec danger">
      ${
        plugin.essential
          ? '<div class="hint">底座基础能力：不可禁用、不可卸载 —— 禁用会让启动台失去基本功能，或让你没有办法把设置改回来</div>'
          : ''
      }
      <div class="hint path">${escapeHtml(plugin.dir)}</div>
      <div class="dactions">${actions}</div>
    </section>
  `
}

function renderPlugins(): string {
  if (plugins.length === 0) return '<div class="dempty muted">没有已安装的插件</div>'
  const counts: Record<PluginFilter, number> = {
    all: plugins.length,
    active: plugins.filter((plugin) => pluginBucket(plugin) === 'active').length,
    disabled: plugins.filter((plugin) => pluginBucket(plugin) === 'disabled').length,
    error: plugins.filter((plugin) => pluginBucket(plugin) === 'error').length,
  }
  const filters = (
    [
      ['all', '全部'],
      ['active', '启用'],
      ['disabled', '禁用'],
      ['error', '异常'],
    ] as Array<[PluginFilter, string]>
  )
    .map(
      ([id, label]) =>
        `<button class="filter${pluginFilter === id ? ' active' : ''}" data-filter="${id}">${label} ${counts[id]}</button>`,
    )
    .join('')

  return `
    <div class="manage">
      <aside class="mlist">
        <div class="msearch">
          <input id="plugin-search" type="text" placeholder="搜索插件 / 命令…" value="${escapeHtml(pluginQuery)}" />
          <div class="filters">${filters}</div>
        </div>
        <div class="mitems">${renderPluginList()}</div>
        <div class="mfoot">
          <button class="btn" id="installToggle">${installOpen ? '收起安装' : '+ 安装插件'}</button>
          <button class="btn" id="reloadAll">全部重载</button>
          ${
            installOpen
              ? `<div class="install-box">
                   <input id="installPath" type="text" placeholder="/Users/me/Downloads/my-plugin.zip" />
                   <button class="btn primary" id="install">安装</button>
                   <span class="hint">支持 zip 与目录；也可把 zip 拖进启动台窗口</span>
                 </div>`
              : ''
          }
        </div>
      </aside>
      <section class="mdetail">${renderPluginDetail()}</section>
    </div>
  `
}

function renderData(): string {
  const c = config
  return `
    <h2>数据</h2>
    <div class="row">
      <div class="label">历史上限（100–2000）</div>
      <input id="historyLimit" type="number" min="100" max="2000" step="50" value="${c?.historyLimit ?? 500}" />
      <button class="btn" id="apply-limit">应用</button>
    </div>
    <div class="row">
      <div class="label">最近使用参与搜索</div>
      <input id="historyInSearch" type="checkbox" ${c?.historyInSearch ? 'checked' : ''} />
    </div>
    <div class="row">
      <div class="label">清空最近使用（固定项保留）</div>
      <button class="btn danger" id="clear-history">清空</button>
    </div>
    <div class="row">
      <div class="label">清空审计日志</div>
      <button class="btn danger" id="clear-audit">清空</button>
    </div>
    <div class="row">
      <div class="label">数据目录<div class="hint" id="dataRoot">${escapeHtml('')}</div></div>
      <button class="btn" id="open-data">打开</button>
    </div>
    <h2 style="margin-top:20px">最近审计（${audit.length}）</h2>
    ${audit
      .slice(0, 60)
      .map(
        (record) => `
      <div class="row">
        <div class="label">
          <div>${escapeHtml(record.method)} <span class="badge">${escapeHtml(record.pluginId)}</span>
          ${record.ok ? '<span class="badge ok">ok</span>' : `<span class="badge err">${escapeHtml(record.error?.code ?? 'ERR')}</span>`}
          </div>
          <div class="hint">${new Date(record.ts).toLocaleTimeString()} ｜ ${record.ms}ms${
            record.capability ? ` ｜ ${escapeHtml(record.capability)}` : ''
          }${record.error ? ` ｜ ${escapeHtml(record.error.message)}` : ''}</div>
        </div>
      </div>
    `,
      )
      .join('') || '<p class="muted">暂无记录</p>'}
  `
}

function renderAbout(): string {
  const info = aboutInfo
  return `
    <h2>关于</h2>
    <div class="row"><div class="label">版本</div><span class="muted">${escapeHtml(info.version)}</span></div>
    <div class="row"><div class="label">平台</div><span class="muted">${escapeHtml(info.platform)}</span></div>
    <div class="row"><div class="label">Node</div><span class="muted">${escapeHtml(info.node)}</span></div>
    <div class="row"><div class="label">数据目录</div><span class="muted">${escapeHtml(info.dataRoot)}</span></div>
    <div class="card">
      <strong>底座原则</strong>
      <div class="hint">底座零能力：内核里不出现任何具体能力，所有能力（含「启动应用」本身）都以插件形式集成。</div>
      <div class="hint">能力即权限：未在清单声明的能力在装配期就不挂载，插件侧表现为「方法不存在」，且有审计记录。</div>
      <div class="hint">许可证：本底座为 MIT；内置应用扫描逻辑移植自 ZTools（MIT），见 docs/THIRD-PARTY.md。</div>
    </div>
  `
}

let aboutInfo = { version: '', platform: '', node: '', dataRoot: '' }

function render(): void {
  tabsEl.innerHTML = TABS.map(
    (tab) => `<button class="tab ${tab.id === activeTab ? 'active' : ''}" data-tab="${tab.id}">${tab.label}</button>`,
  ).join('')

  // 插件页是主从两栏：两栏各自滚动，面板本身不留内边距
  panelEl.classList.toggle('flush', activeTab === 'plugins')

  panelEl.innerHTML =
    activeTab === 'general'
      ? renderGeneral()
      : activeTab === 'appearance'
        ? renderAppearance()
        : activeTab === 'plugins'
          ? renderPlugins()
          : activeTab === 'data'
            ? renderData()
            : renderAbout()

  const dataRootEl = document.getElementById('dataRoot')
  if (dataRootEl) dataRootEl.textContent = aboutInfo.dataRoot
  bind()
}

// ── 事件绑定 ───────────────────────────────────────────────────
function on<K extends keyof HTMLElementEventMap>(
  id: string,
  event: K,
  handler: (el: HTMLElement) => void,
): void {
  const el = document.getElementById(id)
  if (el) el.addEventListener(event, () => handler(el))
}

async function patch(patchValue: Record<string, unknown>, message = '已保存'): Promise<void> {
  const result = await guard(() => settings.patch(patchValue), null)
  if (!result) return
  config = result.config as ConfigLike
  if (result.hotkey && !result.hotkey.ok) toast(`热键注册失败：${result.hotkey.reason ?? '可能被占用'}`)
  else toast(message)
  render()
}

function bind(): void {
  for (const button of tabsEl.querySelectorAll<HTMLElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      activeTab = (button.dataset.tab as TabId) ?? 'general'
      render()
    })
  }

  on('apply-hotkey', 'click', () => {
    const value = (document.getElementById('hotkey') as HTMLInputElement | null)?.value?.trim()
    if (!value) return
    void patch({ hotkey: { accelerator: value } }, '热键已更新')
  })
  on('autostart', 'change', (el) => void patch({ autostart: (el as HTMLInputElement).checked }))
  on('hideOnBlur', 'change', (el) => void patch({ hideOnBlur: (el as HTMLInputElement).checked }))
  on('keepQuery', 'change', (el) => void patch({ keepQuery: (el as HTMLInputElement).checked }))
  on('language', 'change', (el) => void patch({ language: (el as HTMLSelectElement).value }))

  on('theme', 'change', (el) => void patch({ theme: (el as HTMLSelectElement).value }))
  on('accent', 'change', (el) => void patch({ accent: (el as HTMLInputElement).value }))
  on('density', 'change', (el) => void patch({ density: (el as HTMLSelectElement).value }))

  on('historyInSearch', 'change', (el) => void patch({ historyInSearch: (el as HTMLInputElement).checked }))
  on('apply-limit', 'click', () => {
    const value = Number((document.getElementById('historyLimit') as HTMLInputElement | null)?.value)
    if (!Number.isFinite(value)) return
    void patch({ historyLimit: value }, '历史上限已更新')
  })
  on('clear-history', 'click', async () => {
    await guard(() => settings.clearHistory(), undefined)
    toast('历史已清空')
  })
  on('clear-audit', 'click', async () => {
    await guard(() => settings.clearAudit(), undefined)
    audit = []
    toast('审计已清空')
    render()
  })
  on('open-data', 'click', () => void guard(() => settings.openDataDir(), undefined))

  // 插件页的交互全部走 panelEl 上的事件委托（渲染会重建 DOM，逐个绑定会失效），
  // 见文件末尾的 onPanelClick / onPanelKeydown / onPanelInput / onPanelFocusOut。
}

// ── 插件页交互 ─────────────────────────────────────────────────
function chipsContainer(key: string): HTMLElement | null {
  for (const element of panelEl.querySelectorAll<HTMLElement>('[data-chips]')) {
    if (element.dataset.chips === key) return element
  }
  return null
}

function chipsInnerHtml(plugin: PluginLike, command?: string): string {
  const key = editKey(plugin.id, command)
  const chips = keywordsOf(plugin, command)
    .map(
      (word) =>
        `<span class="chip" data-word="${escapeHtml(word)}">${escapeHtml(word)}<button class="chip-x" data-chip-del title="删除">×</button></span>`,
    )
    .join('')
  const reset = customizedOf(plugin, command)
    ? `<button class="btn tiny" data-reset="${escapeHtml(key)}">恢复默认</button>`
    : ''
  return `
    <div class="chips">
      ${chips}
      <input class="chip-input" data-chip-input="${escapeHtml(key)}" placeholder="+ 添加别名" />
    </div>
    <div class="chips-bar">
      <span class="hint">回车或逗号添加；改动自动保存，搜索立即生效</span>
      ${reset}
    </div>
  `
}

function rerenderChips(pluginId: string, command?: string, focus = false): void {
  const plugin = pluginById(pluginId)
  const container = chipsContainer(editKey(pluginId, command))
  if (!plugin || !container) return
  container.innerHTML = chipsInnerHtml(plugin, command)
  if (focus) container.querySelector<HTMLInputElement>('.chip-input')?.focus()
}

function scheduleKeywordSave(pluginId: string, command?: string): void {
  const key = editKey(pluginId, command)
  const timer = keywordTimers.get(key)
  if (timer) window.clearTimeout(timer)
  keywordTimers.set(
    key,
    window.setTimeout(() => void saveKeywords(pluginId, command), 600),
  )
}

async function saveKeywords(pluginId: string, command?: string): Promise<void> {
  const key = editKey(pluginId, command)
  const timer = keywordTimers.get(key)
  if (timer) {
    window.clearTimeout(timer)
    keywordTimers.delete(key)
  }
  const words = keywordEdits.get(key)
  if (!words) return
  const payload: Record<string, unknown> = { id: pluginId, keywords: words }
  if (command) payload.command = command
  const result = await guard(
    () => settings.pluginAction('setKeywords', payload) as Promise<{ plugins?: PluginLike[] }>,
    null,
  )
  if (!result) return
  keywordEdits.delete(key)
  if (result.plugins) {
    plugins = result.plugins
    pluginsDigest = digestOf(plugins)
  }
  toast('已保存，搜索立即生效')
}

async function resetKeywords(pluginId: string, command?: string): Promise<void> {
  const key = editKey(pluginId, command)
  const timer = keywordTimers.get(key)
  if (timer) {
    window.clearTimeout(timer)
    keywordTimers.delete(key)
  }
  keywordEdits.delete(key)
  const payload: Record<string, unknown> = { id: pluginId }
  if (command) payload.command = command
  const result = await guard(
    () => settings.pluginAction('resetKeywords', payload) as Promise<{ plugins?: PluginLike[] }>,
    null,
  )
  if (!result) return
  if (result.plugins) {
    plugins = result.plugins
    pluginsDigest = digestOf(plugins)
  }
  toast('已恢复默认')
  render()
}

/** 把输入框里的文本并成 chip（回车 / 逗号 / 失焦都走这里） */
function commitKeywordInput(input: HTMLInputElement): void {
  const key = input.dataset.chipInput
  if (!key) return
  const { pluginId, command } = parseEditKey(key)
  const plugin = pluginById(pluginId)
  if (!plugin) return
  const additions = input.value
    .split(/[,，\s]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  if (additions.length === 0) return

  const next: string[] = []
  const seen = new Set<string>()
  for (const word of [...keywordsOf(plugin, command), ...additions]) {
    const lower = word.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    next.push(word)
  }
  if (next.length > MAX_KEYWORDS) {
    toast(`最多 ${MAX_KEYWORDS} 个别名`)
    next.length = MAX_KEYWORDS
  }
  keywordEdits.set(key, next)
  input.value = ''
  rerenderChips(pluginId, command, true)
  scheduleKeywordSave(pluginId, command)
}

function removeKeyword(key: string, word: string): void {
  const { pluginId, command } = parseEditKey(key)
  const plugin = pluginById(pluginId)
  if (!plugin) return
  keywordEdits.set(
    key,
    keywordsOf(plugin, command).filter((item) => item !== word),
  )
  rerenderChips(pluginId, command)
  scheduleKeywordSave(pluginId, command)
}

async function toggleCapability(pluginId: string, capability: string): Promise<void> {
  const plugin = pluginById(pluginId)
  if (!plugin) return
  const denied = plugin.deniedCapabilities.includes(capability)
  const verb = denied ? '恢复' : '拒绝'
  if (!window.confirm(`${verb}能力「${capability}」？插件会立即重载，正在打开的插件页会重开。`)) return
  const result = await guard(
    () => settings.pluginAction('setCapability', { id: pluginId, capability, denied: !denied }),
    null,
  )
  if (!result) return
  toast(`已${verb}：${capability}`)
  await loadPlugins()
  render()
}

async function runPluginAction(action: string, id: string): Promise<void> {
  if (action === 'uninstall' && !window.confirm(`确定卸载插件「${id}」？其数据目录会保留。`)) return
  const result = await guard(() => settings.pluginAction(action, { id }), null)
  if (!result) return
  toast(action === 'disable' ? '已禁用' : action === 'enable' ? '已启用' : '已执行')
  await loadPlugins()
  render()
}

function selectPlugin(id: string): void {
  if (selectedPluginId === id) return
  selectedPluginId = id
  const list = panelEl.querySelector('.mitems')
  if (list) list.innerHTML = renderPluginList()
  const detail = panelEl.querySelector('.mdetail')
  if (detail) detail.innerHTML = renderPluginDetail()
}

function setPluginFilter(filter: PluginFilter): void {
  pluginFilter = filter
  for (const button of panelEl.querySelectorAll<HTMLElement>('[data-filter]')) {
    button.classList.toggle('active', button.dataset.filter === filter)
  }
  const list = panelEl.querySelector('.mitems')
  if (list) list.innerHTML = renderPluginList()
}

async function installPlugin(): Promise<void> {
  const target = (document.getElementById('installPath') as HTMLInputElement | null)?.value?.trim()
  if (!target) return
  const action = target.toLowerCase().endsWith('.zip') ? 'installZip' : 'installDir'
  const result = await guard(() => settings.pluginAction(action, { path: target, overwrite: false }), null)
  if (!result) return
  toast('安装完成')
  installOpen = false
  await loadPlugins()
  render()
}

async function reloadAllPlugins(): Promise<void> {
  const result = await guard(() => settings.pluginAction('reloadAll'), null)
  if (!result) return
  toast('已重载全部插件')
  await loadPlugins()
  render()
}

/** 正在编辑（输入框有焦点 / 有没落盘的别名）——轮询刷新要让路 */
function isEditing(): boolean {
  const active = document.activeElement
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return true
  return keywordEdits.size > 0 || keywordTimers.size > 0
}

function onPanelClick(event: Event): void {
  const node = event.target as HTMLElement
  // 开关必须排在「选中」之前：它长在列表项里面（点击会同时命中 data-select）
  const toggle = node.closest<HTMLElement>('[data-toggle]')
  if (toggle?.dataset.toggle) {
    const plugin = pluginById(toggle.dataset.toggle)
    if (plugin) void runPluginAction(plugin.state === 'disabled' ? 'enable' : 'disable', plugin.id)
    return
  }
  const select = node.closest<HTMLElement>('[data-select]')
  if (select?.dataset.select) {
    selectPlugin(select.dataset.select)
    return
  }
  const filter = node.closest<HTMLElement>('[data-filter]')
  if (filter?.dataset.filter) {
    setPluginFilter(filter.dataset.filter as PluginFilter)
    return
  }
  const chipDel = node.closest<HTMLElement>('[data-chip-del]')
  if (chipDel) {
    const key = chipDel.closest<HTMLElement>('[data-chips]')?.dataset.chips
    const word = chipDel.closest<HTMLElement>('.chip')?.dataset.word
    if (key && word) removeKeyword(key, word)
    return
  }
  const reset = node.closest<HTMLElement>('[data-reset]')
  if (reset?.dataset.reset) {
    const { pluginId, command } = parseEditKey(reset.dataset.reset)
    void resetKeywords(pluginId, command)
    return
  }
  const capability = node.closest<HTMLElement>('[data-cap]')
  if (capability?.dataset.cap && selectedPluginId) {
    void toggleCapability(selectedPluginId, capability.dataset.cap)
    return
  }
  const action = node.closest<HTMLElement>('[data-action]')
  if (action?.dataset.action && action.dataset.id) {
    void runPluginAction(action.dataset.action, action.dataset.id)
    return
  }
  if (node.closest('#installToggle')) {
    installOpen = !installOpen
    render()
    return
  }
  if (node.closest('#install')) {
    void installPlugin()
    return
  }
  if (node.closest('#reloadAll')) void reloadAllPlugins()
}

function onPanelKeydown(event: KeyboardEvent): void {
  // 列表开关（role=switch）用 Enter / 空格切换 —— 别让它落到外层列表项的默认行为上
  const switchEl = (event.target as HTMLElement).closest<HTMLElement>('[data-toggle]')
  if (switchEl) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    const plugin = pluginById(switchEl.dataset.toggle ?? '')
    if (plugin) void runPluginAction(plugin.state === 'disabled' ? 'enable' : 'disable', plugin.id)
    return
  }

  const input = (event.target as HTMLElement).closest<HTMLInputElement>('.chip-input')
  if (!input) return
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault()
    commitKeywordInput(input)
    return
  }
  if (event.key === 'Backspace' && input.value === '') {
    const key = input.dataset.chipInput
    const chips = key ? chipsContainer(key)?.querySelectorAll<HTMLElement>('.chip') : undefined
    const last = chips?.[chips.length - 1]
    if (key && last?.dataset.word) removeKeyword(key, last.dataset.word)
  }
}

function onPanelInput(event: Event): void {
  const target = event.target as HTMLElement
  if (target.id !== 'plugin-search') return
  pluginQuery = (target as HTMLInputElement).value
  // 只刷新列表：输入框本身不重建，光标与焦点都保住
  const list = panelEl.querySelector('.mitems')
  if (list) list.innerHTML = renderPluginList()
}

function onPanelFocusOut(event: Event): void {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('.chip-input')
  if (input) commitKeywordInput(input)
}

// 拉取失败（重载期间会话短暂失效等）保留上一次结果：列表闪成「没有已安装的插件」比不刷新更糟
async function loadPlugins(): Promise<void> {
  try {
    plugins = (await settings.plugins()) as PluginLike[]
    pluginsDigest = digestOf(plugins)
    if (selectedPluginId && !plugins.some((plugin) => plugin.id === selectedPluginId)) {
      selectedPluginId = null
    }
    if (!selectedPluginId && plugins.length > 0) selectedPluginId = plugins[0]?.id ?? null
  } catch {
    /* 保留上一次列表 */
  }
}

async function loadAudit(): Promise<void> {
  try {
    audit = (await settings.audit(120)) as AuditLike[]
  } catch {
    /* 保留上一次列表 */
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme')
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
  activeTab = params.get('cmd') === 'manage' ? 'plugins' : 'general'

  const info = await guard(() => host.info(), null)
  aboutInfo = {
    version: info?.version ?? '',
    platform: info?.platform ?? '',
    node: '—',
    dataRoot: info?.dataRoot ?? '',
  }
  const cfg = await guard(() => settings.get(), null)
  config = cfg as ConfigLike | null
  const hostInfo = await guard(() => settings.info(), null)
  if (hostInfo) aboutInfo = { ...aboutInfo, ...hostInfo }

  await loadPlugins()
  await loadAudit()
  render()

  // 插件状态变化时保持列表新鲜：
  // 只有「真的变了」且「用户没在编辑」才重渲染 —— 早先每 4s 无条件 render()，
  // 会把正在输入的搜索框 / 别名输入框整个重建，输入被打断、焦点丢失。
  window.setInterval(() => {
    if (activeTab !== 'plugins') return
    void (async () => {
      const before = pluginsDigest
      await loadPlugins()
      if (activeTab !== 'plugins' || pluginsDigest === before || isEditing()) return
      render()
    })()
  }, 4000)
}

// 委托绑定只做一次（panelEl 常驻，render 只替换它的 innerHTML）
panelEl.addEventListener('click', onPanelClick)
panelEl.addEventListener('keydown', onPanelKeydown)
panelEl.addEventListener('input', onPanelInput)
panelEl.addEventListener('focusout', onPanelFocusOut)

void boot()
