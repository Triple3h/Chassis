<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useToast } from '@launcher/ui/toast'
import { copyText, downloadBlob, fileFromDataTransfer, pickFile } from '@launcher/ui/clipboard'
import { hostUi, storage } from '@launcher/api'
import { isTypingTarget, isMod, modLabel } from '@launcher/ui/keys'
import { useTheme } from '@launcher/ui/theme'
import type { FormatOptions, FormatResult, IndentOption } from './core/format'
import { runBuildTree, runFormat } from './core/runner'
import type { FlatTree } from './core/tree'
import { escapeUnicode, unescapeUnicode } from './core/unicode'
import { addEscape, removeEscape } from './core/escape'
import { addHistoryEntry, HISTORY_KEY, sanitizeHistory, type HistoryEntry } from './core/history'
import JsonEditor from './components/JsonEditor.vue'
import ToolMenu from './components/ToolMenu.vue'
import TreePane from './components/TreePane.vue'
import HistoryDialog from './components/HistoryDialog.vue'

const MAX_TREE_CHARS = 4_000_000
/** 子标签页上限：再多标签栏就装不下了（横向滚动比「关掉几个」更难用） */
const MAX_TABS = 8
/**
 * 编辑停下来多久之后把这份文档记进历史。
 *
 * 为什么不挂在「关闭 / 离开」上：插件页是 iframe，宿主卸载它时本页没有任何生命周期钩子
 * （DOM 一移除，JS 就没了），只有空闲点落盘这一条路可靠。
 */
const HISTORY_SETTLE_MS = 2500

interface EditorHandle {
  replaceAll: (text: string) => void
  scrollToLine: (line: number) => void
  foldAll: () => void
  unfoldAll: () => void
  focus: () => void
}
interface TreeHandle {
  expandAll: () => void
  collapseAll: () => void
  copyValue: () => void
  copyPath: () => void
  revealSelected: () => void
}

/**
 * 一个标签页 = 一份独立文档 + 它自己的格式化选项。
 * 「字号 / 行号 / 分栏比例」是视图偏好，不在这里 —— 那些全局共享（见 §TAB 独立）。
 */
interface JsonTab {
  id: string
  title: string
  source: string
  result: FormatResult | null
  tree: FlatTree | null
  treeIssue: string
  /** 换了一份新文档：树视图据此复位展开与滚动 */
  docEpoch: number
  /** 从树里定位过来、编辑器里需要高亮的行（1 起，0 = 无） */
  hitLine: number
  indent: IndentOption
  minify: boolean
  sortKeys: boolean
  busy: boolean
  /** 计算代次：迟到的结果不许覆盖新一次输入 */
  job: number
}

const indentOptions: { v: IndentOption; t: string }[] = [
  { v: 1, t: '1 空格' },
  { v: 2, t: '2 空格' },
  { v: 3, t: '3 空格' },
  { v: 4, t: '4 空格' },
  { v: 'tab', t: 'Tab' },
]
const fontSizes = [12, 13, 14, 15, 16, 18, 20]

/** 文本级变换（工具条下拉 / 宿主「更多」菜单共用） */
type TransformId = 'zh' | 'zhBack' | 'nonAscii' | 'addEscape' | 'stripEscape'

const TXT_LABEL: Record<TransformId, string> = {
  zh: '中文转Unicode',
  zhBack: 'Unicode转中文',
  nonAscii: '转义非 ASCII',
  addEscape: '添加 \\ 转义',
  stripEscape: '去除 \\ 转义',
}

/** bejson 的 `Unicode ▾` 菜单 */
const unicodeItems = [
  { id: 'zh', label: '中文转Unicode' },
  { id: 'zhBack', label: 'Unicode转中文' },
]
/** bejson 的 `\ 转义 ▾` 菜单 */
const escapeItems = [
  { id: 'addEscape', label: '添加 \\ 转义' },
  { id: 'stripEscape', label: '去除 \\ 转义' },
]
/** 顶栏「文件」下拉：打开 / 导出都在这里（顶栏不再放别的控件） */
const fileItems = [
  { id: 'open', label: '打开文件…' },
  { id: 'export', label: '导出 JSON' },
]

