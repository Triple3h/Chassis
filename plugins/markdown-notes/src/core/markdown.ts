/**
 * 轻量 Markdown 渲染器（零依赖，随插件打包）。
 *
 * 安全前提：**先把整段源码转义**，再做结构替换 —— 渲染结果里不可能出现用户写的原始标签，
 * 所以外层可以直接 v-html。链接只放行 http(s)/mailto/锚点/相对路径，`javascript:` 一律丢弃。
 *
 * 覆盖范围：标题 / 段落 / 粗斜体 / 删除线 / 行内码 / 围栏代码块（带语法高亮） / 引用 /
 * 有序无序列表（多层嵌套 + 续行 + 起始序号） / 任务列表 / 表格（列对齐） / 分割线 / 链接（含 `<url>` 自动链接） / 图片。
 * 不支持：公式（KaTeX）、流程图（mermaid）、脚注、内嵌 HTML —— 这些要额外的渲染引擎，插件不背。
 */

import { escapeHtml, highlightCode } from './highlight'

export { escapeHtml }

const CODE_SLOT = '\u0000MDCODE'
const CODE_SLOT_RE = new RegExp(`\u0000MDCODE(\\d+)\u0000`, 'g')

/** 链接/图片来源白名单：只认常见安全形态 */
export function safeUrl(raw: string, isLink = false): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(value)) return value
  if (!isLink && /^data:image\//i.test(value)) return value
  // 其余「看起来有协议」的一律不认（javascript:、data:text/html、file: …）
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  return value
}

/** 行内元素：入参必须是已转义文本 */
export function renderInline(escaped: string): string {
  const codes: string[] = []
  let out = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code)
    return `${CODE_SLOT}${codes.length - 1}\u0000`
  })

  // 自动链接：转义后的 `<https://…>`
  out = out.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (_match, href: string) => {
    const safe = safeUrl(href, true)
    if (!safe) return href
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${href}</a>`
  })

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_match, alt: string, src: string, title?: string) => {
    const safe = safeUrl(src)
    if (!safe) return alt
    return `<img src="${safe}" alt="${alt}"${title ? ` title="${title}"` : ''} />`
  })

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_match, label: string, href: string, title?: string) => {
    const safe = safeUrl(href, true)
    if (!safe) return label
    return `<a href="${safe}"${title ? ` title="${title}"` : ''} target="_blank" rel="noreferrer noopener">${label}</a>`
  })

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return out.replace(CODE_SLOT_RE, (_match, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`)
}

/** 代码块：外壳（语言标签 + 复制按钮）+ 高亮后的代码 */
function renderCodeBlock(code: string, lang: string): string {
  const label = lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : ''
  const head = `<div class="md-code-head">${label}<button class="md-code-copy" type="button" data-copy-code>复制</button></div>`
  return `<div class="md-code">${head}<pre><code>${highlightCode(code, lang)}</code></pre></div>`
}

type Align = 'left' | 'center' | 'right'

interface ListItem {
  ordered: boolean
  start: number
  text: string
  task: boolean | null
  children: ListItem[]
}

