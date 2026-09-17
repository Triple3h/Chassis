<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { copyText } from '@launcher/ui/clipboard'
import { isMod, isTypingTarget, modLabel } from '@launcher/ui/keys'
import { exec, host, hostUi } from '@launcher/api'
import { useToast } from '@launcher/ui/toast'
import BlockCard from './components/BlockCard.vue'
import EntryDialog from './components/EntryDialog.vue'
import FilePane from './components/FilePane.vue'
import OutsideCard from './components/OutsideCard.vue'
import PasteDialog from './components/PasteDialog.vue'
import PermissionDialog from './components/PermissionDialog.vue'
import RegionEditorDialog from './components/RegionEditorDialog.vue'
import SaveDialog from './components/SaveDialog.vue'
import SnapshotDialog from './components/SnapshotDialog.vue'
import {
  NEW_BLOCK,
  REGION_BEGIN,
  REGION_END,
  addBlockEntries,
  adoptOutsideEntry,
  blockById,
  blockMatches,
  blocksFromArchive,
  conflictsOf,
  createBlock,
  locateEntry,
  matchesQuery,
  moveBlock,
  outsideEntries,
  previewLines,
  removeBlock,
  removeBlockEntry,
  renameBlock,
  renderFile,
  renderRegion,
  resolveTargetBlock,
  restoreBlock,
  restoreBlockEntry,
  setBlockEnabled,
  splitRegion,
  statsOf,
  takeOutsideEntry,
  updateBlockEntry,
  type AdoptTarget,
  type Block,
  type BlocksDoc,
  type PreviewLine,
  type RemovedBlockEntry,
} from './core/blocks'
import { isProtectedEntry, parseImportText, type EntryFields, type EntryLine } from './core/hosts'
import { runDiffLines, runParseBlocks } from './core/runner'
import type {
  HostsPermissionResult,
  HostsReadResult,
  HostsWriteResult,
  PermissionAction,
} from './core/script-types'
import { loadSnapshots, persistSnapshots, pushSnapshot, removeSnapshot, type Snapshot } from './core/snapshots'

/**
 * Hosts 管家（块版）。
 *
 * 左栏 = 块（一个项目一个块，整块可开关；托管区之外的东西单独成「外部条目」卡片），
 * 右栏 = **最终 hosts 文件**（按当前配置算出来、点保存就写进去的那份）。
 *
 * 单一真源是文件本身：块的结构与开关都在托管区标记里，插件不另存状态，
 * 所以在别处手改了文件、下次打开照样读得回来。保存只换托管区那一段，
 * 区外的行（系统行、VPN 自己加的）逐字节不动 —— 见 core/blocks.ts 与 no-view/_hosts-file.ts。
 */

/** 提权对话框要等用户输密码，超时给足 */
const WRITE_TIMEOUT = 180_000

/**
 * 没有宿主时（浏览器里 npm run dev）用的演示内容：带托管区、一个关掉的块、一条外来的行。
 * 首尾标记用常量拼，别手打 —— 箭头写反一个（`<<<` 写成 `>>>`）区域就认不出来，
 * 表现是「多出一个未分组的块」，很难一眼看出是标记拼错了。
 */
const DEMO_TEXT = `##
# Host Database
#
# 演示模式：没检测到启动台宿主，所有改动不会写进系统文件
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost

# 某 VPN 启动时自己加的行（不归本插件管）
10.8.0.1\tvpn.internal.example.com

${REGION_BEGIN}
# @block 开发环境
10.0.0.1\tdev.example.com\t# 主站
10.0.0.2\tapi.dev.example.com
# @/block
# @block 备用线路 | off
# 10.0.0.9\tbackup.example.com
# @/block
${REGION_END}
`

const loading = ref(true)
const demoMode = ref(false)
const fileInfo = shallowRef<HostsReadResult | null>(null)
/** 块模型（浅响应式：几万行不能深度代理，改动靠 version 推下去） */
const doc = shallowRef<BlocksDoc | null>(null)
/** 磁盘上的原文（算「有没有改动」用） */
const diskText = ref('')
const version = ref(0)

/** 最终文件的预览行与差异 */
const lines = shallowRef<PreviewLine[]>([])
const finalText = ref('')
const marks = shallowRef<Set<number>>(new Set())
const diffCount = shallowRef({ added: 0, removed: 0 })
const dirty = ref(false)

const query = ref('')
const expanded = ref<Record<string, boolean>>({})
const outsideOpen = ref(false)
const activeBlockId = ref<string | null>(null)
/** 本次会话要从区外删掉的行（收进块），写盘时交给脚本 */
const outsideRemovals = ref<string[]>([])
type UndoItem =
  | { kind: 'entry'; data: RemovedBlockEntry }
  | { kind: 'block'; data: { block: Block; index: number } }
  /** 批量编辑：整段托管区被换掉，撤销 = 换回原来那批块 */
  | { kind: 'region'; data: { blocks: Block[] } }