/* ------------------------------------------------------------------ 标签页 */

/** 本次运行的唯一前缀：owner 跨运行不重复，旧历史不会被新会话的同名 tab 顶掉 */
const RUN = Math.random().toString(36).slice(2, 7)
let tabSeq = 0

function makeTab(title = ''): JsonTab {
  tabSeq++
  return {
    id: `${RUN}-${tabSeq}`,
    title: title || `JSON ${tabSeq}`,
    source: '',
    result: null,
    tree: null,
    treeIssue: '',
    docEpoch: 0,
    hitLine: 0,
    indent: 2,
    minify: false,
    sortKeys: false,
    busy: false,
    job: 0,
  }
}

const tabs = ref<JsonTab[]>([makeTab()])
const activeId = ref(tabs.value[0]!.id)
/** 永远至少有一个标签页（关掉最后一个 = 清空它） */
const cur = computed<JsonTab>(() => tabs.value.find((t) => t.id === activeId.value) ?? tabs.value[0]!)

/** 每页一个节流/防抖计时器（按 id 存，删页时清掉） */
const timers = new Map<string, number>()
const histTimers = new Map<string, number>()
const editorRefs = new Map<string, EditorHandle>()
const treeRefs = new Map<string, TreeHandle>()

function bindRef<T>(map: Map<string, T>, id: string, el: unknown): void {
  if (el) map.set(id, el as T)
  else map.delete(id)
}

const fontSize = ref(14)
const showLineNumbers = ref(true)
const split = ref(46)
const wrapRef = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const toast = useToast()
// 主题仍按「宿主 ?theme= → data-theme → 系统」跟随，只是不再提供页内手动切换按钮
useTheme()

/* ---------------------------------------------------------------- 计算调度 */

function optsOf(tab: JsonTab): FormatOptions {
  return { indent: tab.indent, minify: tab.minify, sortKeys: tab.sortKeys }
}

async function compute(tab: JsonTab, immediate = false) {
  clearTimeout(timers.get(tab.id))
  const run = async () => {
    const text = tab.source
    const mine = ++tab.job
    if (!text.trim()) {
      tab.result = null
      tab.tree = null
      return
    }
    tab.busy = true
    const res = await runFormat(text, optsOf(tab))
    if (mine !== tab.job) return
    tab.result = res
    tab.hitLine = 0
    tab.busy = false
    void refreshTree(tab, mine)
    // 解析通过才算「一份成型的 JSON」：编辑途中的半成品不进历史
    if (res.ok) scheduleHistory(tab)
  }
  if (immediate) await run()
  else timers.set(tab.id, setTimeout(run, 160) as unknown as number)
}

/**
 * 树基于「格式化输出」构建（不是原始输入）：这样节点偏移与编辑器里的文本一一对应，
 * 树上的行内编辑也能直接在这个文本上做最小替换。
 */
async function refreshTree(tab: JsonTab, mine: number) {
  const res = tab.result
  if (!res?.ok) {
    tab.tree = null
    return
  }
  const text = res.output
  if (text.length > MAX_TREE_CHARS) {
    tab.tree = null
    tab.treeIssue = `内容过大（${text.length.toLocaleString()} 字符），已停用树视图`
    return
  }
  tab.treeIssue = ''
  const built = await runBuildTree(text, { maxNodes: 300_000 })
  if (mine !== tab.job) return
  tab.tree = built
}

/**
 * 树上的编辑（改键 / 改值 / 增删成员）已经把结果文本算好了 —— 直接换掉文档，
 * 不再走「原始输入」那一层：此时用户改的就是这份 JSON 本身（与 bejson 同款语义）。
 */
function onTreeEdit(text: string) {
  setSource(cur.value, text)
}

