<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@shared/ui/AppShell.vue'
import SofIcon from '@shared/ui/SofIcon.vue'
import { useToast } from '@shared/lib/toast'
import { copyText, downloadBlob, fileFromDataTransfer, pickFile, readClipboardText } from '@shared/lib/clipboard'
import { clearSearchContent, getSearchContent, setFooter, watchSearchContent } from '@shared/lib/platform'
import { isTypingTarget, isMod, modLabel } from '@shared/lib/keys'
import { useTheme } from '@shared/lib/theme'
import type { FormatOptions, FormatResult, IndentOption } from './core/format'
import { runBuildTree, runFormat } from './core/runner'
import type { FlatTree } from './core/tree'
import OutputPane from './components/OutputPane.vue'
import TreePane from './components/TreePane.vue'

const MAX_TREE_CHARS = 4_000_000
const SAMPLE = `{"name":"sofast","version":"0.9.0","plugin":{"id":"json","tags":["format","validate"],"extra":{"deep":{"a":1,"b":[true,false,null,1e999,12345678901234567890]}}}}`

const indentOptions: { v: IndentOption; t: string }[] = [
  { v: 2, t: '2 空格' },
  { v: 4, t: '4 空格' },
  { v: 'tab', t: 'Tab' },
]

const source = ref('')
const result = shallowRef<FormatResult | null>(null)
const indent = ref<IndentOption>(2)
const minify = ref(false)
const sortKeys = ref(false)
const view = ref<'text' | 'tree'>('text')
const busy = ref(false)
const split = ref(46)
const wrapRef = ref<HTMLElement | null>(null)
const tree = shallowRef<FlatTree | null>(null)
const treeIssue = ref('')
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
    busy.value = false
    if (view.value === 'tree') void refreshTree()
  }
  if (immediate) await run()
  else timer = setTimeout(run, 160) as unknown as number
}

async function refreshTree() {
  const res = result.value
  if (!res?.ok) {
    tree.value = null
    return
  }
  if (res.stats.inChars > MAX_TREE_CHARS) {
    tree.value = null
    treeIssue.value = `内容过大（${res.stats.inChars.toLocaleString()} 字符），已停用树视图，请切换到文本视图`
    return
  }
  treeIssue.value = ''
  tree.value = await runBuildTree(source.value, { maxNodes: 300_000 })
}

watch(source, () => void compute())
watch(options, () => void compute(true))
watch(view, (v) => {
  if (v === 'tree') void refreshTree()
})

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

function setSource(text: string) {
  source.value = text
  void compute(true)
}

async function importFromSearch() {
  const text = await getSearchContent()
  if (!text.trim()) {
    toast.info('搜索框是空的')
    return
  }
  setSource(text)
  void clearSearchContent()
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

function toggleView() {
  view.value = view.value === 'tree' ? 'text' : 'tree'
}

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
    void compute(true)
    return
  }
  if (isMod(e) && !e.shiftKey && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    toggleView()
    return
  }
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault()
    minify.value = !minify.value
    return
  }
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    sortKeys.value = !sortKeys.value
    return
  }
  if (isTypingTarget(e.target)) return
}

/* ------------------------------------------------------------- 宿主集成 */

async function syncFooter() {
  await setFooter([
    {
      type: 'button',
      id: 'format',
      label: '格式化',
      icon: 'Check',
      keys: ['Mod+Enter'],
      onClick: () => void compute(true),
    },
    {
      type: 'button',
      id: 'view',
      label: view.value === 'tree' ? '文本视图' : '树视图',
      icon: 'Braces',
      keys: ['Mod+E'],
      onClick: toggleView,
    },
    {
      type: 'action-panel',
      id: 'more',
      label: '更多',
      icon: 'Sliders',
      keys: ['Mod+K'],
      title: 'JSON 操作',
      items: [
        { id: 'indent2', name: '缩进 2 空格', onSelect: () => { indent.value = 2; minify.value = false } },
        { id: 'indent4', name: '缩进 4 空格', onSelect: () => { indent.value = 4; minify.value = false } },
        { id: 'indentTab', name: '缩进 Tab', onSelect: () => { indent.value = 'tab'; minify.value = false } },
        { id: 'minify', name: '压缩成一行', keys: ['Mod+Shift+M'], onSelect: () => (minify.value = !minify.value) },
        { id: 'sort', name: '对象键排序', keys: ['Mod+Shift+S'], onSelect: () => (sortKeys.value = !sortKeys.value) },
        { id: 'copy', name: '复制结果', color: '#10b981', onSelect: copyOutput },
        { id: 'download', name: '下载 JSON', onSelect: download },
        { id: 'clip', name: '读取剪贴板', onSelect: importFromClipboard },
        { id: 'clear', name: '清空', color: '#ef4444', onSelect: clearAll },
      ],
    },
  ])
}

let stopWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const seed = await getSearchContent()
  if (seed.trim() && looksLikeJson(seed)) {
    void clearSearchContent()
    setSource(seed)
  }
  stopWatch = watchSearchContent((val) => {
    if (looksLikeJson(val)) setSource(val)
  })
  void syncFooter()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopWatch?.()
  clearTimeout(timer)
})

watch(view, () => void syncFooter())
</script>