const undoStack = shallowRef<UndoItem[]>([])

const editing = shallowRef<{
  /** 编辑块内条目时传入；null 表示新建 */
  line: EntryLine | null
  /** 区外条目的 id：收进块时要把它从区外摘掉 */
  outsideId: string | null
  preset: Partial<EntryFields> | null
  fromBlockId: string | null
  defaultTarget: string
} | null>(null)

const showPaste = ref(false)
const showSnapshots = ref(false)
const showSave = ref(false)
const showRegionEditor = ref(false)
const showPermission = ref(false)
/** 批量编辑器的初始内容：打开那一刻的托管区文本（编辑器里怎么改都不会回流） */
const regionText = ref('')
const savePhase = ref<'preview' | 'writing' | 'manual' | 'done'>('preview')
const writeResult = shallowRef<HostsWriteResult | null>(null)
const nextText = ref('')
const snapshots = ref<Snapshot[]>([])
/** 免授权写入的状态（打开权限面板 / 开启 / 撤销后刷新） */
const permission = shallowRef<HostsPermissionResult | null>(null)
const permissionBusy = ref(false)

const searchRef = ref<HTMLInputElement | null>(null)
const paneRef = ref<InstanceType<typeof FilePane> | null>(null)
const toast = useToast()

/* ------------------------------------------------------------ 派生数据 */

const blocks = computed(() => doc.value?.blocks ?? [])
const stats = computed(() =>
  doc.value ? statsOf(doc.value) : { blocks: 0, entries: 0, enabled: 0, disabled: 0, outside: 0, outsideRaw: 0 },
)
const outside = computed(() => (doc.value ? outsideEntries(doc.value) : []))
const conflicts = computed(() => (doc.value ? conflictsOf(doc.value) : new Set<string>()))
const blockBriefs = computed(() => blocks.value.map((b) => ({ id: b.id, name: b.name })))
const defaultTarget = computed(() => activeBlockId.value ?? blocks.value[0]?.id ?? NEW_BLOCK)
const path = computed(() => fileInfo.value?.path ?? '/etc/hosts')
const platform = computed(() => fileInfo.value?.platform ?? 'darwin')
const placeholder = computed(() =>
  demoMode.value ? '搜索域名 / IP / 备注（演示模式）' : '搜索域名 / IP / 备注',
)
/** 区外条目里能收进托管区的（系统回环行不动） */
const adoptableOutside = computed(() => outside.value.filter((line) => !isProtectedEntry(line)))
/** 批量编辑器用的换行符与分隔符（跟当前文件一致） */
const editorEol = computed(() => doc.value?.eol ?? '\n')
const editorSep = computed(() => doc.value?.sep ?? '\t')
/** 当前是不是「本插件开的免授权」（ACL 在不在） */
const aclGranted = computed(() => !!permission.value?.granted)

/* -------------------------------------------------------------- 生命周期 */

let stopSearchWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  snapshots.value = await loadSnapshots()
  await reload()
  loading.value = false

  // 这两个在演示模式（没有宿主）下必然失败，失败也只是少个底部按钮 / 少一次预填
  void registerFooter().catch(() => undefined)
  void syncSearchContent().catch(() => undefined)
  stopSearchWatch = hostUi.watchSearchContent((value) => {
    query.value = value
  })
})

onUnmounted(() => {
  stopSearchWatch?.()
  window.removeEventListener('keydown', onKeydown)
})

/** 宿主搜索框的内容：当作过滤词；如果本身是一条 host 记录就直接进新建流程 */
async function syncSearchContent() {
  const initial = (await hostUi.getSearchContent()).trim()
  if (!initial) return
  query.value = initial
  const parsed = parseImportText(initial)
  if (parsed.entries.length === 1 && !parsed.skipped.length) {
    query.value = ''
    const targetId = entryTarget()
    expanded.value = { ...expanded.value, [targetId]: true }
    editing.value = { line: null, outsideId: null, preset: parsed.entries[0], fromBlockId: targetId, defaultTarget: targetId }
    touch()
    void hostUi.clearSearchContent()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    onCreateBlock()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void openSave()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    onCreateEntry()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchRef.value?.focus()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'z' && !isTypingTarget(e.target)) {
    e.preventDefault()
    undo()
  }
}

async function registerFooter() {
  await hostUi.setFooter([
    { type: 'button', label: '新增条目', icon: 'plus', keys: ['Mod+N'], onClick: () => onCreateEntry() },
    { type: 'button', label: '保存到系统', icon: 'save', keys: ['Mod+S'], onClick: () => void openSave() },
  ])
}

