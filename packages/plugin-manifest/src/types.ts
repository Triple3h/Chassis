/** 清单类型（plugin-spec §3）。 */

export type CommandMode = 'view' | 'no-view' | 'script'

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
  /** 不出现在搜索结果（仍可被 invoke） */
  hidden?: boolean
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
export const API_VERSIONS_SUPPORTED: readonly string[] = ['1']

/** 脚本/无视图命令的产物查找顺序（宿主的唯一入口规则） */
export function scriptEntryCandidates(name: string): string[] {
  return [`${name}.mjs`, `${name}.js`, `workers/${name}.mjs`, `workers/${name}.js`]
}