/** 编辑器里的输入（每页一台编辑器，`v-model` 换成显式写法才能带上是哪一页） */
function onInput(tab: JsonTab, text: string) {
  tab.source = text
  void compute(tab)
}

/**
 * 换一份文档：树视图复位（docEpoch）并立即重算。
 * 历史由计算成功那条路（`scheduleHistory`）落，这里不多写一遍。
 */
function setSource(tab: JsonTab, text: string) {
  tab.source = text
  tab.docEpoch++
  void compute(tab, true)
}

/* ------------------------------------------------------------------ 历史 */

const history = ref<HistoryEntry[]>([])

async function loadHistory() {
  let raw: unknown
  try {
    raw = await storage.get(HISTORY_KEY)
  } catch {
    // 不在启动台里（浏览器直开 dev server）：退回 localStorage，界面照样可用
    raw = readLocalHistory()
  }
  history.value = sanitizeHistory(raw)
}

function readLocalHistory(): unknown {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null')
  } catch {
    return null
  }
}

async function persistHistory() {
  // 别把 reactive 代理交给宿主（结构化克隆会抛 DataCloneError）
  const plain = history.value.map((e) => ({ ...e }))
  try {
    await storage.set(HISTORY_KEY, plain)
  } catch {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(plain))
    } catch {
      /* 隐私模式 / 配额满：历史只在本次运行有效 */
    }
  }
}

/** 记一份档（同一标签页写的是同一条：编辑过程中不会把历史刷满半成品） */
function saveHistory(tab: JsonTab) {
  clearTimeout(histTimers.get(tab.id))
  if (!tab.result?.ok || !tab.source.trim()) return
  const next = addHistoryEntry(history.value, {
    id: `${tab.id}-${Date.now()}`,
    owner: tab.id,
    at: Date.now(),
    text: tab.source,
  })
  if (next === history.value) return
  history.value = next
  void persistHistory()
}

function scheduleHistory(tab: JsonTab) {
  clearTimeout(histTimers.get(tab.id))
  histTimers.set(tab.id, setTimeout(() => saveHistory(tab), HISTORY_SETTLE_MS) as unknown as number)
}

function pickHistory(entry: HistoryEntry) {
  historyOpen.value = false
  loadInto(entry.text)
}

function removeHistory(id: string) {
  history.value = history.value.filter((e) => e.id !== id)
  void persistHistory()
}

function clearHistory() {
  history.value = []
  void persistHistory()
  toast.info('历史记录已清空')
}

/* ------------------------------------------------------------- 标签页操作 */

function activate(id: string) {
  if (activeId.value === id) return
  saveHistory(cur.value)
  activeId.value = id
  void nextTick(() => editorRefs.get(id)?.focus())
}

function newTab(title = ''): JsonTab {
  const tab = makeTab(title)
  tab.indent = cur.value.indent // 新页沿用当前页的缩进选择
  tabs.value.push(tab)
  activate(tab.id)
  return tab
}

function closeTab(id: string) {
  const tab = tabs.value.find((t) => t.id === id)
  if (!tab) return
  saveHistory(tab)
  if (tabs.value.length === 1) {
    // 最后一个：清空而不是删掉 —— 界面上始终留着一页
    setSource(tab, '')
    toast.info('已清空')
    return
  }
  const at = tabs.value.indexOf(tab)
  tabs.value.splice(at, 1)
  clearTimeout(timers.get(id))
  clearTimeout(histTimers.get(id))
  timers.delete(id)
  histTimers.delete(id)
  editorRefs.delete(id)
  treeRefs.delete(id)
  if (activeId.value === id) {
    const next = tabs.value[Math.min(at, tabs.value.length - 1)]
    if (next) activeId.value = next.id
  }
}

