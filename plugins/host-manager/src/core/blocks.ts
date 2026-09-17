import {
  findConflicts,
  isDirty,
  newEntry,
  parseHosts,
  renderEntry,
  splitKeepEol,
  type EntryFields,
  type EntryLine,
  type HostLine,
  type HostsDoc,
} from './hosts'

/**
 * 块模型：把 hosts 文件切成「托管区（本插件写的块）+ 区外内容（别的程序写的行）」。
 *
 * 为什么要块：hosts 里常年混着系统行、VPN 启动时自己加的行、以及用户自己几套环境的配置。
 * 插件只该碰**自己写的那一段**，把这一段再拆成可整体开关的块（一个项目一个块）。
 *
 * 单一真源是**文件本身**，不另存一份状态：
 *
 * ```
 * …系统行 / 别的程序写的行…
 *
 * # >>> host-manager >>>
 * # @block 开发环境
 * 10.0.0.1	dev.example.com
 * # @/block
 * # @block 备用线路 | off
 * # 10.0.0.9	backup.example.com
 * # @/block
 * # <<< host-manager <<<
 * ```
 *
 * 三个约定：
 *   1. 区外内容**逐字节原样**留在 head / tail 里，保存时由 script 侧拼回去（见 `spliceRegion`）；
 *   2. 块关闭时标记行写 `| off`，块体每行多套一层 `# `（关掉就是注释掉，文件本身就是最终形态）；
 *   3. 块内行沿用 `hosts.ts` 的行模型，没改过的行原样回写，保住用户的空格对齐与手写注释。
 */

export const REGION_BEGIN = '# >>> host-manager >>>'
export const REGION_END = '# <<< host-manager <<<'
const BLOCK_END_MARKER = '# @/block'
/** 关闭标记：写在块名后面，顺手也能被人一眼看懂 */
const OFF_SUFFIX = ' | off'
const BLOCK_BEGIN_RE = /^#\s*@block\s+(.+?)\s*$/
const BLOCK_END_RE = /^#\s*@\/block\s*$/
/** 块体层的形态：`# 内容` / `#\t内容` / 只有一个 `#` */
const LAYER_RE = /^#(?:[ \t](.*))?$/
/** UI 里「新建一个块」这个选项的值（块 id 长得不像这样） */
export const NEW_BLOCK = '__new__'

export interface Block {
  id: string
  name: string
  /** 块级开关：关闭的块写进文件时整块注释掉 */
  enabled: boolean
  /** 块体（同 hosts.ts 的行模型，保持无损回写） */
  body: HostsDoc
}

export interface BlocksDoc {
  /** 托管区之前的内容（原样，含外部条目） */
  head: HostsDoc
  /** 托管区之后的内容 */
  tail: HostsDoc
  blocks: Block[]
  /** 读进来的时候文件里有没有托管区（没有 ⇒ 保存时是「首次接管」，区域追加到末尾） */
  hasRegion: boolean
  /** 文件主换行符：新行与块标记都用它 */
  eol: '\n' | '\r\n'
  /** 新增条目用的列分隔符 */
  sep: string
}

/* ------------------------------------------------------------ 行与层 */

interface RawRow {
  text: string
  nl: string
}

/** 拆出不含换行符的正文（`raw` 是「正文 + 行尾换行符」） */
function splitRaw(raw: string): RawRow {
  const rows = splitKeepEol(raw)
  return rows.length ? rows[0] : { text: '', nl: '' }
}

function rowsOf(text: string): RawRow[] {
  return splitKeepEol(text)
}

function joinRows(rows: RawRow[]): string {
  let out = ''
  for (const row of rows) out += row.text + row.nl
  return out
}

/** 关掉的块：给正文行套一层注释（空行不套，套了也白套） */
function addLayer(text: string): string {
  return text.trim() ? `# ${text}` : text
}

