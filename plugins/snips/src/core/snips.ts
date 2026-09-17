import type { Snip, SnipKind } from './types'

export const KIND_LABEL: Record<SnipKind, string> = { text: '文本', code: '代码', image: '图片' }
export const KIND_ICON: Record<SnipKind, string> = { text: 'file', code: 'braces', image: 'image' }

/** 代码语言标签的常用预设（允许自由输入，这里只是快捷项） */
export const LANG_PRESETS = [
  'bash',
  'json',
  'javascript',
  'typescript',
  'python',
  'sql',
  'go',
  'rust',
  'html',
  'css',
  'yaml',
  'text',
]

export function makeId(seed = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `s${seed.toString(36)}${rand}`
}

/**
 * 代码特征判定：命中两条以上才算代码。
 * 只用来给「新建」预选类型，用户随时可以改，所以宁可保守（少判成代码）。
 */
export function looksLikeCode(content: string): boolean {
  const text = content.trim()
  if (!text || text.length < 12) return false
  if (text.startsWith('data:')) return false
  let hits = 0
  if (/[{};]\s*$/m.test(text) || /^\s*[})]/m.test(text)) hits += 1
  if (/^\s{2,}\S/m.test(text)) hits += 1
  if (/\b(const|let|var|function|return|class|import|export|def|SELECT|FROM|INSERT|UPDATE)\b/.test(text)) hits += 1
  if (/(=>|::|;\s*$|\$\{|\)\s*\{)/m.test(text)) hits += 1
  if (/<\/?[a-z][\w-]*>/i.test(text)) hits += 1
  if (/^#!|\/\/|\/\*|^\s*#\s/m.test(text)) hits += 1
  const lines = text.split('\n')
  if (lines.length >= 3) {
    const dense = lines.filter((line) => /[=();{}[\]]/.test(line)).length
    if (dense >= lines.length * 0.6) hits += 1
  }
  return hits >= 2
}

/** 粗糙的语言猜测：只在用户没手动选语言时用 */
export function guessLang(content: string): string | undefined {
  const text = content.trim()
  if (/^[[{]/.test(text) && /[:]/.test(text)) return 'json'
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) return 'sql'
  if (/^\s*(def|import|from|class)\s/m.test(text) || /^\s*print\(/m.test(text)) return 'python'
  if (/^\s*(fn|use|let mut|impl)\b/m.test(text)) return 'rust'
  if (/^\s*package \w+/m.test(text) && /\bfunc\b/.test(text)) return 'go'
  if (/<\/?[a-z][\w-]*>/i.test(text)) return 'html'
  if (/^\s*(#!\/|sudo |brew |npm |pnpm |cd |git )/m.test(text)) return 'bash'
  if (/^\s*[.#]?[a-z-]+\s*\{[^}]*:[^}]*;/m.test(text)) return 'css'
  if (/\b(interface|type)\s+\w+|:\s*(string|number|boolean)\b/.test(text)) return 'typescript'
  if (/\b(const|let|function|=>)\b/.test(text)) return 'javascript'
  return undefined
}

/** 列表行摘要：取第一行非空内容，压平空白后截断 */
export function summarize(content: string, max = 90): string {
  const first = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return ''
  const flat = first.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 标题兜底：用户没填就从句首摘一段 */
export function defaultTitle(content: string, kind: SnipKind): string {
  if (kind === 'image') return '图片快贴'
  const summary = summarize(content, 32)
  return summary || '未命名快贴'
}

export interface SnipInput {
  kind: SnipKind
  title: string
  content: string
  lang?: string
}

export function createSnip(input: SnipInput, now = Date.now()): Snip {
  const title = input.title.trim() || defaultTitle(input.content, input.kind)
  return {
    id: makeId(now),
    kind: input.kind,
    title,
    content: input.content,
    ...(input.kind === 'code' && input.lang ? { lang: input.lang } : {}),
    createdAt: now,
    updatedAt: now,
    usedAt: 0,
    uses: 0,
    pinned: false,
  }
}

export function applyEdit(snip: Snip, input: SnipInput, now = Date.now()): Snip {
  const title = input.title.trim() || defaultTitle(input.content, input.kind)
  const next: Snip = {
    ...snip,
    kind: input.kind,
    title,
    content: input.content,
    updatedAt: now,
  }
  if (input.kind === 'code' && input.lang) next.lang = input.lang
  else delete next.lang
  return next
}

/** 置顶优先，其次按最近改动 */
export function sortSnips(list: Snip[]): Snip[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

export function filterSnips(list: Snip[], query: string, kind: SnipKind | 'all'): Snip[] {
  const needle = query.trim().toLowerCase()
  return sortSnips(
    list.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false
      if (!needle) return true
      if (item.title.toLowerCase().includes(needle)) return true
      if (item.kind === 'image') return false
      return item.content.toLowerCase().includes(needle)
    }),
  )
}

export function touch(snip: Snip, now = Date.now()): Snip {
  return { ...snip, uses: snip.uses + 1, usedAt: now }
}

/** 相对时间：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / MM-DD / YYYY-MM-DD */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) return '从未使用'
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(ts)
  const today = new Date(now)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === today.toDateString()) return `今天 ${hhmm}`
  const yesterday = new Date(now - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (date.getFullYear() === today.getFullYear()) return `${month}-${day} ${hhmm}`
  return `${date.getFullYear()}-${month}-${day}`
}

/** 落盘前转普通对象（storage 走 JSON，Vue 的 Proxy 会被结构化克隆拒绝） */
export function plainSnips(list: Snip[]): Snip[] {
  return list.map((item) => ({ ...item }))
}