/* ------------------------------------------------------------------ 载入 */

function requireDoc(): BlocksDoc {
  if (!doc.value) throw new Error('文档还没载入')
  return doc.value
}

async function applyText(text: string) {
  const parsed = await runParseBlocks(text)
  doc.value = parsed
  diskText.value = text
  outsideRemovals.value = []
  undoStack.value = []
  const first = parsed.blocks[0]
  expanded.value = first ? { [first.id]: true } : {}
  outsideOpen.value = !first
  activeBlockId.value = first?.id ?? null
  refresh()
  await nextTick()
  scrollToActive()
}

/**
 * 宿主会用 `?sid=` 加载 iframe，没带就一定是本地浏览器直接打开的，
 * 这种情况不必去等 script 的长超时，直接亮演示内容。
 */
async function isHosted(): Promise<boolean> {
  return host.isLauncher()
}

async function reload(notify = false) {
  if (!(await isHosted())) {
    // 没有宿主：进演示模式，界面功能全部可用，只是写不进系统文件
    demoMode.value = true
    fileInfo.value = null
    await applyText(DEMO_TEXT)
    return
  }

  const res = (await exec
    .run({ command: 'hosts-read', args: {}, timeoutMs: 15_000 })
    .catch(() => null)) as HostsReadResult | null

  if (!res) {
    // 宿主在但不认这个脚本（版本太旧）：同样退到演示模式，别让界面空着
    demoMode.value = true
    fileInfo.value = null
    await applyText(DEMO_TEXT)
    return
  }

  if (!res.ok) {
    fileInfo.value = res
    demoMode.value = false
    await applyText('')
    toast.err(res.error ?? '读取 hosts 失败')
    return
  }

  demoMode.value = false
  fileInfo.value = res
  await applyText(res.content)
  if (notify) toast.ok('已重新读取')
}

/* ------------------------------------------------------------ 预览刷新 */

/**
 * 任何改动都走这里：换一批新引用 → 推版本号 → 重算右栏。
 *
 * **为什么不能「原地改 + triggerRef」**：派生数据全是 computed，而 computed 只在
 * 「它读到的那个引用变了」时才通知下游。块模型是 shallowRef + 对象原地改，
 * 原地 push/splice 之后 `doc.value.blocks` 还是同一个数组、`props.block` 还是同一个对象 ⇒
 * 「左栏块列表 / 收进块弹窗的下拉选项 / 卡片里的条目列表」全部停在旧值上。
 * 2026-09-17 用户实测踩到：新建的块在收进块弹窗里选不到（新建块后左栏也不出现）。
 * 代价只是几个浅拷贝（行对象与行数组都共享，不复制内容）。
 */
function touch() {
  version.value++
  const d = doc.value
  if (d) doc.value = { ...d, blocks: d.blocks.map((block) => ({ ...block })) }
  refresh()
}

/** 重算右栏：最终文本、预览行、与磁盘的差异 */
function refresh() {
  const d = doc.value
  if (!d) return
  const next = renderFile(d)
  finalText.value = next
  lines.value = previewLines(d)
  dirty.value = next !== diskText.value

  void runDiffLines(diskText.value, next).then((res) => {
    const added = new Set<number>()
    for (const row of res.rows) if (row.kind === 'add') added.add(row.no)
    marks.value = added
    diffCount.value = { added: res.added, removed: res.removed }
  })
}

function scrollToActive() {
  if (!activeBlockId.value) return
  const index = lines.value.findIndex(
    (line) => line.blockId === activeBlockId.value && line.kind === 'block-head',
  )
  if (index >= 0) paneRef.value?.scrollTo(index + 1)
}

/* ------------------------------------------------------------------ 块 */

function onCreateBlock() {
  const block = createBlock(requireDoc(), `块 ${blocks.value.length + 1}`)
  expanded.value = { ...expanded.value, [block.id]: true }
  activeBlockId.value = block.id
  touch()
  toast.info('已新建块，往里加域名吧')
}

function onToggleBlock(block: Block) {
  setBlockEnabled(requireDoc(), block.id, !block.enabled)
  touch()
}

function onRenameBlock(block: Block, name: string) {
  renameBlock(requireDoc(), block.id, name)
  touch()
}

function onMoveBlock(block: Block, delta: number) {
  moveBlock(requireDoc(), block.id, delta)
  touch()
}