/** 把一份新文档放进界面：当前页空着就占它，否则开新页（已到上限就地覆盖） */
function loadInto(text: string, title = '') {
  const tab = cur.value
  if (!tab.source.trim()) {
    if (title) tab.title = title
    setSource(tab, text)
    return
  }
  if (tabs.value.length < MAX_TABS) {
    setSource(newTab(title), text)
    return
  }
  toast.info(`已有 ${MAX_TABS} 个标签页，就地覆盖当前页`)
  if (title) tab.title = title
  setSource(tab, text)
}

/* ------------------------------------------------------------------- 交互 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function looksLikeJson(text: string): boolean {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[') || t.startsWith('"{') || t.startsWith("'")
}

function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, 24)
}

async function openFile() {
  const file = await pickFile('application/json,.json,.jsonc,.txt,text/plain')
  if (!file) return
  loadInto(await file.text(), fileTitle(file.name))
}

function onFileAction(id: string) {
  if (id === 'open') void openFile()
  else download()
}

function copyOutput() {
  if (!output.value) return
  void copyText(output.value).then((ok) => (ok ? toast.ok('已复制结果') : toast.err('复制失败，请手动选择')))
}

function download() {
  const tab = cur.value
  const text = tab.result?.output ?? ''
  if (!text) {
    toast.info('先输入有效的 JSON')
    return
  }
  const name = /^JSON \d+$/.test(tab.title) ? 'formatted.json' : `${tab.title.replace(/[\\/:*?"<>|]/g, '-')}.json`
  downloadBlob(name, text, 'application/json;charset=utf-8')
  toast.ok(`已导出 ${name}`)
}

function clearAll() {
  setSource(cur.value, '')
  toast.info('已清空当前标签页')
}

/* ------------------------------------------------- 原地改写文档（对齐 bejson） */

/** 把文本写回文档本身：走编辑器就能保留撤销栈（⌘Z 能退回改之前的原文） */
function replaceDoc(tab: JsonTab, text: string) {
  const ed = editorRefs.get(tab.id)
  if (ed) ed.replaceAll(text)
  else setSource(tab, text)
}

/**
 * 格式化 / 压缩 / 改缩进 / 改排序统一走这里：结果**原地改写编辑器里的文档**，
 * 而不是只换个右栏预览。右栏仍留一份结果视图，但文档自始至终只有一份。
 *
 * 这里刻意自己算一遍、直接用返回值，而不是改完选项再读 `result`：
 * 改选项会触发另一次计算，把 `job` 顶掉，读到的可能是上一份结果
 * ⇒ 判定「已经就是这样」而把这次改写静默吞掉。
 */
async function reformat(mode: 'pretty' | 'minify', announce = '') {
  const tab = cur.value
  const text = tab.source
  if (!text.trim()) {
    toast.info('先输入 JSON')
    return
  }
  const opts: FormatOptions = { indent: tab.indent, minify: mode === 'minify', sortKeys: tab.sortKeys }
  tab.busy = true
  try {
    const res = await runFormat(text, opts)
    tab.result = res
    tab.minify = mode === 'minify'
    if (!res.ok) {
      toast.err('JSON 有语法错误，先修好再改写文档')
      return
    }
    tab.hitLine = 0
    if (res.output === tab.source) {
      if (announce) toast.info(`${announce}：已经就是这样`)
      return
    }
    replaceDoc(tab, res.output)
    saveHistory(tab)
    if (announce) toast.ok(`${announce}（${modLabel}Z 可撤销）`)
  } finally {
    tab.busy = false
  }
}

async function toggleSort() {
  const tab = cur.value
  tab.sortKeys = !tab.sortKeys
  await reformat(tab.minify ? 'minify' : 'pretty', tab.sortKeys ? '已按键名排序' : '已取消排序')
}

/** 缩进是文档属性（每页独立）：改动同样就地重排（bejson 的缩进下拉就是即时重排） */
function setIndent(v: IndentOption, tab: JsonTab = cur.value) {
  tab.indent = v
  tab.minify = false
  if (tab.id === activeId.value) void reformat('pretty')
}