/** 反解一层注释（只认 `# ` / `#\t`；单独一个 `#` 视作空行） */
function stripLayer(text: string): string {
  if (!text.trim()) return text
  const m = LAYER_RE.exec(text)
  if (!m) return text
  return m[1] ?? ''
}

/** 整段套 / 反解一层（导出给测试用） */
export function applyLayer(text: string): string {
  return joinRows(rowsOf(text).map((row) => ({ text: addLayer(row.text), nl: row.nl })))
}

export function stripLayerText(text: string): string {
  return joinRows(rowsOf(text).map((row) => ({ text: stripLayer(row.text), nl: row.nl })))
}

/* ------------------------------------------------------------ 块标记 */

function blockNameOf(block: Block): string {
  // 名字里的 `|` 与换行会破坏标记语法，写入前统一压成空格
  const name = block.name.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return name || '未命名'
}

function blockHeader(block: Block): string {
  return `# @block ${blockNameOf(block)}${block.enabled ? '' : OFF_SUFFIX}`
}

function parseBlockHeader(line: string): { name: string; enabled: boolean } | null {
  const m = BLOCK_BEGIN_RE.exec(line)
  if (!m) return null
  let name = m[1].trim()
  let enabled = true
  if (name.endsWith(OFF_SUFFIX)) {
    enabled = false
    name = name.slice(0, -OFF_SUFFIX.length).trim()
  }
  return { name: name || '未命名', enabled }
}

/* ------------------------------------------------------------ 解析 */

const ID_PREFIX = Math.random().toString(36).slice(2, 8)
let seq = 0

function nextBlockId(): string {
  return `b${ID_PREFIX}${++seq}`
}

function emptyDoc(eol: string, sep: string): HostsDoc {
  return { lines: [], eol: eol === '\r\n' ? '\r\n' : '\n', sep, unparsed: 0 }
}

/**
 * 把整份文件拆成 head / region / tail 三段（文本级，script 侧也用它做「手术式替换」）。
 * 没找到起始标记就当作「整份都是区外内容」—— 结束标记孤零零出现时同样按注释处理。
 */
export function splitRegion(fileText: string): { found: boolean; head: string; region: string; tail: string } {
  const rows = rowsOf(fileText)
  let begin = -1
  let end = -1
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i].text.trim()
    if (begin < 0 && text === REGION_BEGIN) {
      begin = i
      continue
    }
    if (begin >= 0 && end < 0 && text === REGION_END) {
      end = i
      break
    }
  }
  if (begin < 0) return { found: false, head: fileText, region: '', tail: '' }
  return {
    found: true,
    head: joinRows(rows.slice(0, begin)),
    region: joinRows(rows.slice(begin, end < 0 ? rows.length : end + 1)),
    tail: joinRows(end < 0 ? [] : rows.slice(end + 1)),
  }
}

/** 从托管区文本里解出块列表（区外两段由调用方另外解析） */
export function parseBlocks(regionText: string, eol: '\n' | '\r\n', sep: string): Block[] {
  const rows = rowsOf(regionText)
  const blocks: Block[] = []
  /** 没被任何块包住的散行（手改过区域时兜底，不丢内容） */
  const loose: RawRow[] = []
  let current: { name: string; enabled: boolean; rows: RawRow[] } | null = null

  const flush = () => {
    if (!current) return
    const bodyText = current.enabled
      ? joinRows(current.rows)
      : joinRows(current.rows.map((row) => ({ text: stripLayer(row.text), nl: row.nl })))
    blocks.push({
      id: nextBlockId(),
      name: current.name,
      enabled: current.enabled,
      body: { ...parseHosts(bodyText), eol, sep },
    })
    current = null
  }

  for (const row of rows) {
    const text = row.text.trim()
    if (text === REGION_BEGIN || text === REGION_END) continue
    const header = parseBlockHeader(text)
    if (header) {
      flush()
      current = { name: header.name, enabled: header.enabled, rows: [] }
      continue
    }
    if (BLOCK_END_RE.test(text)) {
      flush()
      continue
    }
    if (current) current.rows.push(row)
    else if (text) loose.push(row)
  }
  flush()

  if (loose.length) {
    blocks.unshift({
      id: nextBlockId(),
      name: '未分组',
      enabled: true,
      body: { ...parseHosts(joinRows(loose)), eol, sep },
    })
  }
  return blocks
}