function onRemoveBlock(block: Block) {
  const count = block.body.lines.filter((line) => line.kind === 'entry').length
  if (count && !window.confirm(`「${block.name}」里有 ${count} 条记录，一起删掉？（保存后才写进系统）`)) return
  const removed = removeBlock(requireDoc(), block.id)
  if (!removed) return
  undoStack.value = [...undoStack.value, { kind: 'block', data: removed }]
  if (activeBlockId.value === block.id) activeBlockId.value = blocks.value[0]?.id ?? null
  touch()
  toast.info(`已删除块「${block.name}」，可 ${modLabel}Z 撤销`)
}

function onExpandBlock(block: Block) {
  expanded.value = { ...expanded.value, [block.id]: !expanded.value[block.id] }
  activeBlockId.value = block.id
  if (expanded.value[block.id]) scrollToActive()
}

function onPickBlock(blockId: string | null) {
  if (!blockId) return
  activeBlockId.value = blockId
  expanded.value = { ...expanded.value, [blockId]: true }
}

/** 一搜索就把命中的块自动展开 + 高亮，否则用户还得挨个点开找那一条 */
watch(query, (value) => {
  const d = doc.value
  if (!d || !value.trim()) return
  const next = { ...expanded.value }
  let first: string | null = null
  for (const block of d.blocks) {
    if (!blockMatches(block, value)) continue
    next[block.id] = true
    first = first ?? block.id
  }
  expanded.value = next
  if (first) activeBlockId.value = first
  if (outside.value.some((line) => matchesQuery(line, value))) outsideOpen.value = true
})

/* ------------------------------------------------------------ 条目操作 */

/** 新增条目落到哪个块：优先当前选中的块，没有块就建一个「我的条目」 */
function entryTarget(): string {
  const d = requireDoc()
  const active = activeBlockId.value && blockById(d, activeBlockId.value) ? activeBlockId.value : undefined
  return active ?? blocks.value[0]?.id ?? createBlock(d, '我的条目').id
}

function onCreateEntry() {
  const targetId = entryTarget()
  expanded.value = { ...expanded.value, [targetId]: true }
  activeBlockId.value = targetId
  editing.value = { line: null, outsideId: null, preset: null, fromBlockId: targetId, defaultTarget: targetId }
  touch()
}

function onAddEntry(block: Block) {
  activeBlockId.value = block.id
  editing.value = { line: null, outsideId: null, preset: null, fromBlockId: block.id, defaultTarget: block.id }
}

function onPasteTo(block: Block) {
  activeBlockId.value = block.id
  showPaste.value = true
}

function onEditEntry(block: Block, line: EntryLine) {
  editing.value = { line, outsideId: null, preset: null, fromBlockId: block.id, defaultTarget: block.id }
}

/** 区外条目：收进某个块（字段可以顺手改） */
function onAdoptEntry(line: EntryLine) {
  editing.value = {
    line: null,
    outsideId: line.id,
    preset: { ip: line.ip, names: [...line.names], comment: line.comment, disabled: line.disabled },
    fromBlockId: null,
    defaultTarget: defaultTarget.value,
  }
}

function onToggleEntry(block: Block, line: EntryLine) {
  updateBlockEntry(requireDoc(), block.id, line.id, { disabled: !line.disabled })
  touch()
}

function onRemoveEntry(block: Block, line: EntryLine) {
  if (isProtectedEntry(line) && !window.confirm(`「${line.names.join(' ')}」是本机解析要用的系统记录，确定删除？`)) {
    return
  }
  const removed = removeBlockEntry(requireDoc(), block.id, line.id)
  if (!removed) return
  undoStack.value = [...undoStack.value, { kind: 'entry', data: removed }]
  touch()
  toast.info(`已删除，可用 ${modLabel}Z 撤销`)
}

function onDialogRemove() {
  const ctx = editing.value
  editing.value = null
  if (!ctx?.line || !ctx.fromBlockId) return
  const block = blockById(requireDoc(), ctx.fromBlockId)
  if (block) onRemoveEntry(block, ctx.line)
}

function undo() {
  const d = doc.value
  const item = undoStack.value[undoStack.value.length - 1]
  if (!d || !item) return
  if (item.kind === 'entry') restoreBlockEntry(d, item.data)
  else if (item.kind === 'block') restoreBlock(d, item.data)
  else {
    d.blocks = item.data.blocks
    const first = item.data.blocks[0]
    expanded.value = first ? { [first.id]: true } : {}
    activeBlockId.value = first?.id ?? null
  }
  undoStack.value = undoStack.value.slice(0, -1)
  touch()
  toast.info('已撤销')
}

/* ---------------------------------------------------------- 批量编辑托管区 */

/** 把整个托管区丢进文本框改（多块重排 / 整段粘贴比逐块点更快） */
function openRegionEditor() {
  const d = doc.value
  if (!d) return
  regionText.value = renderRegion(d)
  showRegionEditor.value = true
}

