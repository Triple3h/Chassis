/**
 * 内核 ↔ 插件 ↔ 启动台 UI 的共享契约类型。
 * 铁律 P3：这里不出现任何能力特定字段（没有 app.path / url / totp 之类）。
 */

export type ActionDecl =
  | { type: 'command'; command: string; args?: unknown }
  | { type: 'invoke'; pluginId: string; command: string; args?: unknown }
  | { type: 'open'; target: string; targetKind?: 'url' | 'path' | 'app' }
  | { type: 'copy'; text: string }
  | { type: 'host'; method: 'hostUi.setSearchContent' | 'hostUi.hide' }

export interface ResultItem {
  /** 插件内唯一且稳定（历史/固定的错位与否全靠它） */
  id: string
  title: string
  subtitle?: string
  icon?: string
  /** 0..1 插件自评 */
  score?: number
  action: ActionDecl
  actions?: ActionDecl[]
  /** 二级面板（v1 纯文本） */
  detail?: string
}

/** 带出处的结果项（内核合并后交给 UI） */
export interface RankedResult {
  pluginId: string
  pluginTitle: string
  command: string
  item: ResultItem
  itemKey: string
  score: number
  /** 命中高亮用的下标（由内核算好，UI 直接渲染） */
  titleMatch?: MatchSpan | null
  /** 该结果是否被固定 */
  pinned?: boolean
  /** 来自历史 */
  fromHistory?: boolean
  /** 插件已卸载 / 命令不存在 → 置灰 */
  stale?: boolean
}

export interface MatchSpan {
  start: number
  length: number
}

export interface ActionResult {
  ok: boolean
  kind: 'view' | 'script' | 'open' | 'copy' | 'host'
  data?: unknown
  error?: { code: string; message: string }
  /** 执行后是否隐藏启动台；默认：view=隐藏，script=保持可见并展示进度 */
  hideLauncher?: boolean
}

/**
 * 历史/固定项里的 `command` 有两种来源（内核 `pluginKeyOf`）：
 * 真命令名（`ResultItem.action` 是 command），或结果项 id（open/copy… 结果项）。
 * 后者不是命令声明，靠 `action` 快照才能再次执行 —— 所以快照必须持久化。
 */
export interface ItemSnapshot {
  /** 展示快照：插件卸载/改名后仍可显示（置灰 + 提示） */
  title: string
  subtitle?: string
  icon?: string
  args?: unknown
  /** 结果项默认动作快照（非 command 结果项执行时用） */
  action?: ActionDecl
}

/** §7.5：能力无关的历史项 */
export interface HistoryItem extends ItemSnapshot {
  /** 稳定 key = `${pluginId}:${command}:${hash(args)}`（不是下标！） */
  key: string
  pluginId: string
  command: string
  /** epoch ms */
  lastUsed: number
  count: number
}

export interface PinnedItem extends ItemSnapshot {
  key: string
  pluginId: string
  command: string
  order: number
}

export interface AuditRecord {
  ts: number
  pluginId: string
  channel: 'ui' | 'script' | 'kernel'
  /** 如 'clipboard.writeText' */
  method: string
  ok: boolean
  ms: number
  capability: string
  error?: { code: string; message: string }
  /** 截断到 200 字符，敏感字段打码 */
  truncatedArgs?: string
}

/** 一个窗口态记下的几何：位置（屏幕物理坐标）+ 尺寸（逻辑像素）；两半可各自缺省 */
export interface WindowBoundsEntry {
  /** 屏幕物理坐标（多屏时副屏可为负） */
  x?: number
  y?: number
  /** 逻辑像素（= CSS px，与 `window.setBounds` 的口径一致） */
  width?: number
  height?: number
}

/** 宿主配置（内核持久化于 `<dataRoot>/config.json`；UI 只读展示 + patch） */
export interface Config {
  version: number
  hotkey: { accelerator: string }
  autostart: boolean
  hideOnBlur: boolean
  /** 唤出时保留上次输入 */
  keepQuery: boolean
  language: string
  theme: 'system' | 'light' | 'dark'
  accent: string
  density: 'comfortable' | 'compact'
  /** 历史上限 100–2000 */
  historyLimit: number
  historyInSearch: boolean
  /** 插件启用状态（缺省 = 启用） */
  disabled: string[]
  /** 用户拒绝的高风险能力：pluginId → capability[] */
  denied: Record<string, string[]>
  /** 开发模式插件：pluginId → devUrl */
  devPlugins: Record<string, string>
  /**
   * 用户调过的**窗口几何**（位置 + 尺寸），**按窗口态分别记忆**：
   * `host` = 启动台搜索态、`plugin:<插件id>` = 某个插件的页面（设置页也是插件页）、
   * `plugin` = 所有插件页的兜底（≤0.1.5 的旧数据沿用）。
   * 位置是屏幕物理坐标（px，多屏可为负）、尺寸是逻辑像素（= CSS px）；两半可各自缺省
   * （只拖过窗口 ⇒ 只有位置；从没改过 ⇒ 整项没有）。
   * 由启动台 UI 读写（`Kernel.patchConfig` 收口），内核只做清洗 / 钳制。
   */
  windowBounds: Record<string, WindowBoundsEntry>
}

export interface HostInfo {
  version: string
  platform: string
  dataRoot: string
  pluginId: string
  command: string
  sid: string
}

/** 设置项的运行时视图：清单声明 + 生效值（设置页据此渲染表单） */
export interface PluginSettingInfo {
  key: string
  type: 'select' | 'switch' | 'text'
  title: string
  description?: string
  default?: string | boolean
  options?: Array<{ value: string; label: string }>
  /** 当前生效值 = 用户值 ?? default（两者都没有时为 undefined） */
  value?: string | boolean
  /** 用户改过（界面据此显示「恢复默认」） */
  customized: boolean
}

export interface PluginRuntimeInfo {
  id: string
  title: string
  version: string
  description?: string
  author?: string
  icon?: string
  apiVersion: string
  capabilities: string[]
  /** 用户可拒绝高风险能力 */
  deniedCapabilities: string[]
  /** 插件级别名：兜底给该插件全部入口命令（用户覆盖层优先于清单） */
  keywords: string[]
  /** 是否被用户改过（界面据此显示「恢复默认」） */
  keywordsCustomized: boolean
  /** 插件设置（清单声明 + 用户值）；没有声明时为空数组 */
  settings: PluginSettingInfo[]
  commands: Array<{
    name: string
    title: string
    mode: string
    searchable: boolean
    contributes: boolean
    hidden: boolean
    placeholder?: string
    /** 命令**自己**的别名（不含插件级；实际参与搜索 = 插件级 ∪ 命令级） */
    keywords: string[]
    keywordsCustomized: boolean
    error?: string
  }>
  state: 'discovered' | 'validating' | 'loading' | 'active' | 'disabled' | 'error' | 'crashed' | 'degraded'
  error?: string
  builtin: boolean
  /** 底座基础能力：不可禁用（界面不提供开关，内核 setDisabled 直接拒绝） */
  essential: boolean
  dir: string
  /** dev server 地址（开发模式） */
  devUrl?: string
}
