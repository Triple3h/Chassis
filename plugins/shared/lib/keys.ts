/** 快捷键工具：跨平台修饰键判断与展示 */

export const isMac = (() => {
  try {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
  } catch {
    return false
  }
})()

/** 是否按下了平台主修饰键（macOS: Cmd，其他: Ctrl） */
export function isMod(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/** 展示用修饰键名，如 ⌘ / Ctrl */
export const modLabel = isMac ? '⌘' : 'Ctrl'

/** 判断键盘事件是否命中 "Mod+X" 形式的组合键 */
export function matchKey(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  if (key.toLowerCase() !== e.key.toLowerCase()) return false
  const needMod = parts.some((p) => /^(mod|cmd|ctrl)$/i.test(p))
  const needShift = parts.some((p) => /^shift$/i.test(p))
  const needAlt = parts.some((p) => /^(alt|option)$/i.test(p))
  if (needMod !== isMod(e)) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false
  return true
}

/** 输入型元素判定：焦点在输入框时不应触发全局单键快捷键 */
export function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable
}