function onIndentPick(e: Event, tab: JsonTab) {
  const raw = (e.target as HTMLSelectElement).value
  setIndent(raw === 'tab' ? 'tab' : (Number(raw) as IndentOption), tab)
}

/** 树视图点「定位」：滚到编辑器里的那一行并高亮 */
function revealLine(line: number) {
  if (!line || line < 1) return
  const tab = cur.value
  tab.hitLine = line
  editorRefs.get(tab.id)?.scrollToLine(line)
}

/**
 * 文本级变换：Unicode 互转（汉字/非 ASCII）与整篇 `\` 转义，全都作用于当前文档文本。
 */
function transform(id: TransformId) {
  const tab = cur.value
  if (!tab.source.trim()) {
    toast.info('先输入 JSON')
    return
  }
  const text = tab.source
  let res: { text: string; changed: number }
  switch (id) {
    case 'zh':
      // 与 bejson 的「中文转Unicode」同范围：只转 [\u4e00-\u9fa5]
      res = escapeUnicode(text, { only: 'cjk' })
      break
    case 'zhBack':
      res = unescapeUnicode(text)
      break
    case 'nonAscii':
      res = escapeUnicode(text)
      break
    case 'addEscape':
      res = addEscape(text)
      break
    default:
      res = removeEscape(text)
      break
  }
  if (!res.changed) {
    toast.info(`${TXT_LABEL[id]}：没有可处理的内容`)
    return
  }
  setSource(tab, res.text)
  toast.ok(`${TXT_LABEL[id]}：已处理 ${res.changed} 处`)
}

const onUnicodeAction = (id: string) => transform(id as TransformId)
const onEscapeAction = (id: string) => transform(id as TransformId)

function onDrop(e: DragEvent) {
  const file = fileFromDataTransfer(e.dataTransfer)
  if (!file) return
  e.preventDefault()
  const name = file instanceof File ? fileTitle(file.name) : ''
  void file.text().then((text) => loadInto(text, name))
}

function startDrag(e: MouseEvent) {
  e.preventDefault()
  const move = (ev: MouseEvent) => {
    const rect = wrapRef.value?.getBoundingClientRect()
    if (!rect) return
    const pct = ((ev.clientX - rect.left) / rect.width) * 100
    split.value = Math.min(78, Math.max(22, pct))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function onKeydown(e: KeyboardEvent) {
  if (isMod(e) && e.key === 'Enter') {
    e.preventDefault()
    void reformat('pretty', '已格式化')
    return
  }
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault()
    void reformat(cur.value.minify ? 'pretty' : 'minify', cur.value.minify ? '已格式化' : '已压缩')
    return
  }
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void toggleSort()
    return
  }
  if (isTypingTarget(e.target)) return
}

/* --------------------------------------------------- 当前页派生值 / 展示 */

function issueOf(tab: JsonTab) {
  return tab.result && !tab.result.ok ? (tab.result.issue ?? null) : null
}

function errorLineOf(tab: JsonTab): number {
  return issueOf(tab)?.line ?? 0
}

/** 错误提示里的指位行：与 bejson 一样用 `----^` 指出出错那一列 */
function caretOf(tab: JsonTab): string {
  return '-'.repeat(Math.max(0, (issueOf(tab)?.column ?? 1) - 1)) + '^'
}

function indentUnitOf(tab: JsonTab): string {
  return tab.indent === 'tab' ? '\t' : ' '.repeat(tab.indent)
}

const output = computed(() => cur.value.result?.output ?? '')
const issue = computed(() => issueOf(cur.value))
const stats = computed(() => cur.value.result?.stats ?? null)
const repaired = computed(() => !!cur.value.result?.repaired)

/* ------------------------------------------------------------- 宿主集成 */

const activeEditor = () => editorRefs.get(cur.value.id)

