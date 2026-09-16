import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { resolveTheme, type ThemeDecision, type ThemeMode, type ThemeSource } from './themePriority'

export type { ThemeMode, ThemeSource } from './themePriority'

/**
 * 插件页主题：判定规则在 `themePriority.ts`（纯函数、有单测），这里只负责把它接到 Vue / DOM / localStorage 上。
 *
 * **只有用户手动切换（`set` / `toggle`）才允许写 localStorage。**
 * 自动判定出来的主题一旦也写进去，就等于把「第一次打开这个插件页时恰好是什么主题」永久钉死：
 * 宿主之后切深色，插件页也不会跟随。实测就是这样 —— 宿主 footer 已经深色、totp 页仍是浅色，
 * 而会话 URL 上的 `theme=dark` 其实传得完全正确。
 */
const STORAGE_KEY = 'launcher:theme'

/** 读「用户手动选过」的主题；读不到（没选过 / 被禁用）一律返回空串 */
function readPinned(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 只在手动切换时调用 */
function writePinned(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* 隐私模式下写不了：不影响本次显示 */
  }
}

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

let singleton: Ref<ThemeMode> | null = null
/** 当前主题的来源：系统主题变化时靠它决定要不要跟随 */
let source: ThemeSource = 'system'

export function useTheme() {
  const theme = singleton ?? (singleton = ref<ThemeMode>('dark'))

  /** 只应用、不记 —— 自动判定走这条 */
  function show(decision: ThemeDecision): void {
    source = decision.source
    theme.value = decision.mode
    applyTheme(decision.mode)
  }

  function detect(): ThemeDecision {
    return resolveTheme({
      pinned: readPinned(),
      fromHost: readUrlTheme(),
      fromDocument: readDocumentTheme(),
      system: systemTheme(),
    })
  }

  /** 用户明确选定的主题 —— 全模块唯一会写 localStorage 的路径 */
  function set(mode: ThemeMode): void {
    show({ mode, source: 'pinned' })
    writePinned(mode)
  }

  let mq: MediaQueryList | null = null
  const onMq = (): void => {
    // 宿主给了主题、或用户手动钉过主题时不跟系统走：跟了就会和宿主界面不一致
    if (source !== 'system') return
    show({ mode: systemTheme(), source: 'system' })
  }

  onMounted(() => {
    show(detect())
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

  return {
    theme,
    set,
    toggle: () => set(theme.value === 'dark' ? 'light' : 'dark'),
  }
}