export function parseBlocksDoc(fileText: string): BlocksDoc {
  const whole = parseHosts(fileText)
  const eol = whole.eol
  const sep = whole.sep
  const parts = splitRegion(fileText)
  return {
    head: { ...parseHosts(parts.head), eol, sep },
    tail: { ...parseHosts(parts.tail), eol, sep },
    blocks: parts.found ? parseBlocks(parts.region, eol, sep) : [],
    hasRegion: parts.found,
    eol,
    sep,
  }
}

/* ------------------------------------------------------------ 渲染 */

export type PreviewKind = 'blank' | 'comment' | 'raw' | 'entry' | 'marker' | 'block-head'

export interface PreviewLine {
  text: string
  /** 行尾换行符（预览用不着，拼接最终文本时要用） */
  nl: string
  kind: PreviewKind
  /** 所属块（null = 托管区之外，或者是区域标记行） */
  blockId: string | null
  /** 这一行不会生效：行级禁用，或者整块被关掉 */
  disabled: boolean
  /** 是否属于托管区 */
  inRegion: boolean
}

function metaLine(text: string, nl: string, kind: PreviewKind, blockId: string | null, disabled = false, inRegion = false): PreviewLine {
  return { text, nl, kind, blockId, disabled, inRegion }
}

/** 区外两段：行模型直接映射，条目不会被我们改动，所以 raw 就是最终形态 */
function outsideLines(doc: HostsDoc): PreviewLine[] {
  return doc.lines.map((line: HostLine) => {
    const row = splitRaw(line.raw)
    const disabled = line.kind === 'entry' ? line.disabled : false
    return metaLine(row.text, row.nl, line.kind, null, disabled)
  })
}

/** 块内一行：改过的条目重渲染，没改过的原样回写 */
function blockLine(line: HostLine, doc: BlocksDoc, off: boolean): PreviewLine {
  const row =
    line.kind === 'entry'
      ? splitRaw(isDirty(line) ? renderEntry(line, doc.sep, doc.eol) : line.raw)
      : splitRaw(line.raw)
  return metaLine(
    off ? addLayer(row.text) : row.text,
    row.nl,
    line.kind,
    null,
    line.kind === 'entry' ? line.disabled || off : false,
    true,
  )
}

/** 托管区行序列（含首尾标记）；没有块 ⇒ 空数组（托管区整段消失） */
export function regionLines(doc: BlocksDoc): PreviewLine[] {
  if (!doc.blocks.length) return []
  const out: PreviewLine[] = [metaLine(REGION_BEGIN, doc.eol, 'marker', null, false, true)]
  for (const block of doc.blocks) {
    const off = !block.enabled
    out.push(metaLine(blockHeader(block), doc.eol, 'block-head', block.id, off, true))
    for (const line of block.body.lines) {
      out.push({ ...blockLine(line, doc, off), blockId: block.id })
    }
    out.push(metaLine(BLOCK_END_MARKER, doc.eol, 'marker', block.id, false, true))
  }
  out.push(metaLine(REGION_END, doc.eol, 'marker', null, false, true))
  return out
}

/**
 * 三段拼接（区外两段 + 托管区）：托管区前后各保证一个空行分隔，已有的不重复补。
 * `makeBlank` 让调用方决定「补出来的空行长什么样」（预览要带类型，纯文本版只要 text/nl）。
 */
function withSeparators<T extends { text: string; nl: string }>(
  head: T[],
  region: T[],
  tail: T[],
  eol: string,
  makeBlank: () => T,
): T[] {
  if (!region.length) return [...head, ...tail]
  const out = [...head]
  const last = out[out.length - 1]
  // 文件末尾没有换行符时先补上，否则标记会粘在最后一行后面
  if (last && !last.nl) last.nl = eol
  if (out.length && last && last.text.trim()) out.push(makeBlank())
  out.push(...region)
  const firstTail = tail[0]
  if (firstTail && firstTail.text.trim()) out.push(makeBlank())
  out.push(...tail)
  return out
}