async function syncFooter() {
  await hostUi.setFooter([
    {
      type: 'button',
      id: 'format',
      label: '格式化',
      icon: 'Check',
      keys: ['Mod+Enter'],
      onClick: () => void reformat('pretty', '已格式化'),
    },
    {
      type: 'action-panel',
      id: 'more',
      label: '更多',
      icon: 'Sliders',
      keys: ['Mod+K'],
      title: 'JSON 操作',
      items: [
        { id: 'newTab', name: '新建标签页', onSelect: () => void newTab() },
        { id: 'history', name: '历史记录…', onSelect: () => (historyOpen.value = true) },
        { id: 'indent1', name: '缩进 1 空格', onSelect: () => setIndent(1) },
        { id: 'indent2', name: '缩进 2 空格', onSelect: () => setIndent(2) },
        { id: 'indent3', name: '缩进 3 空格', onSelect: () => setIndent(3) },
        { id: 'indent4', name: '缩进 4 空格', onSelect: () => setIndent(4) },
        { id: 'indentTab', name: '缩进 Tab', onSelect: () => setIndent('tab') },
        { id: 'ln', name: '显示 / 隐藏行号', onSelect: () => (showLineNumbers.value = !showLineNumbers.value) },
        { id: 'foldAll', name: '折叠全部', onSelect: () => activeEditor()?.foldAll() },
        { id: 'unfoldAll', name: '展开全部', onSelect: () => activeEditor()?.unfoldAll() },
        { id: 'copy', name: '复制结果', onSelect: copyOutput },
        { id: 'zh', name: '中文转Unicode', onSelect: () => transform('zh') },
        { id: 'zhBack', name: 'Unicode转中文', onSelect: () => transform('zhBack') },
        { id: 'addEsc', name: '添加 \\ 转义（塞进字符串用）', onSelect: () => transform('addEscape') },
        { id: 'stripEsc', name: '去除 \\ 转义', onSelect: () => transform('stripEscape') },
        { id: 'nonAscii', name: '转义所有非 ASCII（含 emoji）', onSelect: () => transform('nonAscii') },
        { id: 'clear', name: '清空当前标签页', onSelect: clearAll },
      ],
    },
  ])
}

let stopWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await loadHistory()
  const seed = await hostUi.getSearchContent().catch(() => '')
  if (seed.trim() && looksLikeJson(seed)) {
    void hostUi.clearSearchContent()
    setSource(cur.value, seed)
  }
  stopWatch = hostUi.watchSearchContent((val) => {
    if (looksLikeJson(val)) setSource(cur.value, val)
  })
  void syncFooter()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopWatch?.()
  for (const id of timers.values()) clearTimeout(id)
  for (const id of histTimers.values()) clearTimeout(id)
})
</script>