function submitRegionEditor(payload: { blocks: Block[] }) {
  const d = doc.value
  if (!d) return
  showRegionEditor.value = false
  // 整批换掉，压一份撤销（⇧⌘Z 能整个换回来）
  undoStack.value = [...undoStack.value, { kind: 'region', data: { blocks: d.blocks } }]
  d.blocks = payload.blocks
  const first = payload.blocks[0]
  expanded.value = first ? { [first.id]: true } : {}
  activeBlockId.value = first?.id ?? null
  touch()
  toast.ok(`托管区已替换为 ${payload.blocks.length} 个块，别忘了保存`)
}

async function submitEntry(payload: { fields: EntryFields; target: AdoptTarget }) {
  const d = doc.value
  const ctx = editing.value
  if (!d || !ctx) return
  editing.value = null

  if (ctx.line && ctx.fromBlockId) {
    // 编辑块内条目：先落字段，再按需要换块
    updateBlockEntry(d, ctx.fromBlockId, ctx.line.id, payload.fields)
    moveEntryTo(d, ctx.fromBlockId, ctx.line.id, payload.target)
    touch()
    return
  }

  if (ctx.outsideId) {
    // 区外条目收进块：搬进去 + 记下「写盘时把区外那一行删掉」
    const adopted = adoptOutsideEntry(d, ctx.outsideId, payload.target)
    if (adopted) {
      outsideRemovals.value = [...outsideRemovals.value, adopted.raw]
      const owner = locateEntry(d, adopted.entry.id)
      if (owner) {
        updateBlockEntry(d, owner.block.id, adopted.entry.id, payload.fields)
        expanded.value = { ...expanded.value, [owner.block.id]: true }
        activeBlockId.value = owner.block.id
      }
      toast.ok('已收进托管区，别忘了保存')
    }
    touch()
    return
  }

  const targetId = resolveTargetBlock(d, payload.target)
  addBlockEntries(d, targetId, [payload.fields])
  expanded.value = { ...expanded.value, [targetId]: true }
  activeBlockId.value = targetId
  touch()
}

function moveEntryTo(d: BlocksDoc, fromBlockId: string, entryId: string, target: AdoptTarget) {
  const targetId = resolveTargetBlock(d, target)
  if (targetId === fromBlockId) return
  const removed = removeBlockEntry(d, fromBlockId, entryId)
  const block = blockById(d, targetId)
  if (!removed || !block) return
  block.body.lines.push(removed.line)
  expanded.value = { ...expanded.value, [targetId]: true }
  activeBlockId.value = targetId
}

/** 外部条目全部收进一个新的块（系统回环行留在外面） */
function onAdoptAll() {
  const list = adoptableOutside.value
  if (!list.length) return
  const d = requireDoc()
  const block = createBlock(d, freeBlockName(d, '外部条目'))
  const raws: string[] = []
  for (const line of list) {
    const taken = takeOutsideEntry(d, line.id)
    if (!taken) continue
    addBlockEntries(d, block.id, [taken.fields])
    raws.push(taken.raw)
  }
  outsideRemovals.value = [...outsideRemovals.value, ...raws]
  expanded.value = { ...expanded.value, [block.id]: true }
  activeBlockId.value = block.id
  touch()
  toast.ok(`已收进「${block.name}」，点块名可以改名；别忘了保存`)
}

/** 重名的块名加个序号，别让两个块长得一模一样 */
function freeBlockName(d: BlocksDoc, base: string): string {
  const names = new Set(d.blocks.map((b) => b.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!names.has(candidate)) return candidate
  }
}

async function submitPaste(payload: { entries: EntryFields[]; target: AdoptTarget }) {
  const d = doc.value
  if (!d) return
  showPaste.value = false
  const targetId = resolveTargetBlock(d, payload.target)
  addBlockEntries(d, targetId, payload.entries)
  expanded.value = { ...expanded.value, [targetId]: true }
  activeBlockId.value = targetId
  touch()
  toast.ok(`已导入 ${payload.entries.length} 条，别忘了点保存`)
}

/* ------------------------------------------------------------ 写入权限 */

/**
 * 免授权写入（ACL）的状态查询与开关。
 *
 * 系统 hosts 属 root，默认每写一次弹一次授权框。一次性把文件的写权限
 * 授给当前账户之后就是直写（原理见 lib.rs 的同名小节）。
 * grant / revoke 会走系统授权框，超时给足；成功后同步 `fileInfo.writable`，
 * 顶栏 chip 与保存流程立刻看到新状态。
 */
