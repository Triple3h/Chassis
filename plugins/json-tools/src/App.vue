<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useToast } from '@launcher/ui/toast'
import { copyText, downloadBlob, fileFromDataTransfer, pickFile, readClipboardText } from '@launcher/ui/clipboard'
import { hostUi } from '@launcher/api'
import { isTypingTarget, isMod, modLabel } from '@launcher/ui/keys'
import { useTheme } from '@launcher/ui/theme'
import type { FormatOptions, FormatResult, IndentOption } from './core/format'
import { runBuildTree, runFormat } from './core/runner'
import type { FlatTree } from './core/tree'
import { escapeUnicode, unescapeUnicode } from './core/unicode'
import { addEscape, removeEscape } from './core/escape'
import JsonEditor from './components/JsonEditor.vue'
import ToolMenu from './components/ToolMenu.vue'
import TreePane from './components/TreePane.vue'

const MAX_TREE_CHARS = 4_000_000
const SAMPLE = `{"name":"launcher","version":"0.9.0","plugin":{"id":"json","tags":["format","validate"],"extra":{"deep":{"a":1,"b":[true,false,null,1e999,12345678901234567890]}}}}`

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

const source = ref('')
const result = shallowRef<FormatResult | null>(null)
const indent = ref<IndentOption>(2)
const fontSize = ref(14)
const minify = ref(false)
const sortKeys = ref(false)
const showLineNumbers = ref(true)
const busy = ref(false)
const split = ref(46)
const wrapRef = ref<HTMLElement | null>(null)
const editor = ref<{
  replaceAll: (text: string) => void
  scrollToLine: (line: number) => void
  foldAll: () => void
  unfoldAll: () => void
  focus: () => void
} | null>(null)
const tree = shallowRef<FlatTree | null>(null)
const treeIssue = ref('')
/** 换了一份新文档（粘贴 / 打开文件 / 示例 / 清空）—— 树视图据此复位展开与滚动 */
const docEpoch = ref(0)
/** 从树里定位过来、编辑器里需要高亮的行（1 起，0 = 无） */
const hitLine = ref(0)
const treePane = ref<{
  expandAll: () => void
  collapseAll: () => void
  copyValue: () => void
  copyPath: () => void
  revealSelected: () => void
} | null>(null)
const toast = useToast()
const { theme, toggle: toggleTheme } = useTheme()

const output = computed(() => result.value?.output ?? '')
const issue = computed(() => (result.value && !result.value.ok ? (result.value.issue ?? null) : null))
const stats = computed(() => result.value?.stats ?? null)
const repaired = computed(() => !!result.value?.repaired)
const options = computed<FormatOptions>(() => ({
  indent: indent.value,
  minify: minify.value,
  sortKeys: sortKeys.value,
}))
const indentUnit = computed(() => (indent.value === 'tab' ? '\t' : ' '.repeat(indent.value)))

/* ---------------------------------------------------------------- 计算调度 */

let timer = 0
let job = 0

async function compute(immediate = false) {
  clearTimeout(timer)
  const run = async () => {
    const text = source.value
    const mine = ++job
    if (!text.trim()) {
      result.value = null
      tree.value = null
      return
    }
    busy.value = true
    const res = await runFormat(text, options.value)
    if (mine !== job) return
    result.value = res
    hitLine.value = 0
    busy.value = false
    void refreshTree()
  }
  if (immediate) await run()
  else timer = setTimeout(run, 160) as unknown as number
}

/**
 * 树基于「格式化输出」构建（不是原始输入）：这样节点偏移与编辑器里的文本一一对应，
 * 树上的行内编辑也能直接在这个文本上做最小替换。
 */
async function refreshTree() {
  const res = result.value
  if (!res?.ok) {
    tree.value = null
    return
  }
  const text = res.output
  if (text.length > MAX_TREE_CHARS) {
    tree.value = null
    treeIssue.value = `内容过大（${text.length.toLocaleString()} 字符），已停用树视图`
    return
  }
  treeIssue.value = ''
  const mine = job
  const built = await runBuildTree(text, { maxNodes: 300_000 })
  if (mine !== job) return
  tree.value = built
}

/**
 * 树上的编辑（改键 / 改值 / 增删成员）已经把结果文本算好了 —— 直接换掉文档，
 * 不再走「原始输入」那一层：此时用户改的就是这份 JSON 本身（与 bejson 同款语义）。
 */
function onTreeEdit(text: string) {
  source.value = text
  void compute(true)
}

