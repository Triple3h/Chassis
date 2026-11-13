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

/* ── 强调色 ─────────────────────────────────────────────────────
   主题色由用户定，插件页从 URL 拿到什么就吃什么（深浅两态同色，与宿主一致）。
   于是「当文字用的强调色」不能直接用：浅色底上一支明黄只有 1.4:1。
   这里按当前底色算一个够 4.5:1 的深/浅版本写进 `--launcher-accent-ink`，
   色块（按钮底、选中底）仍用原色。 */

/** 与 theme.css 的 --launcher-bg 同值；底色改了这里也要改 */
const BG: Record<ThemeMode, string> = { light: '#fafafa', dark: '#141415' }

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hex(channels: [number, number, number]): string {
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/** WCAG 相对亮度 */
function luminance(channels: [number, number, number]): number {
  const [r, g, b] = channels.map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const ca = rgb(a)
  const cb = rgb(b)
  if (!ca || !cb) return 21
  const la = luminance(ca)
  const lb = luminance(cb)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * 把颜色朝黑（浅色主题）或白（深色主题）推，直到对底色达到 `target`。
 * 二分 8 次，够精确且不会在极端色上死循环。
 */
function inkFor(accent: string, mode: ThemeMode, target = 4.5): string {
  const base = rgb(accent)
  if (!base || contrast(accent, BG[mode]) >= target) return accent
  const to = mode === 'light' ? 0 : 255
  let low = 0
  let high = 1
  for (let i = 0; i < 8; i += 1) {
    const t = (low + high) / 2
    const mixed = hex(base.map((c) => c + (to - c) * t) as [number, number, number])
    if (contrast(mixed, BG[mode]) >= target) high = t
    else low = t
  }
  return hex(base.map((c) => c + (to - c) * high) as [number, number, number])
}

let accent = ''
/** 用户自定义主题色：宿主随会话下发，合法才覆盖内置值 */
function readAccent(): string {
  try {
    return parseAccent(new URLSearchParams(location.search).get('accent') ?? '')
  } catch {
    return ''
  }
}

/** 深/浅切换后要把 ink 重算一遍 —— 同一支色在两种底色上需要的深度不同 */
function applyAccent(mode: ThemeMode): void {
  if (!accent) accent = readAccent()
  if (!accent) return
  const root = document.documentElement.style
  root.setProperty('--launcher-accent', accent)
  root.setProperty('--launcher-accent-ink', inkFor(accent, mode))
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
    applyAccent(decision.mode)
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