/** 块列表渲染成托管区文本（含首尾标记；没有块时为空串 = 从文件里移除托管区） */
export function renderRegion(doc: BlocksDoc): string {
  return joinRows(regionLines(doc))
}

/** 完整文件行序列（预览的着色与最终文本都由它来，两者不会跑偏） */
export function previewLines(doc: BlocksDoc): PreviewLine[] {
  return withSeparators(
    outsideLines(doc.head),
    regionLines(doc),
    outsideLines(doc.tail),
    doc.eol,
    () => metaLine('', doc.eol, 'blank', null),
  )
}

export function renderFile(doc: BlocksDoc): string {
  return joinRows(previewLines(doc))
}

/**
 * 手术式替换：只把托管区换掉，区外内容逐字节保留。
 * **写盘时由 script 侧调用**（重新读一遍文件再换），所以别的程序在这期间加的行不会被覆盖。
 */
export function spliceRegion(fileText: string, region: string): string {
  const parts = splitRegion(fileText)
  const eol = parseHosts(fileText).eol
  return joinRows(
    withSeparators(
      rowsOf(parts.found ? parts.head : fileText),
      rowsOf(region),
      rowsOf(parts.found ? parts.tail : ''),
      eol,
      () => ({ text: '', nl: eol }),
    ),
  )
}

/**
 * 从**托管区之外**删掉指定的行（`takeOutsideEntry` 收进块时用）。
 *
 * 只删调用方点名的那几行、逐字匹配、每行最多删一次：区外内容依旧不做任何重排。
 * 文件在这期间被别的程序改过（行文本对不上了）就跳过 —— 宁可那条记录留在外面，
 * 也不能误删一行别人的东西。
 */
export function removeOutsideLines(fileText: string, remove: string[]): string {
  if (!remove.length) return fileText
  const parts = splitRegion(fileText)
  const drop = [...remove]
  const filter = (text: string): string => {
    if (!drop.length || !text) return text
    return joinRows(
      rowsOf(text).filter((row) => {
        const index = drop.indexOf(row.text + row.nl)
        if (index < 0) return true
        drop.splice(index, 1)
        return false
      }),
    )
  }
  return filter(parts.head) + parts.region + filter(parts.tail)
}

/* ------------------------------------------------------------ 统计 */

export interface BlocksStats {
  blocks: number
  /** 托管区内的条目总数 */
  entries: number
  /** 托管区内会生效的条目（块开着 + 行开着） */
  enabled: number
  disabled: number
  /** 区外能解析成条目的行数（VPN / 手动加的那些） */
  outside: number
  /** 区外读不出结构的行数 */
  outsideRaw: number
}

export function statsOf(doc: BlocksDoc): BlocksStats {
  let entries = 0
  let enabled = 0
  for (const block of doc.blocks) {
    for (const line of block.body.lines) {
      if (line.kind !== 'entry') continue
      entries++
      if (block.enabled && !line.disabled) enabled++
    }
  }
  let outside = 0
  for (const part of [doc.head, doc.tail]) {
    for (const line of part.lines) if (line.kind === 'entry') outside++
  }
  return {
    blocks: doc.blocks.length,
    entries,
    enabled,
    disabled: entries - enabled,
    outside,
    outsideRaw: doc.head.unparsed + doc.tail.unparsed,
  }
}

/** 跨块 + 跨区外的域名冲突（同域名指向多个 IP）：复用 hosts.ts 的判定，只借它的行列表 */
export function conflictsOf(doc: BlocksDoc): Set<string> {
  const lines: HostLine[] = [...doc.head.lines, ...doc.tail.lines]
  for (const block of doc.blocks) {
    if (block.enabled) lines.push(...block.body.lines)
  }
  const merged: HostsDoc = { lines, eol: doc.eol, sep: doc.sep, unparsed: 0 }
  const ids = new Set<string>()
  for (const list of findConflicts(merged).values()) for (const id of list) ids.add(id)
  return ids
}