<template>
  <AppShell>
    <!-- 顶栏：右侧只剩「文件」（打开 / 导出都在它的下拉里） -->
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="braces" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">JSON 工具箱</span>
      <span v-if="cur.busy" class="launcher-chip">计算中…</span>
      <span v-if="repaired" class="launcher-chip" title="严格 JSON 解析失败，已用宽松模式修好">宽松修复</span>

      <div class="ml-auto flex items-center gap-1.5">
        <ToolMenu label="文件" icon="folder" :items="fileItems" @pick="onFileAction" />
      </div>
    </header>

    <!-- 标签栏：每页一份独立文档，可并行开多份（标签多了只滚动标签，新建按钮钉在右端） -->
    <div class="jtabbar">
      <div class="jtablist launcher-scroll">
        <div
          v-for="t in tabs"
          :key="t.id"
          class="jtab"
          :class="{ 'is-active': t.id === activeId }"
          role="tab"
          :aria-selected="t.id === activeId"
          tabindex="0"
          :title="t.title"
          @click="activate(t.id)"
          @keydown.enter.prevent="activate(t.id)"
        >
          <span class="jtab-title">{{ t.title }}</span>
          <button class="jtab-x" title="关闭这个标签页" @click.stop="closeTab(t.id)">
            <UiIcon name="x" :size="11" />
          </button>
        </div>
      </div>

      <button
        class="launcher-btn ghost jtabnew"
        :disabled="tabs.length >= MAX_TABS"
        :title="tabs.length >= MAX_TABS ? `最多 ${MAX_TABS} 个标签页` : '新建标签页'"
        @click="newTab()"
      >
        <UiIcon name="plus" :size="13" />新建
      </button>
    </div>

    <!-- 工具条：全部作用于当前标签页 -->
    <div class="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
      <button class="launcher-btn" :class="{ primary: !cur.minify }" title="格式化并改写文档" @click="reformat('pretty', '已格式化')">
        <UiIcon name="braces" :size="13" />格式化
      </button>
      <button class="launcher-btn" :class="{ primary: cur.minify }" title="压缩成一行并改写文档" @click="reformat('minify', '已压缩')">
        <UiIcon name="minus" :size="13" />压缩
      </button>
      <button class="launcher-btn" :class="{ primary: cur.sortKeys }" title="对象键排序并改写文档" @click="toggleSort">
        <UiIcon name="sortAsc" :size="13" />键排序
      </button>

      <div class="mx-1 h-4 w-px bg-line" />

      <ToolMenu label="Unicode" icon="languages" :items="unicodeItems" @pick="onUnicodeAction" />
      <ToolMenu :label="'\\ 转义'" :items="escapeItems" @pick="onEscapeAction" />

      <div class="mx-1 h-4 w-px bg-line" />

      <button class="launcher-btn ghost" title="复制结果" @click="copyOutput">
        <UiIcon name="copy" :size="13" />复制
      </button>
      <button class="launcher-btn ghost" title="历史记录（最近 20 份 JSON）" @click="historyOpen = true">
        <UiIcon name="history" :size="13" />历史
      </button>
      <button class="launcher-btn ghost" title="清空当前标签页" @click="clearAll">
        <UiIcon name="trash" :size="13" />清空
      </button>
    </div>

    <!-- 主体：每页一份「输入 / 输出」分栏（非当前页只是隐藏，撤销栈与树状态都留着） -->
    <div ref="wrapRef" class="flex min-h-0 flex-1" @drop="onDrop" @dragover.prevent>
      <div v-for="t in tabs" v-show="t.id === activeId" :key="t.id" class="flex min-h-0 min-w-0 flex-1">
        <div class="flex min-w-0 flex-col" :style="{ width: split + '%' }">
          <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
            <span>输入</span>
            <span v-if="t.result?.stats" class="text-faint">{{ t.result.stats.inChars.toLocaleString() }} 字符</span>
            <span class="ml-auto text-faint">{{ modLabel }}Z 撤销 · Tab 缩进 · 可直接拖入 .json 文件</span>
          </div>
          <JsonEditor
            :ref="(el) => bindRef(editorRefs, t.id, el)"
            :model-value="t.source"
            class="min-h-0 flex-1"
            :font-size="fontSize"
            :show-line-numbers="showLineNumbers"
            :indent-unit="indentUnitOf(t)"
            :hit-line="t.hitLine"
            :error-line="errorLineOf(t)"
            @update:model-value="onInput(t, $event)"
          />
        </div>

        <div class="w-px cursor-col-resize bg-line hover:bg-accent" @mousedown="startDrag" />

        <div class="flex min-w-0 flex-1 flex-col">
          <!-- 输出栏工具条：树控件（全展开 / 全折叠 / 字号，对齐 bejson） -->
          <div class="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
            <span class="flex items-center gap-1 text-[11.5px] text-muted">
              <UiIcon name="braces" :size="13" />树视图
            </span>

            <div class="mx-0.5 h-4 w-px bg-line" />

            <button class="launcher-btn ghost" @click="treeRefs.get(t.id)?.expandAll()">全展开</button>
            <button class="launcher-btn ghost" @click="treeRefs.get(t.id)?.collapseAll()">全折叠</button>

            <!-- 缩进是文档属性（每页各记一份），所以跟着本页走 -->
            <select
              class="launcher-input launcher-select jselect"
              title="缩进（本标签页）"
              :value="t.indent"
              @change="onIndentPick($event, t)"
            >
              <option v-for="opt in indentOptions" :key="String(opt.v)" :value="opt.v">{{ opt.t }}</option>
            </select>
            <select v-model.number="fontSize" class="launcher-input launcher-select jselect" title="字号">
              <option v-for="size in fontSizes" :key="size" :value="size">{{ size }}px</option>
            </select>

            <div class="ml-auto flex items-center gap-1">
              <button class="launcher-btn ghost !px-1.5" title="复制选中节点的值" @click="treeRefs.get(t.id)?.copyValue()">
                <UiIcon name="copy" :size="12" />值
              </button>
              <button class="launcher-btn ghost !px-1.5" title="复制选中节点的路径" @click="treeRefs.get(t.id)?.copyPath()">
                <UiIcon name="link" :size="12" />路径
              </button>
              <button class="launcher-btn ghost !px-1.5" title="在编辑器里定位这一行" @click="treeRefs.get(t.id)?.revealSelected()">
                <UiIcon name="external" :size="12" />定位
              </button>
            </div>
          </div>

          <div v-if="issueOf(t)" class="flex items-start gap-2 border-b border-line bg-[color:var(--launcher-del-bg)] px-3 py-2">
            <UiIcon name="alert" :size="14" class="mt-[2px] text-danger" />
            <div class="min-w-0 flex-1 text-[12.5px]">
              <div class="text-danger">
                JSON 格式错误：第 {{ issueOf(t)!.line }} 行 第 {{ issueOf(t)!.column }} 列 —— {{ issueOf(t)!.message }}
              </div>
              <pre v-if="issueOf(t)!.snippet" class="launcher-scroll mt-0.5 overflow-x-auto font-mono text-[11.5px] leading-[16px] text-muted">{{ issueOf(t)!.snippet }}
{{ caretOf(t) }}</pre>
            </div>
          </div>

          <div v-if="t.treeIssue" class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-muted">
            <UiIcon name="info" :size="13" />{{ t.treeIssue }}
          </div>

          <div class="min-h-0 flex-1">
            <TreePane
              :ref="(el) => bindRef(treeRefs, t.id, el)"
              :tree="t.tree"
              :source="t.result?.output ?? ''"
              :indent="indentUnitOf(t)"
              :font-size="fontSize"
              :doc-epoch="t.docEpoch"
              @edit="onTreeEdit"
              @reveal="revealLine"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 状态栏 -->
    <footer class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span v-if="issue" class="text-danger">解析失败</span>
      <span v-else-if="output">已格式化</span>
      <span v-else>等待输入</span>
      <span v-if="stats && stats.nodes">
        {{ stats.outLines.toLocaleString() }} 行 · {{ fmtBytes(stats.outBytes) }} · {{ stats.nodes.toLocaleString() }} 节点 ·
        深度 {{ stats.depth }}
      </span>
      <span v-if="stats && stats.nodes" class="flex items-center gap-2.5" title="按类型统计的节点数">
        <span>对象 {{ stats.kinds.object }}</span>
        <span>数组 {{ stats.kinds.array }}</span>
        <span>字符串 {{ stats.kinds.string }}</span>
        <span>数字 {{ stats.kinds.number }}</span>
        <span>布尔 {{ stats.kinds.boolean }}</span>
        <span>空值 {{ stats.kinds.null }}</span>
      </span>
      <span class="ml-auto flex items-center gap-3">
        <span><span class="launcher-kbd">{{ modLabel }}</span> <span class="launcher-kbd">↵</span> 格式化</span>
        <span>无损保留数字精度</span>
      </span>
    </footer>

    <HistoryDialog
      v-if="historyOpen"
      :entries="history"
      @pick="pickHistory"
      @remove="removeHistory"
      @clear="clearHistory"
      @close="historyOpen = false"
    />
  </AppShell>
</template>
