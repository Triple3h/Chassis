/**
 * hosts 文件解析 / 序列化 / 编辑操作。
 *
 * 纯函数，不依赖 Vue 与 Node，浏览器、Worker、测试三处共用。
 *
 * 核心约定：**没被触碰过的行必须原样回写**。
 * hosts 文件里常年混着手写注释、对齐用的连续空格、别的工具生成的标记，
 * 一旦走「解析成结构 → 重新序列化全文」就会整篇重排，用户会当场骂人。
 *
 * 因此有两道保险：
 *   1. 每行的 `raw` **连同行尾换行符一起保存**，没改动就整段回写 ——
 *      连「文件里混用 \n 与 \r\n」这种脏情况也能逐字节还原；
 *   2. 只有 `isDirty()` 为真的条目才按当前字段重新生成，换行符取文件主用的那种。
 */

export interface EntryFields {
  ip: string
  names: string[]
  /** 行尾注释（不含 `#`） */
  comment: string
  /** 是否被注释掉（注释即「禁用」） */
  disabled: boolean
}

export interface PlainLine {
  kind: 'blank' | 'comment' | 'raw'
  /** 原始行文本，**含行尾换行符** */
  raw: string
}

export interface EntryLine extends EntryFields {
  kind: 'entry'
  /** 行内唯一 id：列表 key 与定位用 */
  id: string
  /** 原始行文本（含行尾换行符），未改动时原样回写 */
  raw: string
  /** 原始字段快照；null 表示这是本次新增的条目 */
  orig: EntryFields | null
  /** IP 与域名之间的分隔符（沿用原行写法） */
  sep: string
}

export type HostLine = PlainLine | EntryLine

export interface HostsDoc {
  lines: HostLine[]
  /** 文件主体使用的换行符：新增 / 改动过的行用它 */
  eol: '\n' | '\r\n'
  /** 新增行使用的分隔符：取原文件里出现最多的那种 */
  sep: string
  /** 解析不出结构、只能原样保留的行数（仅用于提示） */
  unparsed: number
}

/* ------------------------------------------------------------------ 词法 */

/** IPv4 形状：只校验形态，值域留给 ipWarning 提示（解析阶段要尽量把行认出来） */
const IPV4_SHAPE = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** IPv6（含 zone id，如 fe80::1%lo0）。宽松匹配，`::1` 这类缩写也要能过 */
const IPV6_SHAPE = /^[0-9a-fA-F:]+(?:%[0-9a-zA-Z._-]+)?$/
/** 主机名：字母数字开头结尾，中间允许 `.` `-` `_`，也放行 `*` 通配写法 */
const HOSTNAME_SHAPE = /^[A-Za-z0-9_*](?:[A-Za-z0-9._*-]*[A-Za-z0-9_*])?$/

/** 看起来是不是一个 IP 字面量（宽松） */
export function looksLikeIp(token: string): boolean {
  if (IPV4_SHAPE.test(token)) return true
  return token.includes(':') && IPV6_SHAPE.test(token)
}

export function isValidHostname(token: string): boolean {
  if (!token || token.length > 253) return false
  return HOSTNAME_SHAPE.test(token)
}

/**
 * 严格校验（只在保存前做提示用，不阻止写入）。
 * 解析阶段故意宽松：宁可把 `999.1.1.1 x` 显示成条目让用户看见，也不要把它埋进 raw 行里。
 */
export function ipWarning(ip: string): string | null {
  if (IPV4_SHAPE.test(ip)) {
    const parts = ip.split('.').map((p) => Number(p))
    if (parts.some((n) => n > 255)) return 'IPv4 每段应在 0-255'
    return null
  }
  if (looksLikeIp(ip)) return null
  return '不像合法的 IP 地址'
}

export function nameWarning(name: string): string | null {
  if (!name) return '域名不能为空'
  if (!isValidHostname(name)) return '域名含非法字符'
  return null
}

interface ParsedEntry {
  ip: string
  sep: string
  names: string[]
  comment: string
}

/** 解析一行「`IP 域名... [# 注释]`」，失败返回 null */
function parseEntryBody(body: string): ParsedEntry | null {
  const hashAt = body.indexOf('#')
  const main = hashAt >= 0 ? body.slice(0, hashAt) : body
  const comment = hashAt >= 0 ? body.slice(hashAt + 1).trim() : ''

  const m = /^(\S+)([ \t]+)(\S.*)$/.exec(main.trim())
  if (!m) return null
  const ip = m[1]
  if (!looksLikeIp(ip)) return null

  const names = m[3].trim().split(/\s+/).filter(Boolean)
  if (!names.length || !names.every(isValidHostname)) return null

  return { ip, sep: m[2], names, comment }
}