/** 条目是否命中过滤词（域名 / IP / 备注，忽略大小写与首尾空格） */
export function matchesQuery(line: EntryLine, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    line.ip.toLowerCase().includes(q) ||
    line.comment.toLowerCase().includes(q) ||
    line.names.some((n) => n.toLowerCase().includes(q))
  )
}

/** 块里有没有命中过滤词的条目（过滤时自动展开用） */
export function blockMatches(block: Block, query: string): boolean {
  if (!query.trim()) return false
  return block.body.lines.some((line) => line.kind === 'entry' && matchesQuery(line, query))
}

/* ------------------------------------------------------------ 块操作 */

export function blockById(doc: BlocksDoc, id: string): Block | null {
  return doc.blocks.find((b) => b.id === id) ?? null
}

export function createBlock(doc: BlocksDoc, name: string, at?: number): Block {
  const block: Block = {
    id: nextBlockId(),
    name: name.trim() || '新块',
    enabled: true,
    body: emptyDoc(doc.eol, doc.sep),
  }
  const index = at === undefined ? doc.blocks.length : Math.max(0, Math.min(at, doc.blocks.length))
  doc.blocks.splice(index, 0, block)
  return block
}

export function renameBlock(doc: BlocksDoc, id: string, name: string): boolean {
  const block = blockById(doc, id)
  if (!block) return false
  block.name = name.trim() || block.name
  return true
}

export function setBlockEnabled(doc: BlocksDoc, id: string, enabled: boolean): boolean {
  const block = blockById(doc, id)
  if (!block) return false
  block.enabled = enabled
  return true
}

export function removeBlock(doc: BlocksDoc, id: string): { block: Block; index: number } | null {
  const index = doc.blocks.findIndex((b) => b.id === id)
  if (index < 0) return null
  const [block] = doc.blocks.splice(index, 1)
  return { block, index }
}

export function restoreBlock(doc: BlocksDoc, removed: { block: Block; index: number }): void {
  doc.blocks.splice(Math.min(removed.index, doc.blocks.length), 0, removed.block)
}

export function moveBlock(doc: BlocksDoc, id: string, delta: number): boolean {
  const index = doc.blocks.findIndex((b) => b.id === id)
  const next = index + delta
  if (index < 0 || next < 0 || next >= doc.blocks.length) return false
  const [block] = doc.blocks.splice(index, 1)
  doc.blocks.splice(next, 0, block)
  return true
}

/* ------------------------------------------------------------ 条目操作 */

export function locateEntry(doc: BlocksDoc, entryId: string): { block: Block; line: EntryLine } | null {
  for (const block of doc.blocks) {
    for (const line of block.body.lines) {
      if (line.kind === 'entry' && line.id === entryId) return { block, line }
    }
  }
  return null
}

export function addBlockEntries(doc: BlocksDoc, blockId: string, fields: EntryFields[]): EntryLine[] {
  const block = blockById(doc, blockId)
  if (!block) return []
  const added: EntryLine[] = []
  for (const f of fields) {
    const line = newEntry(f)
    line.sep = doc.sep
    block.body.lines.push(line)
    added.push(line)
  }
  return added
}

export function updateBlockEntry(
  doc: BlocksDoc,
  blockId: string,
  entryId: string,
  patch: Partial<EntryFields>,
): boolean {
  const found = locateEntry(doc, entryId)
  if (!found || found.block.id !== blockId) return false
  const line = found.line
  if (patch.ip !== undefined) line.ip = patch.ip
  if (patch.names !== undefined) line.names = [...patch.names]
  if (patch.comment !== undefined) line.comment = patch.comment
  if (patch.disabled !== undefined) line.disabled = patch.disabled
  return true
}

