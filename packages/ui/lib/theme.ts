import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { parseAccent, resolveTheme, type ThemeDecision, type ThemeMode, type ThemeSource } from './themePriority'

export type { ThemeMode, ThemeSource } from './themePriority'

/**
 * 插件页主题：判定规则在 `themePriority.ts`（纯函数、有单测），这里只把它接到 DOM 上。
 *
 * **插件页内不提供主题切换，也不落盘任何主题。**
 * 主题由宿主唯一裁决（打开会话时随 URL 下发），本模块只负责把它应用到文档根。
 *
 * 曾经相反：自动判定出来的值也会写进 localStorage，于是「第一次打开这个插件页时恰好是什么主题」
 * 被永久钉死，宿主之后切深色，插件页也不跟（实测：宿主 footer 已深色、totp 页仍是浅色）。
 * 现在改成不写盘，那条路径整个删掉。
 */
function readUrlTheme(): string {
  try {
    return new URLSearchParams(location.search).get('theme') ?? ''
  } catch {
    return ''
  }
}

function readDocumentTheme(): string {
  return document.documentElement.dataset.theme ?? ''
}

function systemTheme(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode
}

/** 用户自定义主题色：宿主随会话下发，合法才覆盖内置值（深浅两态同色，与宿主一致） */
function applyAccent(): void {
  let raw = ''
  try {
    raw = new URLSearchParams(location.search).get('accent') ?? ''
  } catch {
    return
  }
  const accent = parseAccent(raw)
  if (accent) document.documentElement.style.setProperty('--launcher-accent', accent)
}

let singleton: Ref<ThemeMode> | null = null
/** 当前主题的来源：系统主题变化时靠它决定要不要跟随 */
let source: ThemeSource = 'system'

export function useTheme() {
  const theme = singleton ?? (singleton = ref<ThemeMode>('dark'))

  function show(decision: ThemeDecision): void {
    source = decision.source
    theme.value = decision.mode
    applyTheme(decision.mode)
  }

  function detect(): ThemeDecision {
    return resolveTheme({
      fromHost: readUrlTheme(),
      fromDocument: readDocumentTheme(),
      system: systemTheme(),
    })
  }

  let mq: MediaQueryList | null = null
  const onMq = (): void => {
    // 宿主给了主题时不跟系统走：跟了就会和宿主界面不一致
    if (source !== 'system') return
    show({ mode: systemTheme(), source: 'system' })
  }

  onMounted(() => {
    show(detect())
    applyAccent()
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', onMq)
    } catch {
      /* 忽略 */
    }
  })

  onUnmounted(() => {
    try {
      mq?.removeEventListener('change', onMq)
    } catch {
      /* 忽略 */
    }
  })

  return { theme }
}