async function runPermission(action: PermissionAction): Promise<HostsPermissionResult | null> {
  if (demoMode.value) {
    toast.info('演示模式：不会改动系统权限')
    return null
  }
  if (action !== 'status') permissionBusy.value = true
  const res = (await exec
    .run({ command: 'hosts-permission', args: { action }, timeoutMs: WRITE_TIMEOUT })
    .catch(() => null)) as HostsPermissionResult | null
  if (action !== 'status') permissionBusy.value = false

  if (!res) {
    toast.err('权限命令没有响应（宿主里可能还是旧版本的插件）')
    return null
  }
  permission.value = res
  if (fileInfo.value && fileInfo.value.writable !== res.writable) {
    fileInfo.value = { ...fileInfo.value, writable: res.writable }
  }
  if (!res.ok) {
    toast.err(res.error ?? '权限操作失败')
    return res
  }
  return res
}

async function openPermission() {
  showPermission.value = true
  await runPermission('status')
}

async function onGrantPermission() {
  const res = await runPermission('grant')
  if (!res?.ok) return
  toast.ok('已开启免授权写入，以后保存不再弹授权窗口')
  showPermission.value = false
}

async function onRevokePermission() {
  const res = await runPermission('revoke')
  if (!res?.ok) return
  toast.ok('已恢复系统默认权限')
  if (res.writable) toast.info('文件仍可写：这份权限来自系统设置，不是本插件开的')
}

/* ------------------------------------------------------------------ 保存 */

async function openSave() {
  if (!doc.value || !dirty.value) {
    if (!dirty.value) toast.info('没有需要保存的改动')
    return
  }
  nextText.value = finalText.value
  writeResult.value = null
  savePhase.value = 'preview'
  showSave.value = true
}

