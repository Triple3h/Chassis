/**
 * 设置 + 插件管理（管理面 view 插件）。
 * 用原生 DOM 渲染（体积小、无需框架），所有数据来自 `ctx.settings`（仅 internal 插件可用）。
 */
import { host, settings } from '@launcher/api'
import type { LogExportResult } from '@launcher/api'
import { iconSvg } from '@launcher/ui/icons'

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

/** 插件设置项（清单声明 + 生效值；渲染成通用表单） */
interface SettingLike {
  key: string
  type: 'select' | 'switch' | 'text'
  title: string
  description?: string
  default?: string | boolean
  options?: Array<{ value: string; label: string }>
  value?: string | boolean
  /** 被用户改过（显示「恢复默认」） */
  customized: boolean
}

interface PluginLike {
  id: string
  title: string
  version: string
  description?: string
  author?: string
  /** 清单 `icon`：lucide 名 / `data:image/...`（插件内相对路径的图标这里够不到，见 `pluginLogo`） */
  icon?: string
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
  /** 插件设置（清单未声明时为空数组） */
  settings: SettingLike[]
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
/** 会话 URL 带来的宿主主题，`config` 还没拉回来时先用它兜底 */
let urlTheme: string | null = null

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

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/**
 * 外观就地生效：主题 / 主题色都是在本页改的，改完不反映到本页就会被当成「没生效」。
 *
 * 其它插件页不跟随主题色 —— 会话 URL 只带 `theme`（plugin-spec §5.3）；
 * 这一页能跟是因为新配置就在 patch 的返回值里，不必再问宿主。
 */
function applyAppearance(): void {
  const wanted = config?.theme && config.theme !== 'system' ? config.theme : urlTheme
  document.documentElement.dataset.theme = wanted === 'light' || wanted === 'dark' ? wanted : prefersDark() ? 'dark' : 'light'
  if (config?.accent) document.documentElement.style.setProperty('--accent', config.accent)
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
interface SelectOption {
  value: string
  label: string
}

/**
 * 自绘下拉的 HTML。
 *
 * 原生 `<select>` 的**弹出菜单**由 macOS 系统绘制（NSMenu）—— 不跟主题、不跟主题色，
 * `color-scheme` 也改不动它 ⇒ 页里一律用它，交互在事件委托区（openSelectMenu 等）。
 * 与插件套件 `@launcher/ui` 的 `UiSelect.vue` 同款设计。
 */
function selectHtml(id: string, value: string, options: SelectOption[]): string {
  const current = options.find((option) => option.value === value) ?? options[0]
  const items = options
    .map((option) => {
      const on = option.value === current?.value
      return `<button type="button" class="lselect-option${on ? ' is-on' : ''}" role="option" aria-selected="${on}" data-value="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span><span class="lselect-check">✓</span></button>`
    })
    .join('')
  return `
    <div class="lselect" data-lselect="${id}">
      <button type="button" class="lselect-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="lselect-value">${escapeHtml(current?.label ?? '')}</span>
        <span class="lselect-caret"></span>
      </button>
      <div class="lselect-menu" role="listbox" hidden>${items}</div>
    </div>`
}

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
      ${selectHtml('language', c.language, [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'en-US', label: 'English' },
      ])}
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
      ${selectHtml('theme', c.theme, [
        { value: 'system', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
      ])}
    </div>
    <div class="row">
      <div class="label">主题色</div>
      <input id="accent" type="color" value="${escapeHtml(c.accent)}" />
    </div>
    <div class="row">
      <div class="label">结果密度</div>
      ${selectHtml('density', c.density, [
        { value: 'comfortable', label: '宽松' },
        { value: 'compact', label: '紧凑' },
      ])}
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
      plugin.settings.map((setting) => [setting.key, setting.value ?? null, setting.customized]),
      plugin.commands.map((command) => [command.name, command.keywords ?? [], command.error ?? '']),
      // icon 参与摘要：改了清单图标再重载，列表要跟着换（不给它的话轮询认不出变化）
      plugin.icon ?? '',
    ]),
  )
}

