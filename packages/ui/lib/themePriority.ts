/**
 * 插件页主题的**判定与输入校验**（plugin-spec §5.3）。
 *
 * 单独成一个文件、不碰 DOM 也不碰 Vue：规则本身是纯的，纯的才钉得住 ——
 * 这条规则出错的样子特别隐蔽（插件页永远不跟宿主换主题），页面上看不出是"判定错了"
 * 还是"本来就该这样"，只有把优先级写成可单测的函数才抓得住。
 */

export type ThemeMode = 'dark' | 'light'

/**
 * 主题是从哪来的。它决定一件事：系统主题变化时要不要跟随（只有 `system` 才跟）。
 *
 * **没有 `pinned`**：插件页内不提供主题切换，主题由宿主唯一裁决。
 * 页内一旦能钉住主题，宿主换了它也不跟，而"哪个插件忘了跟"在界面上根本看不出来。
 */
export type ThemeSource = 'host' | 'document' | 'system'

export interface ThemeInputs {
  /** 宿主在会话 URL 上透传的 `?theme=`，每次开会话都会重新带上 */
  fromHost: string
  /** 文档根上的 `data-theme` */
  fromDocument: string
  /** 系统当前偏好 */
  system: ThemeMode
}

export interface ThemeDecision {
  mode: ThemeMode
  source: ThemeSource
}

function asMode(value: string): ThemeMode | '' {
  return value === 'dark' || value === 'light' ? value : ''
}

/**
 * 优先级：**宿主透传 > 文档属性 > 系统偏好**。
 *
 * 宿主压在「文档属性 / 系统偏好」之上是关键：宿主每次开会话都会带上它当前的主题，
 * 插件页必须跟随，否则宿主切了深色而插件页还停在浅色。
 */
export function resolveTheme(inputs: ThemeInputs): ThemeDecision {
  const host = asMode(inputs.fromHost)
  if (host) return { mode: host, source: 'host' }

  const fromDocument = asMode(inputs.fromDocument)
  if (fromDocument) return { mode: fromDocument, source: 'document' }

  return { mode: inputs.system, source: 'system' }
}

/**
 * 会话 URL 上透传的主题色。非法值一律当没给 ——
 * 它会被写进 CSS 变量，放宽校验等于给任意 CSS 值开一道口子。
 */
export function parseAccent(raw: string): string {
  const value = raw.trim()
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : ''
}
