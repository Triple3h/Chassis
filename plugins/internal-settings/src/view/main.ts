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

interface PluginLike {
  id: string
  title: string
  version: string
  description?: string
  author?: string
  state: string
  error?: string
  builtin: boolean
  dir: string
  capabilities: string[]
  deniedCapabilities: string[]
  apiVersion: string
  commands: Array<{ name: string; title: string; mode: string; error?: string }>
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

function renderPlugins(): string {
  if (plugins.length === 0) return '<h2>插件</h2><p class="muted">没有已安装的插件</p>'
  const cards = plugins
    .map((plugin) => {
      const denied = plugin.deniedCapabilities.length
        ? `<div class="hint">已拒绝能力：${escapeHtml(plugin.deniedCapabilities.join('、'))}</div>`
        : ''
      const error = plugin.error ? `<div class="hint" style="color:#ef4444">${escapeHtml(plugin.error)}</div>` : ''
      const commandErrors = plugin.commands.filter((c) => c.error).length
      const capabilityList = plugin.capabilities.length
        ? plugin.capabilities.map((cap) => `<span class="badge">${escapeHtml(cap)}</span>`).join(' ')
        : '<span class="badge">无</span>'
      const actions = [
        plugin.state === 'disabled'
          ? `<button class="btn" data-action="enable" data-id="${escapeHtml(plugin.id)}">启用</button>`
          : `<button class="btn" data-action="disable" data-id="${escapeHtml(plugin.id)}">禁用</button>`,
        `<button class="btn" data-action="reload" data-id="${escapeHtml(plugin.id)}">重载</button>`,
        `<button class="btn" data-action="reveal" data-id="${escapeHtml(plugin.id)}">目录</button>`,
        `<button class="btn" data-action="openData" data-id="${escapeHtml(plugin.id)}">数据</button>`,
        plugin.builtin ? '' : `<button class="btn danger" data-action="uninstall" data-id="${escapeHtml(plugin.id)}">卸载</button>`,
      ].join(' ')
      return `
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px">
            <strong>${escapeHtml(plugin.title)}</strong>
            <span class="muted">${escapeHtml(plugin.version)}</span>
            ${stateBadge(plugin)}
            ${plugin.builtin ? '<span class="badge">出厂自带</span>' : ''}
          </div>
          ${plugin.description ? `<div class="hint">${escapeHtml(plugin.description)}</div>` : ''}
          ${denied}${error}
          <div style="margin-top:6px">${capabilityList}</div>
          <div class="hint">apiVersion ${escapeHtml(plugin.apiVersion)} ｜ ${plugin.commands.length} 条命令${
            commandErrors > 0 ? `（${commandErrors} 条不可用）` : ''
          }</div>
          <pre>${escapeHtml(plugin.dir)}</pre>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${actions}</div>
        </div>
      `
    })
    .join('')

  return `
    <h2>插件（${plugins.length}）</h2>
    <div class="row">
      <div class="label">从 zip / 目录安装：把 zip 拖到启动台窗口，或在此填写绝对路径</div>
    </div>
    <div class="row">
      <input id="installPath" type="text" placeholder="/Users/me/Downloads/my-plugin.zip" style="flex:1" />
      <button class="btn primary" id="install">安装</button>
      <button class="btn" id="reloadAll">全部重载</button>
    </div>
    ${cards}
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

  on('install', 'click', async () => {
    const value = (document.getElementById('installPath') as HTMLInputElement | null)?.value?.trim()
    if (!value) return
    const action = value.toLowerCase().endsWith('.zip') ? 'installZip' : 'installDir'
    await guard(() => settings.pluginAction(action, { path: value, overwrite: false }), undefined)
    toast('安装完成')
    await loadPlugins()
    render()
  })
  on('reloadAll', 'click', async () => {
    await guard(() => settings.pluginAction('reloadAll'), undefined)
    toast('已重载全部插件')
    await loadPlugins()
    render()
  })

  for (const button of panelEl.querySelectorAll<HTMLElement>('[data-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action ?? ''
      const id = button.dataset.id ?? ''
      if (action === 'uninstall' && !window.confirm(`确定卸载插件「${id}」？其数据目录会保留。`)) return
      await guard(() => settings.pluginAction(action, { id }), undefined)
      toast('已执行')
      await loadPlugins()
      render()
    })
  }
}

async function loadPlugins(): Promise<void> {
  plugins = (await guard(() => settings.plugins(), [] as PluginLike[])) as PluginLike[]
}

async function loadAudit(): Promise<void> {
  audit = (await guard(() => settings.audit(120), [] as AuditLike[])) as AuditLike[]
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

  // 插件状态变化时保持列表新鲜
  window.setInterval(() => {
    if (activeTab !== 'plugins') return
    void loadPlugins().then(render)
  }, 4000)
}

void boot()