function stateDot(state: string): string {
  const cls = state === 'active' || state === 'degraded' ? 'ok' : state === 'disabled' ? '' : 'err'
  return `<span class="dot ${cls}"></span>`
}

/**
 * 插件 logo 磁贴：清单 `icon`（lucide 名）→ 内置图标表；`data:` / `http(s):` 直接当图片画。
 *
 * 观感与宿主结果网格一致（`IconGlyph.vue`：圆角 = 22% 边长、磁贴底色 `--hover`、字形占 56%）。
 * 画不出来的（没有 icon、名字不在表里、插件内相对路径的图标 —— iframe 的 CSP 只放行 self，
 * 够不到别的插件端口）退回首字母磁贴，不留下空位。
 */
function pluginLogo(plugin: PluginLike, size: number): string {
  const box = `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px`
  const icon = plugin.icon
  if (icon && /^(https?:|data:)/.test(icon)) {
    return `<span class="plogo" style="${box}"><img src="${escapeHtml(icon)}" alt="" draggable="false" /></span>`
  }
  const svg = iconSvg(icon, Math.round(size * 0.56))
  if (svg) return `<span class="plogo" style="${box}">${svg}</span>`
  const initial = (plugin.title || plugin.id).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 1).toUpperCase() || '·'
  return `<span class="plogo letter" style="${box};font-size:${Math.round(size * 0.42)}px">${escapeHtml(initial)}</span>`
}