interface ListLayer {
  indent: number
  items: ListItem[]
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  const cells = splitRow(trimmed)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function tableAligns(divider: string): Align[] {
  return splitRow(divider).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

function isTableRow(line: string): boolean {
  return line.trimStart().startsWith('|')
}

function cellTag(tag: 'th' | 'td', text: string, align: Align | undefined): string {
  const cls = align === 'center' ? ' class="md-al-center"' : align === 'right' ? ' class="md-al-right"' : ''
  return `<${tag}${cls}>${renderInline(escapeHtml(text))}</${tag}>`
}

function renderNodes(nodes: ListItem[]): string {
  let html = ''
  let index = 0
  while (index < nodes.length) {
    const ordered = nodes[index]?.ordered ?? false
    const group: ListItem[] = []
    while (index < nodes.length && (nodes[index]?.ordered ?? false) === ordered) {
      const node = nodes[index]
      if (node) group.push(node)
      index += 1
    }
    const tag = ordered ? 'ol' : 'ul'
    const first = group[0]
    const start = ordered && first && first.start > 1 ? ` start="${first.start}"` : ''
    html += `<${tag}${start}>${group.map((node) => renderItem(node)).join('')}</${tag}>`
  }
  return html
}

function renderItem(node: ListItem): string {
  const body = renderInline(escapeHtml(node.text)).replace(/\n/g, '<br />')
  const children = node.children.length ? renderNodes(node.children) : ''
  if (node.task === null) return `<li>${body}${children}</li>`
  const checked = node.task ? ' checked' : ''
  return `<li class="md-task"><input type="checkbox" disabled${checked} /><span>${body}${children}</span></li>`
}

/** 解析一段列表（可多层嵌套、可续行），返回 HTML 与消费到的行号 */
function renderList(lines: string[], startIndex: number): { html: string; next: number } {
  const root: ListItem[] = []
  const stack: ListLayer[] = [{ indent: -1, items: root }]
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const match = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line)

    if (match) {
      const indent = (match[1] ?? '').replace(/\t/g, '  ').length
      const marker = match[2] ?? '-'
      const raw = match[4] ?? ''
      const task = /^\[([ xX])\]\s+(.*)$/.exec(raw)
      const ordered = /\d/.test(marker)
      const item: ListItem = {
        ordered,
        start: ordered ? Number.parseInt(marker, 10) : 1,
        text: task ? (task[2] ?? '') : raw,
        task: task ? (task[1] ?? '').toLowerCase() === 'x' : null,
        children: [],
      }

      while (stack.length > 1 && indent < (stack[stack.length - 1] as ListLayer).indent) stack.pop()
      let top = stack[stack.length - 1] as ListLayer
      // 列表的第一项决定本层缩进基准（引用块里的列表可能整体缩进）
      if (stack.length === 1 && top.items.length === 0) top.indent = indent
      if (indent > top.indent && top.items.length) {
        const parent = top.items[top.items.length - 1] as ListItem
        top = { indent, items: parent.children }
        stack.push(top)
      }
      top.items.push(item)
      index += 1
      continue
    }

    // 续行：缩进比当前项更深、且不是新块开头
    const top = stack[stack.length - 1] as ListLayer
    const item = top.items[top.items.length - 1]
    const indent = line.length - line.trimStart().length
    if (item && line.trim() && indent > top.indent && !isBlockStart(line)) {
      item.text += `\n${line.trim()}`
      index += 1
      continue
    }
    break
  }

  return { html: renderNodes(root), next: index }
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*(```|~~~)/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    isTableRow(line)
  )
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    // 围栏代码块（结束围栏必须同字符、不短于开始围栏）
    const fence = /^\s*(`{3,}|~{3,})\s*([^`\s]*)/.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const lang = (fence[2] ?? '').trim()
      const close = new RegExp(`^\\s*\\${marker[0]}{${marker.length},}\\s*$`)
      const code: string[] = []
      index += 1
      while (index < lines.length) {
        const current = lines[index] ?? ''
        index += 1
        if (close.test(current)) break
        code.push(current)
      }
      html.push(renderCodeBlock(code.join('\n'), lang))
      continue
    }

    if (!line.trim()) {
      index += 1
      continue
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      html.push('<hr />')
      index += 1
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 1
      html.push(`<h${level}>${renderInline(escapeHtml((heading[2] ?? '').replace(/\s+#+\s*$/, '')))}</h${level}>`)
      index += 1
      continue
    }

    // 引用（连续行合并成一个块，块内继续按 Markdown 解析）
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`)
      continue
    }

    // 表格
    if (isTableRow(line) && isTableDivider(lines[index + 1] ?? '')) {
      const aligns = tableAligns(lines[index + 1] ?? '')
      const header = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      const head = `<thead><tr>${header.map((cell, i) => cellTag('th', cell, aligns[i])).join('')}</tr></thead>`
      const body = rows.length
        ? `<tbody>${rows
            .map((row) => `<tr>${row.map((cell, i) => cellTag('td', cell, aligns[i])).join('')}</tr>`)
            .join('')}</tbody>`
        : ''
      html.push(`<div class="md-table-wrap"><table>${head}${body}</table></div>`)
      continue
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const list = renderList(lines, index)
      html.push(list.html)
      index = list.next
      continue
    }

    // 段落（连续的非空、非块起始行合并）
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (!current.trim() || isBlockStart(current)) break
      paragraph.push(current)
      index += 1
    }
    html.push(`<p>${paragraph.map((line2) => renderInline(escapeHtml(line2))).join('<br />')}</p>`)
  }

  return html.join('\n')
}

/** 目录提取：预览区不需要，但导出 HTML 时用它给一个简单的锚点导航 */
export function headings(source: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = []
  let inFence = false
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) out.push({ level: match[1]?.length ?? 1, text: (match[2] ?? '').trim() })
  }
  return out
}