<template>
  <AppShell>
    <!-- 顶栏 -->
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <SofIcon name="braces" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">JSON 工具箱</span>
      <span v-if="busy" class="sof-chip">计算中…</span>
      <span v-if="repaired" class="sof-chip" title="严格 JSON 解析失败，已用宽松模式修好">宽松修复</span>

      <div class="ml-auto flex items-center gap-1.5">
        <button class="sof-btn ghost" title="读取搜索框内容" @click="importFromSearch">
          <SofIcon name="search" :size="13" />搜索框
        </button>
        <button class="sof-btn ghost" title="读取剪贴板" @click="importFromClipboard">
          <SofIcon name="clipboard" :size="13" />剪贴板
        </button>
        <button class="sof-btn ghost" title="打开文件" @click="openFile">
          <SofIcon name="folder" :size="13" />文件
        </button>
        <button class="sof-btn ghost" title="载入示例" @click="loadSample">
          <SofIcon name="wand" :size="13" />
        </button>
        <button class="sof-btn ghost" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
          <SofIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="13" />
        </button>
      </div>
    </header>

    <!-- 工具条 -->
    <div class="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
      <div class="flex items-center gap-0.5 rounded-lg border border-line bg-panel2 p-0.5">
        <button
          v-for="opt in indentOptions"
          :key="opt.t"
          class="rounded-md px-2 py-[3px] text-[12px]"
          :class="!minify && indent === opt.v ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="indent = opt.v; minify = false"
        >
          {{ opt.t }}
        </button>
      </div>

      <button class="sof-btn" :class="{ primary: !minify }" @click="minify = false; compute(true)">
        <SofIcon name="braces" :size="13" />格式化
      </button>
      <button class="sof-btn" :class="{ primary: minify }" @click="minify = true; compute(true)">
        <SofIcon name="minus" :size="13" />压缩
      </button>
      <button class="sof-btn" :class="{ primary: sortKeys }" @click="sortKeys = !sortKeys">
        <SofIcon name="sortAsc" :size="13" />键排序
      </button>

      <div class="mx-1 h-4 w-px bg-line" />

      <button class="sof-btn ghost" title="复制结果" @click="copyOutput">
        <SofIcon name="copy" :size="13" />复制
      </button>
      <button class="sof-btn ghost" title="下载 JSON" @click="download">
        <SofIcon name="download" :size="13" />下载
      </button>
      <button class="sof-btn ghost" title="清空" @click="clearAll">
        <SofIcon name="trash" :size="13" />清空
      </button>

      <div class="ml-auto flex items-center gap-0.5 rounded-lg border border-line bg-panel2 p-0.5">
        <button
          class="rounded-md px-2.5 py-[3px] text-[12px]"
          :class="view === 'text' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="view = 'text'"
        >
          文本
        </button>
        <button
          class="rounded-md px-2.5 py-[3px] text-[12px]"
          :class="view === 'tree' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="view = 'tree'"
        >
          树形
        </button>
      </div>
    </div>

    <!-- 主体：输入 / 输出 分栏 -->
    <div ref="wrapRef" class="flex min-h-0 flex-1" @drop="onDrop" @dragover.prevent>
      <div class="flex min-w-0 flex-col" :style="{ width: split + '%' }">
        <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
          <span>输入</span>
          <span v-if="stats" class="text-faint">{{ stats.inChars.toLocaleString() }} 字符</span>
          <span class="ml-auto text-faint">可直接拖入 .json 文件</span>
        </div>
        <textarea
          v-model="source"
          class="sof-scroll flex-1 resize-none border-0 bg-panel p-3 font-mono text-[12.5px] leading-[20px] outline-none"
          spellcheck="false"
          placeholder='粘贴 JSON，或把 .json 文件拖进来…&#10;&#10;支持注释 / 尾逗号 / 单引号 / 裸键的宽松修复。'
        />
      </div>

      <div class="w-px cursor-col-resize bg-line hover:bg-accent" @mousedown="startDrag" />

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
          <span>{{ view === 'tree' ? '树形' : '结果' }}</span>
          <span v-if="stats && view === 'text'" class="text-faint">
            {{ stats.outLines.toLocaleString() }} 行 · {{ fmtBytes(stats.outBytes) }}
          </span>
          <span v-if="stats" class="text-faint">
            {{ stats.nodes.toLocaleString() }} 节点 · 深度 {{ stats.depth }}
          </span>
          <span v-if="repaired" class="ml-auto text-[color:var(--sof-warn)]" title="注释被丢弃，单引号/裸键/尾逗号已重写">
            已按宽松模式修复
          </span>
        </div>

        <div v-if="issue" class="flex items-start gap-2 border-b border-line bg-[color:var(--sof-del-bg)] px-3 py-2">
          <SofIcon name="alert" :size="14" class="mt-[2px] text-danger" />
          <div class="min-w-0 text-[12.5px]">
            <div class="text-danger">
              第 {{ issue.line }} 行 第 {{ issue.column }} 列：{{ issue.message }}
            </div>
            <div v-if="issue.snippet" class="mt-0.5 truncate font-mono text-[11.5px] text-muted">
              {{ issue.snippet }}
            </div>
          </div>
        </div>

        <div v-if="treeIssue" class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-muted">
          <SofIcon name="info" :size="13" />{{ treeIssue }}
        </div>

        <div class="min-h-0 flex-1">
          <OutputPane v-if="view === 'text'" :text="output" :plain="minify" />
          <TreePane v-else :tree="tree" />
        </div>
      </div>
    </div>

    <!-- 状态栏 -->
    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span v-if="issue" class="text-danger">解析失败</span>
      <span v-else-if="output">已格式化</span>
      <span v-else>等待输入</span>
      <span class="ml-auto flex items-center gap-3">
        <span><span class="sof-kbd">{{ modLabel }}</span> <span class="sof-kbd">↵</span> 格式化</span>
        <span><span class="sof-kbd">{{ modLabel }}</span> <span class="sof-kbd">E</span> 视图</span>
        <span>无损保留数字精度</span>
      </span>
    </footer>
  </AppShell>
</template>