/** 列表行首的「logo + 状态点」：状态点做成磁贴右下角的小角标（省一段行宽，状态跟着图标走） */
function pluginLogoWithState(plugin: PluginLike, size: number): string {
  return `<span class="plogo-wrap" style="width:${size}px;height:${size}px">${pluginLogo(plugin, size)}${stateDot(plugin.state)}</span>`
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
          ${pluginLogoWithState(plugin, 20)}
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

/**
 * 插件设置：按清单声明渲染（select / switch / text）。
 * 控件带 `data-setting="<pluginId>:<key>"`，值变化走事件委托 → `setSetting`（内核重载该插件）。
 * select 复用自绘下拉，id 前缀 `setting:` 由 SELECT 落值处分流。
 */
function renderSettingRows(plugin: PluginLike): string {
  return plugin.settings
    .map((setting) => {
      const value = setting.value ?? setting.default
      const id = escapeHtml(settingEditId(plugin.id, setting.key))
      let control: string
      if (setting.type === 'select') {
        control = selectHtml(`setting:${settingEditId(plugin.id, setting.key)}`, String(value ?? ''), setting.options ?? [])
      } else if (setting.type === 'switch') {
        control = `<input type="checkbox" data-setting="${id}" ${value === true ? 'checked' : ''} />`
      } else {
        control = `<input type="text" data-setting="${id}" value="${escapeHtml(value ?? '')}" />`
      }
      const reset = setting.customized
        ? `<button class="btn tiny" data-setting-reset="${id}">恢复默认</button>`
        : ''
      return `
        <div class="srow">
          <div class="slabel">
            <div>${escapeHtml(setting.title)}</div>
            ${setting.description ? `<div class="hint">${escapeHtml(setting.description)}</div>` : ''}
          </div>
          <div class="scontrol">${control}${reset}</div>
        </div>`
    })
    .join('')
}

/** chip 编辑器外壳（内容由 chipsInnerHtml 生成，增删时只重建这一个容器） */
function renderChips(plugin: PluginLike, command?: string): string {
  const key = editKey(plugin.id, command)
  return `<div class="kwords" data-chips="${escapeHtml(key)}">${chipsInnerHtml(plugin, command)}</div>`
}

// ── 详情分页（TAB）──────────────────────────────────────────
type DetailTab = 'overview' | 'settings' | 'keywords' | 'commands'

/** 当前详情页；会话内记忆，切插件时保留（换到没有该页的插件时回落「概览」） */
let detailTab: DetailTab = 'overview'

/**
 * 详情页由**插件声明**驱动：「设置」只在清单声明了 `settings` 时激活（内核 `info()` 里带的就是
 * 声明 + 生效值）——声明了设置就自动多出一页，设置页不用为哪个插件特判。
 * 小圆点 = 这一页里有「被用户改过」的东西（设置项 / 别名），一眼看出动过哪里。
 */
function detailTabsOf(plugin: PluginLike): Array<{ id: DetailTab; label: string; dot: boolean }> {
  const tabs: Array<{ id: DetailTab; label: string; dot: boolean }> = [{ id: 'overview', label: '概览', dot: false }]
  if (plugin.settings.length > 0) {
    tabs.push({ id: 'settings', label: '设置', dot: plugin.settings.some((setting) => setting.customized) })
  }
  tabs.push({
    id: 'keywords',
    label: '别名',
    dot: plugin.keywordsCustomized || plugin.commands.some((command) => command.keywordsCustomized),
  })
  tabs.push({ id: 'commands', label: `命令 ${plugin.commands.length}`, dot: false })
  return tabs
}

/** 头部：只留「这是谁、什么状态」（元信息与操作都在「概览」页里） */
function renderDetailHead(plugin: PluginLike): string {
  return `
    <div class="dhead">
      <div class="dhead-main">
        ${pluginLogo(plugin, 34)}
        <div class="dhead-text">
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
          ${plugin.error ? `<div class="hint danger-text">${escapeHtml(plugin.error)}</div>` : ''}
        </div>
      </div>
    </div>
  `
}

/** 概览：插件信息（id / apiVersion / 作者 / 目录）+ 能力 + 操作 */
function renderOverviewTab(plugin: PluginLike): string {
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
    <section class="dsec">
      <h3>插件信息</h3>
      <div class="kv">
        <div class="k">插件 id</div>
        <div class="v">${escapeHtml(plugin.id)}</div>
        <div class="k">apiVersion</div>
        <div class="v">${escapeHtml(plugin.apiVersion)}</div>
        ${plugin.author ? `<div class="k">作者</div><div class="v">${escapeHtml(plugin.author)}</div>` : ''}
        <div class="k">安装目录</div>
        <div class="v path">${escapeHtml(plugin.dir)}</div>
      </div>
    </section>

    <section class="dsec">
      <h3>能力 <span class="hint">点一下即可拒绝 / 恢复（会重载该插件）</span></h3>
      <div class="caps">${capabilityHtml}</div>
    </section>

    <section class="dsec">
      <h3>操作</h3>
      ${
        plugin.essential
          ? '<div class="hint">底座基础能力：不可禁用、不可卸载 —— 禁用会让启动台失去基本功能，或让你没有办法把设置改回来</div>'
          : ''
      }
      <div class="dactions">${actions}</div>
    </section>
  `
}

/** 设置：仅在插件声明了 `settings` 时才有这一页 */
function renderSettingsTab(plugin: PluginLike): string {
  return `
    <section class="dsec">
      <h3>插件设置 <span class="hint">改完立即保存（插件会重载一次）</span></h3>
      ${renderSettingRows(plugin)}
    </section>
  `
}

/** 别名：插件级别的兜底别名（命令自己的别名在「命令」页） */
function renderKeywordsTab(plugin: PluginLike): string {
  return `
    <section class="dsec">
      <h3>插件别名 <span class="hint">兜底给该插件的全部入口命令；单条命令的别名在「命令」页</span></h3>
      ${renderChips(plugin)}
    </section>
  `
}

/** 命令：逐条列出，可就地改命令级别名 */
function renderCommandsTab(plugin: PluginLike): string {
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
  return `
    <section class="dsec">
      <h3>命令（${plugin.commands.length}）</h3>
      ${commands}
    </section>
  `
}

function renderDetailTab(plugin: PluginLike, tab: DetailTab): string {
  if (tab === 'settings') return renderSettingsTab(plugin)
  if (tab === 'keywords') return renderKeywordsTab(plugin)
  if (tab === 'commands') return renderCommandsTab(plugin)
  return renderOverviewTab(plugin)
}

function renderPluginDetail(): string {
  const plugin = pluginById(selectedPluginId)
  if (!plugin) return '<div class="dempty muted">选择左侧的插件查看详情</div>'
  const tabs = detailTabsOf(plugin)
  const active = tabs.some((tab) => tab.id === detailTab) ? detailTab : 'overview'

  return `
    ${renderDetailHead(plugin)}
    <nav class="dtabs" role="tablist">
      ${tabs
        .map(
          (tab) =>
            `<button class="dtab${tab.id === active ? ' active' : ''}" role="tab" aria-selected="${
              tab.id === active
            }" data-dtab="${tab.id}">${escapeHtml(tab.label)}${tab.dot ? '<i title="有改动过的项"></i>' : ''}</button>`,
        )
        .join('')}
    </nav>
    <div class="dbody">${renderDetailTab(plugin, active)}</div>
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
    <div class="hint" style="margin:-6px 0 4px">每条 = 一次「插件 → 内核 API」调用</div>
    ${audit.slice(0, 60).map(renderAuditRow).join('') || '<p class="muted">暂无记录</p>'}
  `
}

/** method 第二段（如 ctx.clipboard.writeText 的 clipboard）的中文注解 */
const DOMAIN_LABEL: Record<string, string> = {
  settings: '管理设置',
  host: '宿主信息',
  hostUi: '宿主界面',
  storage: '插件数据',
  clipboard: '剪贴板',
  shell: '系统打开',
  exec: '执行命令',
  notify: '系统通知',
  screenshot: '屏幕截图',
  quicklink: '快捷链接',
  log: '插件日志',
}

/**
 * `ctx.hostUi.setSearchContent` → 拆成 `ctx.` + 域名 + 其余（分隔符随其余保留）；
 * 非 `ctx.*` 形态返回 null（如 bridge 层失败记录的 `bridge:ctx.host.info`），原样展示。
 */
function splitMethod(method: string): { domain: string; sep: string; rest: string } | null {
  const match = /^ctx\.([A-Za-z][\w-]*)([.:])?([\s\S]*)$/.exec(method)
  if (!match) return null
  return { domain: match[1] ?? '', sep: match[2] ?? '', rest: match[3] ?? '' }
}

/** 审计行：插件（可读名）→ 内核方法（域高亮）+ 所需能力 + 结果 */
function renderAuditRow(record: AuditLike): string {
  const plugin = pluginById(record.pluginId)
  const label = plugin?.title || record.pluginId
  const parts = splitMethod(record.method)
  const domainLabel = parts ? (DOMAIN_LABEL[parts.domain] ?? parts.domain) : ''
  return `
    <div class="row audit">
      <div class="label">
        <div class="audit-head">
          <span class="badge plugin" title="${escapeHtml(record.pluginId)}">${escapeHtml(label)}</span>
          <span class="audit-arrow">→</span>
          ${
            parts
              ? `<code class="audit-method"><span class="am-prefix">ctx.</span><span class="am-domain">${escapeHtml(parts.domain)}</span><span class="am-rest">${escapeHtml(parts.sep + parts.rest)}</span></code>`
              : `<code class="audit-method plain">${escapeHtml(record.method)}</code>`
          }
          ${
            record.capability
              ? `<span class="badge cap" title="调用该 API 需要声明的能力">${escapeHtml(record.capability)}</span>`
              : ''
          }
          ${record.ok ? '<span class="badge ok">ok</span>' : `<span class="badge err">${escapeHtml(record.error?.code ?? 'ERR')}</span>`}
        </div>
        <div class="hint">${new Date(record.ts).toLocaleTimeString()} ｜ ${record.ms}ms${
          domainLabel ? ` ｜ ${escapeHtml(domainLabel)}` : ''
        }${record.error ? ` ｜ ${escapeHtml(record.error.message)}` : ''}</div>
      </div>
    </div>
  `
}

function renderAbout(): string {
  const info = aboutInfo
  const exported = lastExport
    ? `<div class="hint" style="margin-top:8px">上次导出：${escapeHtml(lastExport.summary)}<br><span class="path">${escapeHtml(lastExport.path)}</span></div>`
    : ''
  return `
    <h2>关于</h2>
    <div class="row"><div class="label">版本</div><span class="muted">${escapeHtml(info.version)}</span></div>
    <div class="row"><div class="label">平台</div><span class="muted">${escapeHtml(info.platform)}</span></div>
    <div class="row"><div class="label">内核</div><span class="muted">Rust · v${escapeHtml(info.version)}</span></div>
    <div class="row"><div class="label">数据目录</div><span class="muted">${escapeHtml(info.dataRoot)}</span></div>
    <div class="card">
      <strong>底座原则</strong>
      <div class="hint">底座零能力：内核里不出现任何具体能力，所有能力（含「启动应用」本身）都以插件形式集成。</div>
      <div class="hint">能力即权限：未在清单声明的能力在装配期就不挂载，插件侧表现为「方法不存在」，且有审计记录。</div>
      <div class="hint">许可证：本项目为 MIT；第三方组件与许可证清单见 docs/THIRD-PARTY.md。</div>
    </div>

    <h2 style="margin-top:20px">诊断日志</h2>
    <div class="row">
      <div class="label">
        导出诊断日志
        <div class="hint">
          排查插件或内核问题时使用：导出一份日志文件（插件加载与状态 / 内核运行日志 / 错误 / 审计摘要），
          发送给开发者或 AI 助手即可定位问题；导出后会在访达中显示该文件。
        </div>
      </div>
      <div class="dactions" style="margin-top:0">
        <button class="btn" id="export-logs-session" title="本次内核运行期（内存缓冲，最多 2000 条）">最近一次会话</button>
        <button class="btn primary" id="export-logs-all" title="kernel.log 全量（跨运行）+ 审计文件（滚动 7 天）">全部日志</button>
      </div>
    </div>
    <div class="hint" style="margin-top:6px">文件可能包含本机路径与插件日志，请只发送给可信对象。</div>
    ${exported}
  `
}

let aboutInfo = { version: '', platform: '', node: '', dataRoot: '' }
/** 上次导出的日志（路径 + 摘要）：留在「关于」页，方便用户回头再找到那个文件 */
let lastExport: { path: string; summary: string } | null = null

// ── 诊断日志导出 ───────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} B`
}

/**
 * 导出诊断日志：内核侧汇总（插件状态 + 内核日志 + 审计摘要）→ 写入 `<dataRoot>/logs/exports/`
 * → 在访达 / 资源管理器中显示。两个范围：
 * - `session`：本次内核运行期（内存缓冲）；`all`：跨运行（kernel.log + audit-*.jsonl）。
 */
async function exportLogs(scope: 'session' | 'all'): Promise<void> {
  const buttons = ['export-logs-session', 'export-logs-all']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement)
  for (const button of buttons) button.disabled = true
  toast('正在导出日志…')
  try {
    const result: LogExportResult = await settings.exportLogs(scope)
    lastExport = {
      path: result.path,
      summary: `${result.filename} · ${formatBytes(result.bytes)} · 内核日志 ${result.entries} 条 · 审计 ${result.auditEntries} 条${
        result.truncated ? '（有截断）' : ''
      }`,
    }
    toast(result.revealed ? '已导出，并已在访达中显示' : `已导出：${result.filename}`)
    render()
  } catch (err) {
    toast(err instanceof Error ? err.message : '导出失败')
  } finally {
    // render() 会把面板整个换掉：只在按钮还活着（失败路径）时恢复可用
    for (const button of buttons) if (button.isConnected) button.disabled = false
  }
}

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
  applyAppearance()
  if (result.hotkey && !result.hotkey.ok) toast(`热键注册失败：${result.hotkey.reason ?? '可能被占用'}`)
  else toast(message)
  render()
}