watch(source, () => void compute())
watch(options, () => void compute(true))

/* ------------------------------------------------------------------- 交互 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 错误提示里的指位行：与 bejson 一样用 `----^` 指出出错那一列 */
const caretLine = computed(() => '-'.repeat(Math.max(0, (issue.value?.column ?? 1) - 1)) + '^')

function looksLikeJson(text: string): boolean {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[') || t.startsWith('"{') || t.startsWith("'")
}

function setSource(text: string) {
  source.value = text
  docEpoch.value++
  void compute(true)
}

async function importFromSearch() {
  const text = await hostUi.getSearchContent()
  if (!text.trim()) {
    toast.info('搜索框是空的')
    return
  }
  setSource(text)
  void hostUi.clearSearchContent()
}

async function importFromClipboard() {
  const text = await readClipboardText()
  if (!text?.trim()) {
    toast.err('剪贴板里没有文本（宿主可能未授权读取）')
    return
  }
  setSource(text)
}

async function openFile() {
  const file = await pickFile('application/json,.json,.jsonc,.txt,text/plain')
  if (!file) return
  setSource(await file.text())
}

async function copyOutput() {
  if (!output.value) return
  if (await copyText(output.value)) toast.ok('已复制结果')
  else toast.err('复制失败，请手动选择')
}

function download() {
  if (!output.value) return
  downloadBlob('formatted.json', output.value, 'application/json;charset=utf-8')
  toast.ok('已导出 formatted.json')
}

function clearAll() {
  setSource('')
  treeIssue.value = ''
  toast.info('已清空')
}

function loadSample() {
  setSource(SAMPLE)
}

/* ------------------------------------------------- 原地改写文档（对齐 bejson） */

/** 把文本写回文档本身：走编辑器就能保留撤销栈（⌘Z 能退回改之前的原文） */
function replaceDoc(text: string) {
  const ed = editor.value
  if (ed) ed.replaceAll(text)
  else source.value = text
}

/**
 * 格式化 / 压缩 / 改缩进 / 改排序统一走这里：结果**原地改写编辑器里的文档**，
 * 而不是只换个右栏预览。右栏仍留一份结果视图，但文档自始至终只有一份。
 *
 * 这里刻意自己算一遍、直接用返回值，而不是改完选项再读 `result`：
 * 改选项会触发 `watch(options)` 里的另一次计算，把 `job` 顶掉，
 * 读到的可能是上一份结果 ⇒ 判定「已经就是这样」而把这次改写静默吞掉。
 */
async function reformat(mode: 'pretty' | 'minify', announce = '') {
  const text = source.value
  if (!text.trim()) {
    toast.info('先输入 JSON')
    return
  }
  const opts: FormatOptions = { indent: indent.value, minify: mode === 'minify', sortKeys: sortKeys.value }
  busy.value = true
  try {
    const res = await runFormat(text, opts)
    result.value = res
    minify.value = mode === 'minify'
    if (!res.ok) {
      toast.err('JSON 有语法错误，先修好再改写文档')
      return
    }
    hitLine.value = 0
    if (res.output === source.value) {
      if (announce) toast.info(`${announce}：已经就是这样`)
      return
    }
    replaceDoc(res.output)
    if (announce) toast.ok(`${announce}（${modLabel}Z 可撤销）`)
  } finally {
    busy.value = false
  }
}

async function toggleSort() {
  sortKeys.value = !sortKeys.value
  await reformat(minify.value ? 'minify' : 'pretty', sortKeys.value ? '已按键名排序' : '已取消排序')
}

/** 缩进改动同样就地重排（bejson 的缩进下拉就是即时重排） */
watch(indent, () => void reformat('pretty'))

/** 树视图点「定位」：滚到编辑器里的那一行并高亮 */
function revealLine(line: number) {
  if (!line || line < 1) return
  hitLine.value = line
  editor.value?.scrollToLine(line)
}

/**
 * 文本级变换：Unicode 互转（汉字/非 ASCII）与整篇 `\` 转义，全都作用于当前文档文本。
 */
function transform(id: TransformId) {
  if (!source.value.trim()) {
    toast.info('先输入 JSON')
    return
  }
  const text = source.value
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
  setSource(res.text)
  toast.ok(`${TXT_LABEL[id]}：已处理 ${res.changed} 处`)
}

const onUnicodeAction = (id: string) => transform(id as TransformId)
const onEscapeAction = (id: string) => transform(id as TransformId)

function onDrop(e: DragEvent) {
  const file = fileFromDataTransfer(e.dataTransfer)
  if (!file) return
  e.preventDefault()
  void file.text().then(setSource)
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
    void reformat(minify.value ? 'pretty' : 'minify', minify.value ? '已格式化' : '已压缩')
    return
  }
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void toggleSort()
    return
  }
  if (isTypingTarget(e.target)) return
}