export interface RemovedBlockEntry {
  blockId: string
  index: number
  line: HostLine
}

export function removeBlockEntry(doc: BlocksDoc, blockId: string, entryId: string): RemovedBlockEntry | null {
  const block = blockById(doc, blockId)
  if (!block) return null
  const index = block.body.lines.findIndex((l) => l.kind === 'entry' && l.id === entryId)
  if (index < 0) return null
  const [line] = block.body.lines.splice(index, 1)
  return { blockId, index, line }
}

export function restoreBlockEntry(doc: BlocksDoc, removed: RemovedBlockEntry): void {
  const block = blockById(doc, removed.blockId)
  if (!block) return
  block.body.lines.splice(Math.min(removed.index, block.body.lines.length), 0, removed.line)
}

/* -------------------------------------------------------- 区外条目 */

/** 区外能解析成条目的行（head 在前、tail 在后，顺序与文件一致） */
export function outsideEntries(doc: BlocksDoc): EntryLine[] {
  const out: EntryLine[] = []
  for (const part of [doc.head, doc.tail]) {
    for (const line of part.lines) if (line.kind === 'entry') out.push(line)
  }
  return out
}

export function findOutsideEntry(doc: BlocksDoc, entryId: string): EntryLine | null {
  return outsideEntries(doc).find((l) => l.id === entryId) ?? null
}

export interface TakenOutsideEntry {
  fields: EntryFields
  /** 原始行文本（含行尾换行符）：写盘时要把它从区外删掉 */
  raw: string
}

/** 把一条区外条目从 head / tail 里摘掉（收进托管区用） */
export function takeOutsideEntry(doc: BlocksDoc, entryId: string): TakenOutsideEntry | null {
  for (const part of [doc.head, doc.tail]) {
    const index = part.lines.findIndex((l) => l.kind === 'entry' && l.id === entryId)
    if (index < 0) continue
    const [line] = part.lines.splice(index, 1)
    const entry = line as EntryLine
    return {
      fields: { ip: entry.ip, names: [...entry.names], comment: entry.comment, disabled: entry.disabled },
      raw: entry.raw,
    }
  }
  return null
}

export interface AdoptTarget {
  /** 收进已有的块 */
  blockId?: string
  /** 收进一个新建的块（给名字） */
  newBlockName?: string
}

/**
 * 区外条目收进托管区：从区外摘掉 + 落到目标块（或新建一个块）。
 * 这是「升级后把以前的条目组织起来」和「VPN 加的行想纳管」的入口。
 */
export function adoptOutsideEntry(
  doc: BlocksDoc,
  entryId: string,
  target: AdoptTarget,
): { entry: EntryLine; raw: string } | null {
  const taken = takeOutsideEntry(doc, entryId)
  if (!taken) return null
  const blockId = resolveTargetBlock(doc, target)
  const entry = addBlockEntries(doc, blockId, [taken.fields])[0]
  return entry ? { entry, raw: taken.raw } : null
}

/** 目标块：给了 id 就用它，否则新建一个（块 id 不存在时同样新建，别把内容弄丢） */
export function resolveTargetBlock(doc: BlocksDoc, target: AdoptTarget): string {
  if (target.blockId && blockById(doc, target.blockId)) return target.blockId
  return createBlock(doc, target.newBlockName ?? '新块').id
}

/**
 * 存档还原：新存档存的是**托管区文本**，直接解析；
 * 老存档（有块之前）存的是整份文件，就整体收成一个块 —— 一条记录都不丢。
 */
export function blocksFromArchive(
  content: string,
  eol: '\n' | '\r\n',
  sep: string,
  fallbackName: string,
): Block[] {
  if (splitRegion(content).found) return parseBlocks(content, eol, sep)
  const body = parseHosts(content)
  if (!body.lines.length) return []
  return [{ id: nextBlockId(), name: fallbackName, enabled: true, body: { ...body, eol, sep } }]
}
