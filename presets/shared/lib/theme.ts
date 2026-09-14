import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { readSession } from './platform'

/**
 * 主题判定优先级：
 *   1. 宿主透传的 ?theme= 参数
 *   2. iframe 文档上的 data-theme（部分版本宿主会注入）
 *   3. 系统 prefers-color-scheme
 * 用户手动切换后写入 localStorage，优先级最高。
 */
const STORAGE_KEY = 'sof:theme'

export type ThemeMode = 'dark' | 'light'

function detect(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* 忽略 */
  }
  const fromHost = readSession().theme
  if (fromHost) return fromHost
  const attr = document.documentElement.dataset.theme
  if (attr === 'dark' || attr === 'light') return attr
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode
}

let singleton: Ref<ThemeMode> | null = null

export function useTheme() {
  const theme = singleton ?? (singleton = ref<ThemeMode>('dark'))

  function set(mode: ThemeMode) {
    theme.value = mode
    applyTheme(mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* 忽略 */
    }
  }

  let mq: MediaQueryList | null = null
  const onMq = (e: MediaQueryListEvent) => {
    if (localStorage.getItem(STORAGE_KEY)) return
    set(e.matches ? 'dark' : 'light')
  }

  onMounted(() => {
    set(detect())
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