/* ------------------------------------------------------------- 宿主集成 */

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
        { id: 'indent1', name: '缩进 1 空格', onSelect: () => { indent.value = 1; minify.value = false } },
        { id: 'indent2', name: '缩进 2 空格', onSelect: () => { indent.value = 2; minify.value = false } },
        { id: 'indent3', name: '缩进 3 空格', onSelect: () => { indent.value = 3; minify.value = false } },
        { id: 'indent4', name: '缩进 4 空格', onSelect: () => { indent.value = 4; minify.value = false } },
        { id: 'indentTab', name: '缩进 Tab', onSelect: () => { indent.value = 'tab'; minify.value = false } },
        { id: 'ln', name: '显示 / 隐藏行号', onSelect: () => (showLineNumbers.value = !showLineNumbers.value) },
        { id: 'foldAll', name: '折叠全部', onSelect: () => editor.value?.foldAll() },
        { id: 'unfoldAll', name: '展开全部', onSelect: () => editor.value?.unfoldAll() },
        { id: 'copy', name: '复制结果', onSelect: copyOutput },
        { id: 'download', name: '下载 JSON', onSelect: download },
        { id: 'zh', name: '中文转Unicode', onSelect: () => transform('zh') },
        { id: 'zhBack', name: 'Unicode转中文', onSelect: () => transform('zhBack') },
        { id: 'addEsc', name: '添加 \\ 转义（塞进字符串用）', onSelect: () => transform('addEscape') },
        { id: 'stripEsc', name: '去除 \\ 转义', onSelect: () => transform('stripEscape') },
        { id: 'nonAscii', name: '转义所有非 ASCII（含 emoji）', onSelect: () => transform('nonAscii') },
        { id: 'clip', name: '读取剪贴板', onSelect: importFromClipboard },
        { id: 'clear', name: '清空', onSelect: clearAll },
      ],
    },
  ])
}

let stopWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const seed = await hostUi.getSearchContent()
  if (seed.trim() && looksLikeJson(seed)) {
    void hostUi.clearSearchContent()
    setSource(seed)
  }
  stopWatch = hostUi.watchSearchContent((val) => {
    if (looksLikeJson(val)) setSource(val)
  })
  void syncFooter()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopWatch?.()
  clearTimeout(timer)
})
</script>