/** 存档存的是**托管区文本**：区外的行不归我们，也就没必要存 */
async function addAutoSnapshot(region: string, entryCount: number) {
  const now = new Date()
  snapshots.value = pushSnapshot(snapshots.value, {
    name: `写入前 · ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
    kind: 'auto',
    content: region,
    entries: entryCount,
  })
  await persistSnapshots(snapshots.value)
}

async function confirmWrite(payload: { remember?: boolean } = {}) {
  const d = doc.value
  if (!d) return
  const beforeRegion = splitRegion(diskText.value).region
  const entryCount = stats.value.entries
  savePhase.value = 'writing'

  // 「以后不再询问」：先用一次系统授权把写权限授给当前账户（ACL），
  // 这次写入就已经是直写，之后保存也不再弹窗。用户在授权框里取消 → 停在预览。
  if (payload.remember && !demoMode.value && !fileInfo.value?.writable) {
    const granted = await runPermission('grant')
    if (!granted?.ok) {
      savePhase.value = 'preview'
      return
    }
  }

  const res = (await exec
    .run({
      command: 'hosts-write',
      args: { region: renderRegion(d), remove: outsideRemovals.value },
      timeoutMs: WRITE_TIMEOUT,
    })
    .catch(() => null)) as HostsWriteResult | null

  if (!res) {
    // 演示模式：留个快照，让用户至少能带走内容
    await addAutoSnapshot(beforeRegion, entryCount)
    showSave.value = false
    savePhase.value = 'done'
    toast.info('演示模式：内容未写入系统文件')
    return
  }

  writeResult.value = res

  if (res.ok) {
    await addAutoSnapshot(beforeRegion, entryCount)
    showSave.value = false
    savePhase.value = 'done'
    toast.ok(res.method === 'privileged' ? '已通过管理员授权写入' : '已写入系统')
    await reload()
    return
  }

  if (res.method === 'manual') {
    // 内容已落盘，只差用户执行一条命令
    await addAutoSnapshot(beforeRegion, entryCount)
    savePhase.value = 'manual'
    return
  }

  showSave.value = false
  savePhase.value = 'done'
  toast.err(res.error ?? '写入失败')
}

/* ------------------------------------------------------------------ 快照 */

async function saveSnapshot(name: string) {
  const d = doc.value
  if (!d) return
  snapshots.value = pushSnapshot(snapshots.value, {
    name,
    kind: 'manual',
    content: renderRegion(d),
    entries: stats.value.entries,
  })
  await persistSnapshots(snapshots.value)
  toast.ok('已存档')
}

async function loadSnapshot(snap: Snapshot) {
  const d = doc.value
  if (!d) return
  const restored = blocksFromArchive(snap.content, d.eol, d.sep, `存档 · ${snap.name}`)
  if (!restored.length) {
    toast.err('这份存档里没有可用的块')
    return
  }
  d.blocks = restored
  expanded.value = { [restored[0].id]: true }
  activeBlockId.value = restored[0].id
  showSnapshots.value = false
  touch()
  toast.info('已载入到编辑器，点保存才会写入系统')
}

async function dropSnapshot(id: string) {
  snapshots.value = removeSnapshot(snapshots.value, id)
  await persistSnapshots(snapshots.value)
}

/* ------------------------------------------------------------------ 其它 */

async function copyPath() {
  if (await copyText(path.value)) toast.ok('路径已复制')
}

async function copyFinal() {
  if (await copyText(finalText.value)) toast.ok('已复制最终内容')
}
</script>

<template>
  <AppShell>
    <!-- 顶栏 -->
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <span class="text-accent"><UiIcon name="server" :size="15" /></span>
      <span class="shrink-0 text-[13px] font-semibold">Hosts 管家</span>

      <button class="launcher-chip max-w-[170px] truncate" :title="path" @click="copyPath">
        <UiIcon name="file" :size="11" />
        {{ path }}
      </button>

      <span v-if="demoMode" class="launcher-chip text-warn" title="没检测到启动台宿主，改动不会写进系统文件">
        <UiIcon name="alert" :size="11" /> 演示模式
      </span>
      <button
        v-else-if="fileInfo"
        class="launcher-chip"
        :class="fileInfo.writable ? '' : 'text-warn'"
        :title="
          fileInfo.writable
            ? '保存时直接写入、不再弹授权窗口；点开可管理权限'
            : '保存时需要管理员授权；点开可开启免授权写入'
        "
        @click="openPermission"
      >
        <UiIcon :name="fileInfo.writable ? 'unlock' : 'lock'" :size="11" />
        {{ fileInfo.writable ? '免授权' : '需授权' }}
      </button>

      <div class="relative min-w-0 flex-1">
        <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint">
          <UiIcon name="search" :size="13" />
        </span>
        <input ref="searchRef" v-model="query" class="launcher-input pl-7" :placeholder="placeholder" />
      </div>

      <button class="launcher-btn" title="新建块（⇧⌘N）" @click="onCreateBlock">
        <UiIcon name="plus" :size="12" /> 新建块
      </button>
      <button class="launcher-btn" title="批量编辑托管区（文本，支持整段粘贴）" @click="openRegionEditor">
        <UiIcon name="pencil" :size="12" /> 批量编辑
      </button>
      <button class="launcher-btn" title="存档与回滚" @click="showSnapshots = true">
        <UiIcon name="history" :size="13" />
      </button>
      <button class="launcher-btn" title="重新读取系统文件" @click="reload(true)">
        <UiIcon name="refresh" :size="13" />
      </button>
    </header>

    <!-- 左右分屏：左 = 块，右 = 最终 hosts -->
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-[300px] shrink-0 flex-col border-r border-line">
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[11.5px] text-muted">
          <span>托管块</span>
          <span class="text-faint">{{ stats.blocks }}</span>
          <div class="flex-1" />
          <span v-if="query.trim()" class="text-faint">正在过滤</span>
        </div>

        <div class="launcher-scroll min-h-0 flex-1">
          <div class="flex flex-col gap-1.5 p-2">
            <div v-if="loading" class="py-6 text-center text-[12.5px] text-muted">正在读取…</div>

            <template v-else>
              <OutsideCard
                v-if="outside.length || stats.outsideRaw"
                :entries="outside"
                :raw="stats.outsideRaw"
                :query="query"
                :expanded="outsideOpen"
                :conflicts="conflicts"
                :version="version"
                @expand="outsideOpen = !outsideOpen"
                @adopt="onAdoptEntry"
                @adopt-all="onAdoptAll"
              />

              <BlockCard
                v-for="(block, i) in blocks"
                :key="block.id"
                :block="block"
                :tint="i % 6"
                :query="query"
                :expanded="!!expanded[block.id]"
                :active="activeBlockId === block.id"
                :can-up="i > 0"
                :can-down="i < blocks.length - 1"
                :conflicts="conflicts"
                :version="version"
                @expand="onExpandBlock(block)"
                @toggle="onToggleBlock(block)"
                @rename="(name) => onRenameBlock(block, name)"
                @remove="onRemoveBlock(block)"
                @move="(delta) => onMoveBlock(block, delta)"
                @add-entry="onAddEntry(block)"
                @paste="onPasteTo(block)"
                @edit="(line) => onEditEntry(block, line)"
                @toggle-entry="(line) => onToggleEntry(block, line)"
                @remove-entry="(line) => onRemoveEntry(block, line)"
              />

              <div
                v-if="!blocks.length"
                class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-linestrong px-4 py-5 text-center"
              >
                <UiIcon name="folder" :size="20" class="text-faint" />
                <div class="text-[12.5px] font-semibold">还没有托管块</div>
                <div class="text-[11.5px] leading-relaxed text-muted">
                  一个项目一个块：域名放进去，整块随时开关。<br />保存时只改这一块，别的程序写的行不碰。
                </div>
                <div class="mt-1 flex items-center gap-1.5">
                  <button class="launcher-btn primary" @click="onCreateBlock">
                    <UiIcon name="plus" :size="12" /> 新建块
                  </button>
                  <button v-if="adoptableOutside.length" class="launcher-btn" @click="onAdoptAll">
                    把外部条目收进来
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </aside>

      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[11.5px] text-muted">
          <span>最终 hosts 文件</span>
          <span class="launcher-chip">{{ lines.length }} 行</span>
          <span v-if="diffCount.added" class="launcher-chip text-addfg" title="相对磁盘上那份新增的行">
            +{{ diffCount.added }}
          </span>
          <span v-if="diffCount.removed" class="launcher-chip text-delfg" title="相对磁盘上那份删掉的行">
            −{{ diffCount.removed }}
          </span>
          <span v-if="dirty" class="launcher-chip text-warn">未保存</span>
          <span v-else-if="!loading" class="launcher-chip">与磁盘一致</span>
          <div class="flex-1" />
          <button class="launcher-btn ghost" title="复制完整内容" @click="copyFinal">
            <UiIcon name="copy" :size="12" />
          </button>
        </div>

        <FilePane
          ref="paneRef"
          :lines="lines"
          :marks="marks"
          :active-block-id="activeBlockId"
          @pick-block="onPickBlock"
        />
      </section>
    </div>

    <!-- 底栏 -->
    <div class="flex h-8 shrink-0 items-center gap-3 border-t border-line px-3 text-[11.5px] text-muted">
      <span>
        {{ stats.blocks }} 块 · {{ stats.entries }} 条<span v-if="stats.disabled">（{{ stats.disabled }} 条不生效）</span>
        <template v-if="stats.outside"> · 外部 {{ stats.outside }} 条</template>
      </span>
      <span v-if="conflicts.size" class="text-warn" title="同一个域名被分配了多个 IP，hosts 只会以先出现的为准">
        <UiIcon name="alert" :size="11" class="mr-1 inline" />
        {{ conflicts.size }} 个域名指向了多个 IP
      </span>
      <div class="flex-1" />
      <span v-if="fileInfo && fileInfo.encoding === 'binary'" class="text-warn">文件不是 UTF-8，中文可能显示异常</span>
      <button v-if="undoStack.length" class="launcher-btn" @click="undo">
        <UiIcon name="history" :size="12" /> 撤销 ({{ undoStack.length }})
      </button>
      <span class="text-faint">{{ modLabel }}N 新增 · {{ modLabel }}S 保存 · {{ modLabel }}F 搜索</span>
      <button class="launcher-btn primary" :disabled="!dirty" @click="openSave">
        <UiIcon name="save" :size="12" /> 保存
      </button>
    </div>

    <EntryDialog
      v-if="editing"
      :line="editing.line"
      :preset="editing.preset"
      :from-block-id="editing.fromBlockId"
      :blocks="blockBriefs"
      :default-target="editing.defaultTarget"
      @close="editing = null"
      @submit="submitEntry"
      @remove="onDialogRemove"
    />

    <PasteDialog
      v-if="showPaste"
      :blocks="blockBriefs"
      :default-target="defaultTarget"
      @close="showPaste = false"
      @submit="submitPaste"
    />

    <RegionEditorDialog
      v-if="showRegionEditor"
      :region="regionText"
      :eol="editorEol"
      :sep="editorSep"
      @close="showRegionEditor = false"
      @submit="submitRegionEditor"
    />

    <PermissionDialog
      v-if="showPermission"
      :platform="platform"
      :path="path"
      :writable="!!fileInfo?.writable"
      :granted="aclGranted"
      :username="permission?.username"
      :command="permission?.command"
      :busy="permissionBusy"
      :error="permission && !permission.ok ? permission.error ?? null : null"
      @close="showPermission = false"
      @grant="onGrantPermission"
      @revoke="onRevokePermission"
    />

    <SnapshotDialog
      v-if="showSnapshots"
      :snapshots="snapshots"
      :current-entries="stats.entries"
      @close="showSnapshots = false"
      @save="saveSnapshot"
      @load="loadSnapshot"
      @remove="dropSnapshot"
    />

    <SaveDialog
      v-if="showSave"
      :prev-text="diskText"
      :next-text="nextText"
      :path="path"
      :writable="!!fileInfo?.writable || demoMode"
      :platform="platform"
      :phase="savePhase"
      :result="writeResult"
      @close="showSave = false"
      @confirm="confirmWrite"
    />
  </AppShell>
</template>
