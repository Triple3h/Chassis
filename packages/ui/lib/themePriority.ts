/**
 * 插件页主题的**判定规则**（plugin-spec §5.3）。
 *
 * 单独成一个文件、不碰 DOM 也不碰 Vue：规则本身是纯的，纯的才钉得住 ——
 * 这条规则出错的样子特别隐蔽（插件页永远不跟宿主换主题），页面上看不出是"判定错了"
 * 还是"本来就该这样"，只有把优先级写成可单测的函数才抓得住。
 */

export type ThemeMode = 'dark' | 'light'

/**
 * 主题是从哪来的。它同时决定两件事：
 * - 谁能覆盖谁（见 `resolveTheme`）
 * - 系统主题变化时要不要跟随（只有 `system` 才跟）
 */
export type ThemeSource = 'pinned' | 'host' | 'document' | 'system'

export interface ThemeInputs {
  /** localStorage 里记住的「用户手动选过」的主题；`''` = 没选过 */
  pinned: string
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
 * 优先级：**手动选择 > 宿主透传 > 文档属性 > 系统偏好**。
 *
 * 宿主压在「文档属性 / 系统偏好」之上是关键：宿主每次开会话都会带上它当前的主题，
 * 插件页必须跟随，否则宿主切了深色而插件页还停在浅色。
 *
 * 手动选择压在宿主之上同样刻意：用户在插件页里按过主题按钮，就该一直是那个主题。
 * 前提是**只有手动选过才会有 `pinned`** —— 自动判定出来的值若能落盘，
 * 就等于把「第一次打开这个插件页时恰好是什么主题」永久钉死
 * （由 `tests/unit/theme-priority.test.ts` 钉住）。
 */
export function resolveTheme(inputs: ThemeInputs): ThemeDecision {
  const pinned = asMode(inputs.pinned)
  if (pinned) return { mode: pinned, source: 'pinned' }

  const host = asMode(inputs.fromHost)
  if (host) return { mode: host, source: 'host' }

  const fromDocument = asMode(inputs.fromDocument)
  if (fromDocument) return { mode: fromDocument, source: 'document' }

  return { mode: inputs.system, source: 'system' }
}