function bind(): void {
  for (const button of tabsEl.querySelectorAll<HTMLElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      activeTab = (button.dataset.tab as TabId) ?? 'general'
      render()
      // 审计只在 boot 时拉过一次，切进来时刷新，别让用户盯着过期记录
      if (activeTab === 'data') void refreshAudit()
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
  // 语言 / 主题 / 结果密度是自绘下拉（selectHtml），值变化走 SELECT_PATCH 表

  // 取色器面板里每挪一下都落盘太吵：拖动只做预览，change（松手 / 关面板）才写配置
  on('accent', 'input', (el) => {
    document.documentElement.style.setProperty('--accent', (el as HTMLInputElement).value)
  })
  on('accent', 'change', (el) => void patch({ accent: (el as HTMLInputElement).value }))

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

  // 诊断日志导出（「关于」页）：会话 / 全部两个范围
  on('export-logs-session', 'click', () => void exportLogs('session'))
  on('export-logs-all', 'click', () => void exportLogs('all'))

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

// ── 插件设置（清单声明 → 通用表单）──────────────────────────────
function settingEditId(pluginId: string, key: string): string {
  return `${pluginId}:${key}`
}

function parseSettingEditId(id: string): { pluginId: string; key: string } {
  const index = id.indexOf(':')
  if (index <= 0) return { pluginId: '', key: '' }
  return { pluginId: id.slice(0, index), key: id.slice(index + 1) }
}

/** 设置项的当前生效值（用户值缺失时回落 default） */
function settingValueOf(pluginId: string, key: string): string | boolean | undefined {
  const setting = pluginById(pluginId)?.settings.find((item) => item.key === key)
  return setting ? (setting.value ?? setting.default) : undefined
}

function applyPluginsSnapshot(result: { plugins?: PluginLike[] }): void {
  if (!Array.isArray(result.plugins)) return
  plugins = result.plugins
  pluginsDigest = digestOf(plugins)
}

/**
 * 只重建右侧详情：设置改完要把生效值与「恢复默认」回填，列表本身没变。
 * 控件会被重建 ⇒ 重渲染前记下焦点，渲染后还回去（键盘操作不该被踢回 body）。
 */
function rerenderPluginDetail(): void {
  const detail = panelEl.querySelector<HTMLElement>('.mdetail')
  if (!detail) return
  const active = document.activeElement as HTMLElement | null
  let restore = ''
  if (active && detail.contains(active)) {
    if (active.dataset.setting) restore = `[data-setting="${active.dataset.setting}"]`
    else if (active.dataset.lselect) restore = `[data-lselect="${active.dataset.lselect}"] .lselect-trigger`
    else if (active.dataset.dtab) restore = `[data-dtab="${active.dataset.dtab}"]`
  }
  detail.innerHTML = renderPluginDetail()
  if (restore) detail.querySelector<HTMLElement>(restore)?.focus()
}

async function savePluginSetting(id: string, value: string | boolean): Promise<void> {
  const { pluginId, key } = parseSettingEditId(id)
  if (!pluginId || !key) return
  // 值没变就别重载插件（下拉点了同一个选项、输入框失焦但没改内容都会走到这里）
  if (settingValueOf(pluginId, key) === value) return
  const result = await guard(
    () => settings.pluginAction('setSetting', { id: pluginId, key, value }) as Promise<{ plugins?: PluginLike[] }>,
    null,
  )
  if (!result) return
  applyPluginsSnapshot(result)
  toast('已保存')
  rerenderPluginDetail()
}

async function resetPluginSetting(id: string): Promise<void> {
  const { pluginId, key } = parseSettingEditId(id)
  if (!pluginId || !key) return
  const result = await guard(
    () => settings.pluginAction('resetSetting', { id: pluginId, key }) as Promise<{ plugins?: PluginLike[] }>,
    null,
  )
  if (!result) return
  applyPluginsSnapshot(result)
  toast('已恢复默认')
  rerenderPluginDetail()
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
  const detail = panelEl.querySelector<HTMLElement>('.mdetail')
  if (detail) {
    detail.innerHTML = renderPluginDetail()
    detail.scrollTop = 0
  }
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

// ── 自绘下拉：开合 / 键盘 / 落值（DOM 由 selectHtml 生成）────────
/** 值变化后的落盘行为（key = data-lselect） */
const SELECT_PATCH: Record<string, (value: string) => void> = {
  language: (value) => void patch({ language: value }),
  theme: (value) => void patch({ theme: value }),
  density: (value) => void patch({ density: value }),
}

/** 当前展开的那个下拉（同一时刻只允许一个） */
let openSelect: HTMLElement | null = null

function closeSelect(focusTrigger = false): void {
  const root = openSelect
  if (!root) return
  openSelect = null
  root.classList.remove('open')
  root.querySelector('.lselect-menu')?.setAttribute('hidden', '')
  root.querySelector('.lselect-trigger')?.setAttribute('aria-expanded', 'false')
  if (focusTrigger) root.querySelector<HTMLElement>('.lselect-trigger')?.focus()
}

function openSelectMenu(root: HTMLElement): void {
  closeSelect()
  const menu = root.querySelector<HTMLElement>('.lselect-menu')
  if (!menu) return
  openSelect = root
  root.classList.add('open')
  root.querySelector('.lselect-trigger')?.setAttribute('aria-expanded', 'true')
  menu.removeAttribute('hidden')
  // 面板是滚动容器：下方放不下就翻到上方，别被裁掉
  const rect = root.getBoundingClientRect()
  const need = menu.offsetHeight + 8
  menu.classList.toggle('up', rect.bottom + need > window.innerHeight && rect.top > need)
  const active =
    menu.querySelector<HTMLElement>('.lselect-option.is-on') ?? menu.querySelector<HTMLElement>('.lselect-option')
  active?.focus()
}

function pickSelectOption(root: HTMLElement, option: HTMLElement): void {
  const label = option.querySelector('span')?.textContent ?? ''
  for (const item of root.querySelectorAll<HTMLElement>('.lselect-option')) {
    const on = item === option
    item.classList.toggle('is-on', on)
    item.setAttribute('aria-selected', String(on))
  }
  const valueEl = root.querySelector('.lselect-value')
  if (valueEl) valueEl.textContent = label
  const id = root.dataset.lselect ?? ''
  const value = option.dataset.value ?? ''
  closeSelect(true)
  applySelectValue(id, value)
}

/** 自绘下拉落值：插件设置走 `setting:` 前缀，其余是全局配置（语言 / 主题 / 密度） */
function applySelectValue(id: string, value: string): void {
  if (id.startsWith('setting:')) {
    void savePluginSetting(id.slice('setting:'.length), value)
    return
  }
  SELECT_PATCH[id]?.(value)
}

/** 菜单内的方向键 / Esc / Tab（Enter 与空格交给按钮自身的点击） */
function onSelectMenuKey(event: KeyboardEvent, menu: HTMLElement): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const items = [...menu.querySelectorAll<HTMLElement>('.lselect-option')]
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length
    items[next]?.focus()
    return
  }
  if (event.key === 'Escape') {
    // 只关菜单：别让宿主把它当成「退出插件页」
    event.preventDefault()
    event.stopPropagation()
    closeSelect(true)
    return
  }
  if (event.key === 'Tab') closeSelect()
}

function onPanelClick(event: Event): void {
  const node = event.target as HTMLElement
  // 自绘下拉的开合与落值（触发器不在列表项里，放最前面最保险）
  const lselectTrigger = node.closest<HTMLElement>('.lselect-trigger')
  if (lselectTrigger) {
    const root = lselectTrigger.closest<HTMLElement>('.lselect')
    if (root) {
      if (openSelect === root) closeSelect()
      else openSelectMenu(root)
    }
    return
  }
  const lselectOption = node.closest<HTMLElement>('.lselect-option')
  if (lselectOption) {
    const root = lselectOption.closest<HTMLElement>('.lselect')
    if (root) pickSelectOption(root, lselectOption)
    return
  }
  // 详情分页：只重建右侧详情，并把滚动位置拉回顶部（否则切到短页会看到一片空白）
  const dtab = node.closest<HTMLElement>('[data-dtab]')
  if (dtab?.dataset.dtab) {
    detailTab = dtab.dataset.dtab as DetailTab
    const detail = panelEl.querySelector<HTMLElement>('.mdetail')
    if (detail) {
      detail.innerHTML = renderPluginDetail()
      detail.scrollTop = 0
    }
    return
  }
  // 插件设置：开关点一下即保存；文本在失焦 / 回车时保存（focusout 分支）
  const settingReset = node.closest<HTMLElement>('[data-setting-reset]')
  if (settingReset?.dataset.settingReset) {
    void resetPluginSetting(settingReset.dataset.settingReset)
    return
  }
  const settingInput = node.closest<HTMLInputElement>('input[data-setting]')
  if (settingInput?.dataset.setting) {
    if (settingInput.type === 'checkbox') void savePluginSetting(settingInput.dataset.setting, settingInput.checked)
    return
  }
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
  // 自绘下拉：菜单内导航 / 触发器上按方向键或回车打开
  const target = event.target as HTMLElement
  const menu = target.closest<HTMLElement>('.lselect-menu')
  if (menu) {
    onSelectMenuKey(event, menu)
    return
  }
  const lselectTrigger = target.closest<HTMLElement>('.lselect-trigger')
  if (
    lselectTrigger &&
    (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ')
  ) {
    event.preventDefault() // 空格别滚页面、回车别触发两次 click
    const root = lselectTrigger.closest<HTMLElement>('.lselect')
    if (root) openSelectMenu(root)
    return
  }

  // 详情分页：← → 在 tab 之间切（Enter / 空格由按钮自身的 click 处理）
  const dtabEl = target.closest<HTMLElement>('[data-dtab]')
  if (dtabEl && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    const tabs = [...panelEl.querySelectorAll<HTMLElement>('[data-dtab]')]
    const index = tabs.findIndex((item) => item === dtabEl)
    if (index >= 0) {
      const delta = event.key === 'ArrowRight' ? 1 : -1
      tabs[(index + delta + tabs.length) % tabs.length]?.click()
    }
    return
  }

  // 列表开关（role=switch）用 Enter / 空格切换 —— 别让它落到外层列表项的默认行为上
  const switchEl = (event.target as HTMLElement).closest<HTMLElement>('[data-toggle]')
  if (switchEl) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    const plugin = pluginById(switchEl.dataset.toggle ?? '')
    if (plugin) void runPluginAction(plugin.state === 'disabled' ? 'enable' : 'disable', plugin.id)
    return
  }

  // 插件设置里的文本项：回车即保存（走失焦分支，与点别处一致）
  const settingInput = target.closest<HTMLInputElement>('input[data-setting]')
  if (settingInput?.dataset.setting && settingInput.type === 'text' && event.key === 'Enter') {
    event.preventDefault()
    settingInput.blur()
    return
  }

  const input = target.closest<HTMLInputElement>('.chip-input')
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
  const target = event.target as HTMLElement
  const settingInput = target.closest<HTMLInputElement>('input[data-setting]')
  if (settingInput?.dataset.setting && settingInput.type === 'text') {
    void savePluginSetting(settingInput.dataset.setting, settingInput.value)
    return
  }
  const input = target.closest<HTMLInputElement>('.chip-input')
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

/** 切到数据页时重新拉审计（用户可能已切走，拉回来就别再渲染了） */
async function refreshAudit(): Promise<void> {
  await loadAudit()
  if (activeTab === 'data') render()
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search)
  urlTheme = params.get('theme')
  document.documentElement.dataset.theme = urlTheme === 'light' ? 'light' : 'dark'
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
  applyAppearance()
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

// 自绘下拉的外围收口：点面板外任意处、任意容器滚动时都关掉菜单
document.addEventListener('click', (event) => {
  if (!openSelect) return
  if (openSelect.contains(event.target as Node)) return
  closeSelect()
})
document.addEventListener('scroll', () => closeSelect(), true)

void boot()