<template>
  <AppShell>
    <!-- 顶栏 -->
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="braces" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">JSON 工具箱</span>
      <span v-if="busy" class="launcher-chip">计算中…</span>
      <span v-if="repaired" class="launcher-chip" title="严格 JSON 解析失败，已用宽松模式修好">宽松修复</span>

      <div class="ml-auto flex items-center gap-1.5">
        <button class="launcher-btn ghost" title="读取搜索框内容" @click="importFromSearch">
          <UiIcon name="search" :size="13" />搜索框
        </button>
        <button class="launcher-btn ghost" title="读取剪贴板" @click="importFromClipboard">
          <UiIcon name="clipboard" :size="13" />剪贴板
        </button>
        <button class="launcher-btn ghost" title="打开文件" @click="openFile">
          <UiIcon name="folder" :size="13" />文件
        </button>
        <button class="launcher-btn ghost" title="载入示例" @click="loadSample">
          <UiIcon name="wand" :size="13" />
        </button>
        <button class="launcher-btn ghost" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
          <UiIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="13" />
        </button>
      </div>
    </header>

    <!-- 工具条 -->
    <div class="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
      <button class="launcher-btn" :class="{ primary: !minify }" title="格式化并改写文档" @click="reformat('pretty', '已格式化')">
        <UiIcon name="braces" :size="13" />格式化
      </button>
      <button class="launcher-btn" :class="{ primary: minify }" title="压缩成一行并改写文档" @click="reformat('minify', '已压缩')">
        <UiIcon name="minus" :size="13" />压缩
      </button>
      <button class="launcher-btn" :class="{ primary: sortKeys }" title="对象键排序并改写文档" @click="toggleSort">
        <UiIcon name="sortAsc" :size="13" />键排序
      </button>

      <div class="mx-1 h-4 w-px bg-line" />

      <ToolMenu label="Unicode" icon="languages" :items="unicodeItems" @pick="onUnicodeAction" />
      <ToolMenu :label="'\\ 转义'" :items="escapeItems" @pick="onEscapeAction" />

      <div class="mx-1 h-4 w-px bg-line" />

      <button class="launcher-btn ghost" title="复制结果" @click="copyOutput">
        <UiIcon name="copy" :size="13" />复制
      </button>
      <button class="launcher-btn ghost" title="下载 JSON" @click="download">
        <UiIcon name="download" :size="13" />下载
      </button>
      <button class="launcher-btn ghost" title="清空" @click="clearAll">
        <UiIcon name="trash" :size="13" />清空
      </button>
    </div>

    <!-- 主体：输入 / 输出 分栏 -->
    <div ref="wrapRef" class="flex min-h-0 flex-1" @drop="onDrop" @dragover.prevent>
      <div class="flex min-w-0 flex-col" :style="{ width: split + '%' }">
        <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
          <span>输入</span>
          <span v-if="stats" class="text-faint">{{ stats.inChars.toLocaleString() }} 字符</span>
          <span class="ml-auto text-faint">{{ modLabel }}Z 撤销 · Tab 缩进 · 可直接拖入 .json 文件</span>
        </div>
        <JsonEditor
          ref="editor"
          v-model="source"
          class="min-h-0 flex-1"
          :font-size="fontSize"
          :show-line-numbers="showLineNumbers"
          :indent-unit="indentUnit"
          :hit-line="hitLine"
          :error-line="issue?.line ?? 0"
        />
      </div>

      <div class="w-px cursor-col-resize bg-line hover:bg-accent" @mousedown="startDrag" />

      <div class="flex min-w-0 flex-1 flex-col">
        <!-- 输出栏工具条：树控件（全展开 / 全折叠 / 缩进 / 字号，对齐 bejson） -->
        <div class="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
          <span class="flex items-center gap-1 text-[11.5px] text-muted">
            <UiIcon name="braces" :size="13" />树视图
          </span>

          <div class="mx-0.5 h-4 w-px bg-line" />

          <button class="launcher-btn ghost" @click="treePane?.expandAll()">全展开</button>
          <button class="launcher-btn ghost" @click="treePane?.collapseAll()">全折叠</button>

          <select v-model="indent" class="launcher-input launcher-select jselect" title="缩进">
            <option v-for="opt in indentOptions" :key="String(opt.v)" :value="opt.v">{{ opt.t }}</option>
          </select>
          <select v-model.number="fontSize" class="launcher-input launcher-select jselect" title="字号">
            <option v-for="size in fontSizes" :key="size" :value="size">{{ size }}px</option>
          </select>

          <div class="ml-auto flex items-center gap-1">
            <button class="launcher-btn ghost !px-1.5" title="复制选中节点的值" @click="treePane?.copyValue()">
              <UiIcon name="copy" :size="12" />值
            </button>
            <button class="launcher-btn ghost !px-1.5" title="复制选中节点的路径" @click="treePane?.copyPath()">
              <UiIcon name="link" :size="12" />路径
            </button>
            <button class="launcher-btn ghost !px-1.5" title="在编辑器里定位这一行" @click="treePane?.revealSelected()">
              <UiIcon name="external" :size="12" />定位
            </button>
          </div>
        </div>

        <div v-if="issue" class="flex items-start gap-2 border-b border-line bg-[color:var(--launcher-del-bg)] px-3 py-2">
          <UiIcon name="alert" :size="14" class="mt-[2px] text-danger" />
          <div class="min-w-0 flex-1 text-[12.5px]">
            <div class="text-danger">
              JSON 格式错误：第 {{ issue.line }} 行 第 {{ issue.column }} 列 —— {{ issue.message }}
            </div>
            <pre v-if="issue.snippet" class="launcher-scroll mt-0.5 overflow-x-auto font-mono text-[11.5px] leading-[16px] text-muted">{{ issue.snippet }}
{{ caretLine }}</pre>
          </div>
        </div>

        <div v-if="treeIssue" class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-muted">
          <UiIcon name="info" :size="13" />{{ treeIssue }}
        </div>

        <div class="min-h-0 flex-1">
          <TreePane
            ref="treePane"
            :tree="tree"
            :source="output"
            :indent="indent === 'tab' ? '\t' : ' '.repeat(indent)"
            :font-size="fontSize"
            :doc-epoch="docEpoch"
            @edit="onTreeEdit"
            @reveal="revealLine"
          />
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
  </AppShell>
</template>