/* ---------------------------------------------------------------- 解析 */

/**
 * 行 id 前缀。
 * 解析可能在 Worker 里做、新增条目在主线程做，两边各自从 1 自增必然撞车，
 * 所以给每个运行环境配一个随机前缀。
 */
const ID_PREFIX = Math.random().toString(36).slice(2, 8)
let idSeq = 0

function nextId(): string {
  return `${ID_PREFIX}${++idSeq}`
}

function cloneFields(f: EntryFields): EntryFields {
  return { ip: f.ip, names: [...f.names], comment: f.comment, disabled: f.disabled }
}

interface RawRow {
  text: string
  nl: string
}

/** 按行切分并**保留行尾换行符**，这样回写时能逐字节还原（含 CRLF / 混合换行） */
export function splitKeepEol(text: string): RawRow[] {
  const rows: RawRow[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    const crlf = i > start && text[i - 1] === '\r'
    rows.push({ text: text.slice(start, crlf ? i - 1 : i), nl: crlf ? '\r\n' : '\n' })
    start = i + 1
  }
  if (start < text.length) rows.push({ text: text.slice(start), nl: '' })
  return rows
}

function makeEntry(parsed: ParsedEntry, disabled: boolean, raw: string, sepCount: Map<string, number>): EntryLine {
  sepCount.set(parsed.sep, (sepCount.get(parsed.sep) ?? 0) + 1)
  const fields: EntryFields = {
    ip: parsed.ip,
    names: [...parsed.names],
    comment: parsed.comment,
    disabled,
  }
  return { kind: 'entry', id: nextId(), raw, orig: cloneFields(fields), sep: parsed.sep, ...fields }
}

