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

/** 导出为独立 HTML（样式/高亮配色都内联，双击就能看；预览里的复制按钮在静态页里没有意义，隐藏） */
export function exportHtml(note: Note): string {
  const body = renderMarkdown(note.content)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(note.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --line: rgba(128, 128, 128, 0.32);
    --code-bg: #f5f6f8;
    --code-head: rgba(0, 0, 0, 0.025);
    --row-alt: rgba(0, 0, 0, 0.022);
    --quote-bg: rgba(0, 0, 0, 0.028);
    --quote-bar: rgba(0, 0, 0, 0.2);
    --hl-key: #0550ae; --hl-kw: #cf222e; --hl-str: #0a3069; --hl-num: #953800;
    --hl-fn: #8250df; --hl-com: #6e7781; --hl-pun: #24292f; --hl-tag: #116329; --hl-meta: #8250df;
    --hl-add: #1a7f37; --hl-add-bg: rgba(26, 127, 55, 0.12);
    --hl-del: #cf222e; --hl-del-bg: rgba(207, 34, 46, 0.1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --code-bg: #1e1e21;
      --code-head: rgba(255, 255, 255, 0.025);
      --row-alt: rgba(255, 255, 255, 0.025);
      --quote-bg: rgba(255, 255, 255, 0.03);
      --quote-bar: rgba(255, 255, 255, 0.22);
      --hl-key: #79c0ff; --hl-kw: #ff7b72; --hl-str: #a5d6ff; --hl-num: #ffa657;
      --hl-fn: #d2a8ff; --hl-com: #8b949e; --hl-pun: #c9d1d9; --hl-tag: #7ee787;
      --hl-add: #7ee787; --hl-add-bg: rgba(126, 231, 135, 0.14);
      --hl-del: #ffa198; --hl-del-bg: rgba(255, 129, 130, 0.14);
    }
  }
  body { max-width: 780px; margin: 40px auto; padding: 0 22px 60px;
    font: 15px/1.72 -apple-system, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 .75em; }
  h1 { font-size: 1.6em; padding-bottom: .3em; border-bottom: 1px solid var(--line); }
  h2 { font-size: 1.33em; padding-bottom: .28em; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.16em; }
  p { margin: .8em 0; }
  ul, ol { margin: .7em 0; padding-left: 1.5em; }
  li { margin: .3em 0; }
  code { font-family: ui-monospace, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em;
    background: rgba(128, 128, 128, .16); border-radius: 5px; padding: .08em .34em; }
  .md-code { margin: .9em 0; border: 1px solid var(--line); border-radius: 10px; background: var(--code-bg); overflow: hidden; }
  .md-code-head { display: flex; align-items: center; min-height: 26px; padding: 0 10px;
    border-bottom: 1px solid var(--line); background: var(--code-head); }
  .md-code-lang { font-family: ui-monospace, Menlo, monospace; font-size: 11px; opacity: .65; }
  .md-code-copy { display: none; }
  .md-code pre { margin: 0; padding: 10px 12px; overflow: auto; }
  .md-code code { display: block; background: none; padding: 0; font-size: 12.5px; line-height: 1.65; white-space: pre; }
  .md-hl-key { color: var(--hl-key) } .md-hl-kw { color: var(--hl-kw) } .md-hl-str { color: var(--hl-str) }
  .md-hl-num { color: var(--hl-num) } .md-hl-fn { color: var(--hl-fn) } .md-hl-com { color: var(--hl-com); font-style: italic }
  .md-hl-pun { color: var(--hl-pun) } .md-hl-tag { color: var(--hl-tag) } .md-hl-meta { color: var(--hl-meta) }
  .md-hl-add { color: var(--hl-add); background: var(--hl-add-bg) }
  .md-hl-del { color: var(--hl-del); background: var(--hl-del-bg) }
  blockquote { margin: .9em 0; padding: .55em .95em; border-left: 3px solid var(--quote-bar);
    border-radius: 0 8px 8px 0; background: var(--quote-bg); opacity: .88; }
  blockquote > :first-child { margin-top: 0 } blockquote > :last-child { margin-bottom: 0 }
  .md-table-wrap { margin: .9em 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: .95em; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--line); }
  th { background: rgba(128, 128, 128, .12); font-weight: 600; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0 }
  tbody tr:nth-child(2n) { background: var(--row-alt) }
  .md-al-center { text-align: center } .md-al-right { text-align: right }
  a { color: #2563eb }
  img { max-width: 100%; border-radius: 8px; }
  hr { height: 2px; border: 0; border-radius: 2px; background: var(--line); margin: 1.5em 0 }
  li.md-task { list-style: none; margin-left: -1.35em; display: flex; gap: .5em }
  li.md-task > span { flex: 1 }
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
