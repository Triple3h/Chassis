import { escapeHtml, renderMarkdown } from './markdown'

export interface Note {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
  pinned: boolean
}

export function makeId(seed = Date.now()): string {
  return `n${seed.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 标题：优先第一个 `#` 标题，其次第一行有内容的文本 */
export function noteTitle(content: string, fallback = '未命名笔记'): string {
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const text = (heading ? (heading[1] ?? '') : line).replace(/[*_`~]/g, '').trim()
    if (text) return text.length > 40 ? `${text.slice(0, 39)}…` : text
  }
  return fallback
}

export function noteSummary(content: string, max = 64): string {
  const lines = content
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter((line) => line.length > 0)
  const text = lines.slice(0, 2).join(' · ').replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function createNote(now = Date.now(), content = ''): Note {
  return {
    id: makeId(now),
    title: noteTitle(content, '未命名笔记'),
    content,
    createdAt: now,
    updatedAt: now,
    pinned: false,
  }
}

export function applyContent(note: Note, content: string, now = Date.now()): Note {
  return { ...note, content, title: noteTitle(content, note.title), updatedAt: now }
}

export function renameNote(note: Note, title: string, now = Date.now()): Note {
  return { ...note, title: title.trim() || note.title, updatedAt: now }
}

export function sortNotes(list: Note[]): Note[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

export function filterNotes(list: Note[], query: string): Note[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return sortNotes(list)
  return sortNotes(
    list.filter((note) => note.title.toLowerCase().includes(needle) || note.content.toLowerCase().includes(needle)),
  )
}

/** 字数统计：中日韩按字计、西文按词计（写作时看的那个数） */
export function countChars(content: string): { chars: number; words: number; lines: number } {
  const chars = content.replace(/\s/g, '').length
  const cjk = content.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)?.length ?? 0
  const latin = content.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g)?.length ?? 0
  return { chars, words: cjk + latin, lines: content ? content.split('\n').length : 0 }
}

export function relativeTime(ts: number, now = Date.now()): string {
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

/** 文件名（导出用）：洗掉路径分隔符等非法字符 */
export function noteFileName(note: Note, ext: string): string {
  const safe = note.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名笔记'
  return `${safe}.${ext}`
}

/** 导出为独立 HTML（图片/样式都内联，双击就能看） */
export function exportHtml(note: Note): string {
  const body = renderMarkdown(note.content)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(note.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.75;
    font: 15px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif; }
  h1,h2,h3,h4 { line-height: 1.35; margin: 1.4em 0 .6em; }
  h1 { font-size: 1.7em; border-bottom: 1px solid rgba(128,128,128,.3); padding-bottom: .2em; }
  h2 { font-size: 1.35em; }
  code { font-family: ui-monospace, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em;
    background: rgba(128,128,128,.16); border-radius: 4px; padding: 1px 4px; }
  pre { background: rgba(128,128,128,.12); border-radius: 8px; padding: 12px; overflow: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { margin: 1em 0; padding-left: 12px; border-left: 3px solid rgba(128,128,128,.45); color: #6b7280; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(128,128,128,.35); padding: 6px 10px; }
  img { max-width: 100%; }
  li.md-task { list-style: none; margin-left: -20px; }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

export function plainNotes(list: Note[]): Note[] {
  return list.map((note) => ({ ...note }))
}
