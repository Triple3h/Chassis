/**
 * 轻量 Markdown 渲染器（零依赖，随插件打包）。
 *
 * 安全前提：**先把整段源码转义**，再做结构替换 —— 渲染结果里不可能出现用户写的原始标签，
 * 所以外层可以直接 v-html。链接只放行 http(s)/mailto/锚点/相对路径，`javascript:` 一律丢弃。
 *
 * 覆盖范围：标题 / 段落 / 粗斜体 / 删除线 / 行内码 / 围栏代码块 / 引用 /
 * 有序无序列表（含两级嵌套）/ 任务列表 / 表格 / 分割线 / 链接 / 图片。
 * 不支持：公式（KaTeX）、流程图（mermaid）、图表 —— 这些要额外的渲染引擎，插件不背。
 */

const CODE_SLOT = '\u0000MDCODE'
const CODE_SLOT_RE = new RegExp(`\u0000MDCODE(\\d+)\u0000`, 'g')

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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

interface ListItem {
  ordered: boolean
  text: string
  task: boolean | null
  children: ListItem[]
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  const cells = splitRow(trimmed)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
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
    html += `<${tag}>${group.map((node) => renderItem(node)).join('')}</${tag}>`
  }
  return html
}

function renderItem(node: ListItem): string {
  const children = node.children.length ? renderNodes(node.children) : ''
  if (node.task === null) return `<li>${renderInline(escapeHtml(node.text))}${children}</li>`
  const checked = node.task ? ' checked' : ''
  return `<li class="md-task"><input type="checkbox" disabled${checked} /><span>${renderInline(escapeHtml(node.text))}${children}</span></li>`
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*(```|~~~)/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    line.trimStart().startsWith('|')
  )
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    // 围栏代码块
    const fence = /^\s*(```|~~~)(.*)$/.exec(line)
    if (fence) {
      const lang = (fence[2] ?? '').trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !/(```|~~~)\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const label = lang ? ` data-lang="${escapeHtml(lang)}"` : ''
      html.push(`<pre class="md-pre"><code${label}>${escapeHtml(code.join('\n'))}</code></pre>`)
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
    if (line.trimStart().startsWith('|') && isTableDivider(lines[index + 1] ?? '')) {
      const header = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join('')}</tr></thead>`
      const body = rows.length
        ? `<tbody>${rows
            .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(escapeHtml(cell))}</td>`).join('')}</tr>`)
            .join('')}</tbody>`
        : ''
      html.push(`<table>${head}${body}</table>`)
      continue
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: ListItem[] = []
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? '')
        if (!match) break
        const indent = (match[1] ?? '').replace(/\t/g, '  ').length
        const raw = match[3] ?? ''
        const task = /^\[([ xX])\]\s+(.*)$/.exec(raw)
        const item: ListItem = {
          ordered: /\d/.test(match[2] ?? ''),
          text: task ? (task[2] ?? '') : raw,
          task: task ? (task[1] ?? '').toLowerCase() === 'x' : null,
          children: [],
        }
        if (indent >= 2) {
          const parent = items[items.length - 1]
          if (parent) parent.children.push(item)
          else items.push(item)
        } else {
          items.push(item)
        }
        index += 1
      }
      html.push(renderNodes(items))
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
