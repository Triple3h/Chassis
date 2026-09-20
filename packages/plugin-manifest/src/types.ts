/** 清单类型（plugin-spec §3）。 */

export type CommandMode = 'view' | 'no-view' | 'script'

/** 操作系统标识（plugin-spec §3.5）：与 Rust `std::env::consts::OS` 同口径 */
export type Platform = 'macos' | 'windows' | 'linux'

/** CPU 架构标识：`std::env::consts::ARCH` 归一（`x86_64` → `x64`、`aarch64` → `arm64`） */
export type Arch = 'x64' | 'arm64'

export const PLATFORMS: Platform[] = ['macos', 'windows', 'linux']
export const ARCHS: Arch[] = ['x64', 'arm64']

export interface CommandDecl {
  /** 插件内唯一；脚本命令必须等于产物文件名（N1） */
  name: string
  title: string
  subtitle?: string
  /** lucide 图标名 / 插件内相对路径 / data:image/... */
  icon?: string
  mode: CommandMode
  /** 入口型搜索：命令本身参与搜索结果 */
  searchable?: boolean
  placeholder?: string
  keywords?: string[]
  /** 贡献型搜索：搜索过程中由插件返回结果项 */
  contributes?: boolean
  /** 覆盖插件级声明（并入，取并集） */
  capabilities?: string[]
  /** 不出现在搜索结果与首页「已安装插件」清单（仍可被 invoke） */
  hidden?: boolean
}

export interface SettingOption {
  value: string
  label: string
}

/**
 * 插件设置声明（设置页渲染成通用表单）。
 *
 * 声明只描述「有哪些设置、长什么样」；**用户改过的值不写清单** —— 存
 * `<dataRoot>/plugin-settings.json`（与别名覆盖层同款，重装 / 更新插件都不丢），
 * 未改过的用 `default`。插件侧在 script / no-view 里用 `ctx().settings` 读生效值。
 */
export interface SettingDecl {
  /** 插件内唯一，`^[a-z][a-z0-9-]{0,31}$` */
  key: string
  type: 'select' | 'switch' | 'text'
  title: string
  description?: string
  /** 缺省值：select / text 用字符串，switch 用布尔 */
  default?: string | boolean
  /** type=select 必须提供（2–32 项） */
  options?: SettingOption[]
}

export interface PluginManifest {
  /** 插件 id，同时是数据目录名 */
  name: string
  title: string
  version: string
  apiVersion: string
  capabilities: string[]
  commands: CommandDecl[]
  type: 'module'
  description?: string
  author?: string
  icon?: string
  keywords?: string[]
  categories?: string[]
  /**
   * 底座基础能力：**不可禁用**（用户界面不提供开关，内核 setDisabled 直接拒绝）。
   *
   * 判定标准：禁用它会让启动台基本功能残废（搜应用/搜文件），或让用户失去自救入口
   * （设置与插件管理被禁用后，界面上再没有地方能把它改回来）。
   * **只有出厂 bundle（`builtin`）里的声明生效**：第三方插件声明了也一律按 false 处理。
   */
  essential?: boolean
  /**
   * 是否计入「最近使用」（缺省 `true`）。
   *
   * 声明 `false` 的插件：执行产生的条目**不写历史**，启动时还会把已有条目从历史里摘掉。
   * 用于底座自身的入口（设置 / 插件管理 / 应用启动 / 文件搜索）—— 它们一用就占满「最近使用」，
   * 而入口本身随时搜得到（`searchable`），不需要靠"最近"复现。
   *
   * 只影响最近使用：搜索结果与**固定项**不受影响（固定是用户的显式动作，不能被插件声明抹掉）。
   * 与 `essential` 不同，第三方插件也能声明 —— 它只影响自己的条目，不是权限提升。
   */
  history?: boolean
  /** 插件设置（≤16 条）：设置页的「插件 → 插件设置」按声明渲染，用户改完重载插件生效 */
  settings?: SettingDecl[]
  /**
   * 支持的操作系统白名单（plugin-spec §3.5）；**省略 = 不限制**。
   * 取值与 Rust `std::env::consts::OS` 同口径（照 `#[cfg(target_os)]` 的心智写即可），
   * **不是** `host.info().platform`（那是 Node 口径 `darwin` / `win32`）。
   */
  platforms?: Platform[]
  /** 支持的 CPU 架构白名单；**省略 = 不限制**。取值 `x64` / `arm64`。 */
  arch?: Arch[]
}

/** 全局命令 id：`${pluginId}:${name}` */
export function globalCommandId(pluginId: string, name: string): string {
  return `${pluginId}:${name}`
}

export function splitGlobalCommandId(id: string): { pluginId: string; name: string } | null {
  const idx = id.indexOf(':')
  if (idx <= 0 || idx === id.length - 1) return null
  return { pluginId: id.slice(0, idx), name: id.slice(idx + 1) }
}

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/
export const API_VERSIONS_SUPPORTED: readonly string[] = ['1', '2']

/** 逻辑层命令的产物查找顺序（宿主的唯一入口规则；apiVersion 2 = 可执行产物，与 Rust 侧 `script_entry_candidates` 保持一致） */
export function scriptEntryCandidates(name: string): string[] {
  return [name, `${name}.exe`, `workers/${name}`, `workers/${name}.exe`]
}
