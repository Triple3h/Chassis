/**
 * 更新页 notes 的解析（`scripts/changelog.mjs` 产出的 Keep a Changelog 片段）。
 *
 * 只认这块数据真正用到的语法：`### 分类`、`- 条目`、行内 `**加粗**` / `` `代码` ``。
 * 其余按普通条目处理 —— notes 来自发布索引（外部数据），不上通用 Markdown 渲染器。
 */

export interface ChangelogSegment {
  text: string
  bold?: boolean
  code?: boolean
}

export interface ChangelogGroup {
  /** 分类标题（已译成中文）；空串 = notes 是一段没有分类的自由文本 */
  title: string
  items: ChangelogSegment[][]
}

const CATEGORY_LABELS: Record<string, string> = {
  added: '新增',
  changed: '变更',
  fixed: '修复',
  removed: '移除',
  deprecated: '弃用',
  security: '安全',
}

const HEADING = /^#{1,6}\s+(.+)$/
const BULLET = /^(?:[-*+]|\d+[.)])\s+(.+)$/
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function parseChangelog(raw: string | null | undefined): ChangelogGroup[] {
  const groups: ChangelogGroup[] = []
  let group: ChangelogGroup | null = null
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const heading = HEADING.exec(text)
    if (heading) {
      group = { title: translateCategory(heading[1]?.trim() ?? ''), items: [] }
      groups.push(group)
      continue
    }
    if (!group) {
      group = { title: '', items: [] }
      groups.push(group)
    }
    const entry = BULLET.exec(text)
    group.items.push(splitInline(entry?.[1] ?? text))
  }
  return groups.filter((item) => item.items.length > 0)
}

function translateCategory(title: string): string {
  return CATEGORY_LABELS[title.toLowerCase()] ?? title
}

function splitInline(text: string): ChangelogSegment[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part) => {
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
        return { text: part.slice(2, -2), bold: true }
      }
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        return { text: part.slice(1, -1), code: true }
      }
      return { text: part }
    })
}

/** 原生 DOM 视图（internal-settings）用：内容全部转义，可直接塞进 innerHTML。 */
export function changelogHtml(raw: string | null | undefined): string {
  return parseChangelog(raw)
    .map((group) => {
      const title = group.title ? `<div class="cl-cat">${escapeHtml(group.title)}</div>` : ''
      const items = group.items
        .map(
          (item) =>
            `<li>${item
              .map((segment) =>
                segment.bold
                  ? `<strong>${escapeHtml(segment.text)}</strong>`
                  : segment.code
                    ? `<code>${escapeHtml(segment.text)}</code>`
                    : escapeHtml(segment.text),
              )
              .join('')}</li>`,
        )
        .join('')
      return `<div class="cl-group">${title}<ul>${items}</ul></div>`
    })
    .join('')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch)
}