export function parseHosts(text: string): HostsDoc {
  const rows = splitKeepEol(text)
  const lines: HostLine[] = []
  const sepCount = new Map<string, number>()
  const nlCount = new Map<string, number>()
  let unparsed = 0

  for (const row of rows) {
    const raw = row.text + row.nl
    if (row.nl) nlCount.set(row.nl, (nlCount.get(row.nl) ?? 0) + 1)

    const trimmed = row.text.trim()
    if (!trimmed) {
      lines.push({ kind: 'blank', raw })
      continue
    }

    if (trimmed.startsWith('#')) {
      // 注释行也可能是一条「被禁用」的条目：去掉 # 后仍能解析成 IP + 域名即可
      const body = trimmed.replace(/^#+\s*/, '')
      const parsed = parseEntryBody(body)
      if (parsed) {
        lines.push(makeEntry(parsed, true, raw, sepCount))
        continue
      }
      lines.push({ kind: 'comment', raw })
      continue
    }

    const parsed = parseEntryBody(trimmed)
    if (parsed) {
      lines.push(makeEntry(parsed, false, raw, sepCount))
      continue
    }
    unparsed++
    lines.push({ kind: 'raw', raw })
  }

  let sep = ''
  let sepN = 0
  for (const [value, n] of sepCount) {
    if (n > sepN) {
      sep = value
      sepN = n
    }
  }

  // 主体换行符取出现更多的那个；文件为空时按 \n
  const crlf = nlCount.get('\r\n') ?? 0
  const lf = nlCount.get('\n') ?? 0
  const eol: '\n' | '\r\n' = crlf > lf ? '\r\n' : '\n'

  return { lines, eol, sep: sep || '\t', unparsed }
}

/* ---------------------------------------------------------------- 序列化 */

export function isDirty(line: EntryLine): boolean {
  const o = line.orig
  if (!o) return true
  if (o.ip !== line.ip || o.comment !== line.comment || o.disabled !== line.disabled) return true
  if (o.names.length !== line.names.length) return true
  return o.names.some((n, i) => n !== line.names[i])
}

/** 按当前字段重新生成一行（含行尾换行符） */
export function renderEntry(line: EntryLine, fallbackSep: string, eol: string): string {
  const sep = line.sep || fallbackSep
  let text = `${line.ip}${sep}${line.names.join(' ')}`
  if (line.comment) text += `${sep}# ${line.comment}`
  return (line.disabled ? `# ${text}` : text) + eol
}

export function serializeHosts(doc: HostsDoc): string {
  let out = ''
  for (const line of doc.lines) {
    out += line.kind === 'entry' && isDirty(line) ? renderEntry(line, doc.sep, doc.eol) : line.raw
  }
  return out
}

/* ------------------------------------------------------------ 文档操作 */

export function newEntry(fields: Partial<EntryFields> = {}): EntryLine {
  const merged: EntryFields = {
    ip: fields.ip ?? '',
    names: fields.names ? [...fields.names] : [],
    comment: fields.comment ?? '',
    disabled: fields.disabled ?? false,
  }
  return { kind: 'entry', id: nextId(), raw: '', orig: null, sep: '\t', ...merged }
}

export function findEntry(doc: HostsDoc, id: string): EntryLine | null {
  for (const line of doc.lines) {
    if (line.kind === 'entry' && line.id === id) return line
  }
  return null
}

export function updateEntry(doc: HostsDoc, id: string, patch: Partial<EntryFields>): boolean {
  const line = findEntry(doc, id)
  if (!line) return false
  if (patch.ip !== undefined) line.ip = patch.ip
  if (patch.names !== undefined) line.names = [...patch.names]
  if (patch.comment !== undefined) line.comment = patch.comment
  if (patch.disabled !== undefined) line.disabled = patch.disabled
  return true
}

export interface RemovedLine {
  index: number
  line: HostLine
}

export function removeEntry(doc: HostsDoc, id: string): RemovedLine | null {
  const index = doc.lines.findIndex((l) => l.kind === 'entry' && l.id === id)
  if (index < 0) return null
  const [line] = doc.lines.splice(index, 1)
  return { index, line }
}

export function restoreLine(doc: HostsDoc, removed: RemovedLine): void {
  doc.lines.splice(Math.min(removed.index, doc.lines.length), 0, removed.line)
}

/** 把条目追加到文件末尾；原先末尾不是空行时先补一个空行，避免和新内容粘在一起 */
export function appendEntries(doc: HostsDoc, fields: EntryFields[]): EntryLine[] {
  const added: EntryLine[] = []
  if (!fields.length) return added

  const last = doc.lines[doc.lines.length - 1]
  if (last && last.kind !== 'blank') doc.lines.push({ kind: 'blank', raw: doc.eol })

  for (const f of fields) {
    const line = newEntry(f)
    line.sep = doc.sep
    doc.lines.push(line)
    added.push(line)
  }
  return added
}

/** 用新内容整体替换（粘贴导入的「替换全文」模式） */
export function replaceAll(doc: HostsDoc, text: string): HostsDoc {
  const next = parseHosts(text)
  doc.lines = next.lines
  doc.eol = next.eol
  doc.sep = next.sep
  doc.unparsed = next.unparsed
  return doc
}

/* ------------------------------------------------------------ 粘贴解析 */

export interface ImportResult {
  entries: EntryFields[]
  /** 认不出来的行，原样回显给用户确认 */
  skipped: string[]
}

/** 把任意粘贴文本按行解析成条目（宽松：不要求格式整齐，也接受被注释的行） */
export function parseImportText(text: string): ImportResult {
  const entries: EntryFields[] = []
  const skipped: string[] = []

  for (const raw of text.split(/\r\n|\n|\r/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const disabled = trimmed.startsWith('#')
    const body = disabled ? trimmed.replace(/^#+\s*/, '') : trimmed
    const parsed = parseEntryBody(body)
    if (parsed) {
      entries.push({ ip: parsed.ip, names: parsed.names, comment: parsed.comment, disabled })
    } else {
      skipped.push(trimmed)
    }
  }

  return { entries, skipped }
}

/* -------------------------------------------------------------- 统计 */

export interface DocStats {
  total: number
  enabled: number
  disabled: number
  /** 被改动过的条目数（含新增） */
  dirty: number
  /** 其中本次新增的 */
  added: number
}

export function statsOf(doc: HostsDoc): DocStats {
  let total = 0
  let enabled = 0
  let disabled = 0
  let dirty = 0
  let added = 0
  for (const line of doc.lines) {
    if (line.kind !== 'entry') continue
    total++
    if (line.disabled) disabled++
    else enabled++
    if (isDirty(line)) {
      dirty++
      if (!line.orig) added++
    }
  }
  return { total, enabled, disabled, dirty, added }
}

/**
 * 域名冲突：同一个域名被分给了**多个不同的 IP**。
 *
 * 两个都是为了不误报：
 *  1. `127.0.0.1 localhost` + `::1 localhost` 是 IPv4/IPv6 双栈标配，按地址族分开统计；
 *  2. 同一域名重复指向同一个 IP（复制粘贴留下的重复行）不算冲突，无害。
 */
export function findConflicts(doc: HostsDoc): Map<string, string[]> {
  const groups = new Map<string, { ips: Set<string>; ids: string[] }>()

  for (const line of doc.lines) {
    if (line.kind !== 'entry' || line.disabled) continue
    const family = line.ip.includes(':') ? 'v6' : 'v4'
    for (const name of line.names) {
      const key = `${family}|${name.toLowerCase()}`
      let group = groups.get(key)
      if (!group) {
        group = { ips: new Set(), ids: [] }
        groups.set(key, group)
      }
      group.ips.add(line.ip)
      if (!group.ids.includes(line.id)) group.ids.push(line.id)
    }
  }

  const conflicts = new Map<string, string[]>()
  for (const [key, group] of groups) {
    if (group.ips.size > 1) conflicts.set(key.slice(key.indexOf('|') + 1), group.ids)
  }
  return conflicts
}

/** 系统关键条目：回环地址上的 localhost 之类，删掉会让本机解析出问题 */
const PROTECTED_NAMES = new Set([
  'localhost',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'ip6-mcastprefix',
  'ip6-allnodes',
  'ip6-allrouters',
  'ip6-allhosts',
])

export function isProtectedEntry(line: EntryLine): boolean {
  if (line.disabled) return false
  const loopback = line.ip === '::1' || line.ip.startsWith('127.') || line.ip.startsWith('fe80::1')
  return loopback && line.names.some((n) => PROTECTED_NAMES.has(n.toLowerCase()))
}

/* ---------------------------------------------------------------- 差分 */

export type DiffKind = 'same' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  text: string
  /** 行号：same / add 用新文件行号，del 用旧文件行号 */
  no: number
}

export interface DiffResult {
  rows: DiffRow[]
  added: number
  removed: number
}

export function splitLines(text: string): string[] {
  return splitKeepEol(text).map((r) => r.text)
}

/**
 * 保存预览用的行级差分（不追求最小编辑距离，追求「顺序正确、不虚报」）。
 *
 * 做法：先给每个旧行建位置队列，再按新文件顺序逐个取「位置大于上一个匹配行」的
 * 同文本旧行配对（队列里被越过的项永久作废，所以整体是 O(n)）。
 * 剩下的旧行就是被删掉的，按它们在旧文件里的位置插到对应的新行之前。
 */
export function diffLines(prev: string, next: string): DiffResult {
  const a = splitLines(prev)
  const b = splitLines(next)

  const pool = new Map<string, number[]>()
  for (let i = 0; i < a.length; i++) {
    const list = pool.get(a[i])
    if (list) list.push(i)
    else pool.set(a[i], [i])
  }

  const kept = new Array<boolean>(a.length).fill(false)
  const matched = new Array<boolean>(b.length).fill(false)
  let lastPos = -1

  for (let bi = 0; bi < b.length; bi++) {
    const list = pool.get(b[bi])
    if (!list?.length) continue
    while (list.length && list[0] <= lastPos) list.shift()
    if (!list.length) continue
    const pos = list.shift() as number
    kept[pos] = true
    matched[bi] = true
    lastPos = pos
  }

  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let cursor = 0

  for (let bi = 0; bi < b.length; bi++) {
    if (matched[bi]) {
      while (cursor < a.length && !kept[cursor]) {
        rows.push({ kind: 'del', text: a[cursor], no: cursor + 1 })
        removed++
        cursor++
      }
      cursor++
      rows.push({ kind: 'same', text: b[bi], no: bi + 1 })
    } else {
      rows.push({ kind: 'add', text: b[bi], no: bi + 1 })
      added++
    }
  }
  while (cursor < a.length) {
    if (!kept[cursor]) {
      rows.push({ kind: 'del', text: a[cursor], no: cursor + 1 })
      removed++
    }
    cursor++
  }

  return { rows, added, removed }
}
