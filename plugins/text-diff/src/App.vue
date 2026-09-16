<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useToast } from '@launcher/ui/toast'
import { copyText, downloadBlob, fileFromDataTransfer, pickFile, readClipboardText, textFromDataTransfer } from '@launcher/ui/clipboard'
import { hostUi } from '@launcher/api'
import { isMod, modLabel } from '@launcher/ui/keys'
import { useTheme } from '@launcher/ui/theme'
import type { DiffOptions, DiffResult } from './core/diff'
import { runDiff } from './core/runner'
import DiffView from './components/DiffView.vue'

/** 用一行分隔符把一段文本拆成两侧 */
const DIVIDER = /^\s*(?:-{3,}|={3,}|>{3,}|\|{3,})\s*$/

const textA = ref('')
const textB = ref('')
const view = ref<'edit' | 'diff'>('diff')
const mode = ref<'split' | 'unified'>('split')
const ignoreCase = ref(false)
const ignoreWhitespace = ref(false)
const collapse = ref(true)
const result = shallowRef<DiffResult | null>(null)
const busy = ref(false)
const seedNotice = ref('')
const toast = useToast()
const { theme, toggle: toggleTheme } = useTheme()

const options = computed<DiffOptions>(() => ({
  ignoreCase: ignoreCase.value,
  ignoreWhitespace: ignoreWhitespace.value,
  collapse: collapse.value,
  inline: true,
}))

const stats = computed(() => result.value?.stats ?? null)
const hasBoth = computed(() => textA.value.length > 0 || textB.value.length > 0)

/* ------------------------------------------------------------------ 计算 */

let timer = 0
let job = 0

async function compute(immediate = false) {
  clearTimeout(timer)
  const run = async () => {
    if (!hasBoth.value) {
      result.value = null
      return
    }
    const mine = ++job
    busy.value = true
    const res = await runDiff(textA.value, textB.value, options.value)
    if (mine !== job) return
    result.value = res
    busy.value = false
  }
  if (immediate) await run()
  else timer = setTimeout(run, 220) as unknown as number
}

watch([textA, textB, options], () => void compute())

/* ------------------------------------------------------------------ 操作 */

function swap() {
  const tmp = textA.value
  textA.value = textB.value
  textB.value = tmp
  toast.info('已交换两侧')
}

function clearAll() {
  textA.value = ''
  textB.value = ''
  result.value = null
}

/** 把「第一行分隔符」前面的内容放到左侧、后面的放到右侧 */
function splitFromDivider() {
  const source = textA.value
  if (!source.trim()) {
    toast.info('左侧还没有内容')
    return
  }
  const lines = source.split('\n')
  const at = lines.findIndex((l) => DIVIDER.test(l))
  if (at < 0) {
    toast.err('没找到分隔行（--- 或 ===）')
    return
  }
  textA.value = lines.slice(0, at).join('\n')
  textB.value = lines.slice(at + 1).join('\n')
  view.value = 'diff'
  toast.ok('已按分隔行拆成两侧')
}

async function pasteInto(side: 'a' | 'b') {
  const text = await readClipboardText()
  if (text == null) {
    toast.err('读取剪贴板失败（宿主可能未授权）')
    return
  }
  if (side === 'a') textA.value = text
  else textB.value = text
  toast.ok('已粘贴到' + (side === 'a' ? '左' : '右') + '侧')
  if (textA.value && textB.value) view.value = 'diff'
}

async function openInto(side: 'a' | 'b') {
  const file = await pickFile('.txt,.md,.json,.log,.csv,text/*,application/json')
  if (!file) return
  const text = await file.text()
  if (side === 'a') textA.value = text
  else textB.value = text
  if (textA.value && textB.value) view.value = 'diff'
}

function onDrop(side: 'a' | 'b', e: DragEvent) {
  const file = fileFromDataTransfer(e.dataTransfer)
  if (file) {
    e.preventDefault()
    void (file as File).text().then((text) => {
      if (side === 'a') textA.value = text
      else textB.value = text
      if (textA.value && textB.value) view.value = 'diff'
    })
    return
  }
  const text = textFromDataTransfer(e.dataTransfer)
  if (text) {
    e.preventDefault()
    if (side === 'a') textA.value = text
    else textB.value = text
  }
}

async function copyUnified() {
  const text = result.value?.unified ?? ''
  if (!text) {
    toast.info('还没有比对结果')
    return
  }
  if (await copyText(text)) toast.ok('已复制 unified diff')
  else toast.err('复制失败')
}

function downloadPatch() {
  const text = result.value?.unified ?? ''
  if (!text) return
  downloadBlob('changes.patch', text, 'text/x-patch;charset=utf-8')
  toast.ok('已导出 changes.patch')
}

function setPair(a: string, b: string) {
  textA.value = a
  textB.value = b
  view.value = 'diff'
  void compute(true)
}

function loadSample() {
  setPair(
    ['# 发布说明', '', '## 新增', '- 文本比对插件', '- 支持并排与统一视图', '', '## 修复', '- 修正了若干拼写错误', '', '版本：0.1.0'].join('\n'),
    ['# 发布说明', '', '## 新增', '- 文本比对插件', '- 支持并排、统一与内联高亮', '', '## 修复', '- 修正若干拼写错误', '', '版本：0.2.0'].join('\n'),
  )
}

function onKeydown(e: KeyboardEvent) {
  if (isMod(e) && e.key === 'Enter') {
    e.preventDefault()
    view.value = 'diff'
    void compute(true)
    return
  }
  if (isMod(e) && !e.shiftKey && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    view.value = view.value === 'diff' ? 'edit' : 'diff'
    return
  }
  if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    swap()
  }
}

/* ------------------------------------------------------------- 宿主集成 */

async function syncFooter() {
  await hostUi.setFooter([
    {
      type: 'button',
      id: 'run',
      label: '开始比对',
      icon: 'GitCompare',
      keys: ['Mod+Enter'],
      onClick: () => {
        view.value = 'diff'
        void compute(true)
      },
    },
    {
      type: 'button',
      id: 'mode',
      label: mode.value === 'split' ? '统一视图' : '并排视图',
      icon: 'Columns',
      keys: ['Mod+E'],
      onClick: () => (mode.value = mode.value === 'split' ? 'unified' : 'split'),
    },
    {
      type: 'action-panel',
      id: 'more',
      label: '更多',
      icon: 'Sliders',
      keys: ['Mod+K'],
      title: '文本比对',
      items: [
        { id: 'swap', name: '交换两侧', onSelect: swap },
        { id: 'divider', name: '按分隔行拆分', onSelect: splitFromDivider },
        { id: 'case', name: ignoreCase.value ? '区分大小写' : '忽略大小写', onSelect: () => (ignoreCase.value = !ignoreCase.value) },
        {
          id: 'space',
          name: ignoreWhitespace.value ? '不忽略空白' : '忽略空白差异',
          onSelect: () => (ignoreWhitespace.value = !ignoreWhitespace.value),
        },
        { id: 'collapse', name: collapse.value ? '展开全部行' : '折叠相同行', onSelect: () => (collapse.value = !collapse.value) },
        { id: 'copy', name: '复制 unified diff', onSelect: copyUnified },
        { id: 'patch', name: '导出 .patch', onSelect: downloadPatch },
        { id: 'clear', name: '清空', onSelect: clearAll },
      ],
    },
  ])
}

let stopWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  void syncFooter()

  const seed = (await hostUi.getSearchContent()).trim()
  const applySeed = (text: string) => {
    if (!text.trim()) return
    const lines = text.split('\n')
    const at = lines.findIndex((l) => DIVIDER.test(l))
    if (at >= 0) {
      textA.value = lines.slice(0, at).join('\n')
      textB.value = lines.slice(at + 1).join('\n')
      seedNotice.value = '已从搜索框识别分隔行并拆成两侧'
      view.value = 'diff'
    } else {
      textA.value = text
      view.value = 'edit'
      seedNotice.value = '已把搜索框内容放到左侧，请再填右侧'
    }
  }
  if (seed) {
    applySeed(seed)
    void hostUi.clearSearchContent()
  }
  stopWatch = hostUi.watchSearchContent((val) => {
    if (val.trim().length > 8) applySeed(val)
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(timer)
  stopWatch?.()
})

watch(mode, () => void syncFooter())
watch([ignoreCase, ignoreWhitespace, collapse], () => void syncFooter())
</script>

<template>
  <AppShell>
    <header class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="branch" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">文本比对</span>
      <span v-if="busy" class="launcher-chip">计算中…</span>
      <span v-else-if="result" class="launcher-chip">{{ result.ms }}ms</span>

      <div class="ml-2 flex items-center gap-0.5 rounded-lg border border-line bg-panel2 p-0.5">
        <button
          class="rounded-md px-2.5 py-[3px] text-[12px]"
          :class="view === 'diff' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="view = 'diff'"
        >
          比对结果
        </button>
        <button
          class="rounded-md px-2.5 py-[3px] text-[12px]"
          :class="view === 'edit' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="view = 'edit'"
        >
          编辑两侧
        </button>
      </div>

      <div v-if="view === 'diff'" class="flex items-center gap-0.5 rounded-lg border border-line bg-panel2 p-0.5">
        <button
          class="rounded-md px-2.5 py-[3px] text-[12px]"
          :class="mode === 'split' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="mode = 'split'"
        >
          并排
        </button>
        <button
          class="rounded-md px-2.5 py-[3px] text-[12px]"
          :class="mode === 'unified' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="mode = 'unified'"
        >
          统一
        </button>
      </div>

      <div class="ml-auto flex items-center gap-1.5">
        <button class="launcher-btn ghost" :class="{ primary: ignoreCase }" title="忽略大小写" @click="ignoreCase = !ignoreCase">
          Aa
        </button>
        <button
          class="launcher-btn ghost"
          :class="{ primary: ignoreWhitespace }"
          title="忽略空白差异"
          @click="ignoreWhitespace = !ignoreWhitespace"
        >
          <UiIcon name="wrap" :size="13" />
        </button>
        <button class="launcher-btn ghost" :class="{ primary: collapse }" title="折叠相同行" @click="collapse = !collapse">
          <UiIcon name="minus" :size="13" />
        </button>
        <button class="launcher-btn ghost" title="交换两侧" @click="swap"><UiIcon name="refresh" :size="13" /></button>
        <button class="launcher-btn ghost" title="复制 unified diff" @click="copyUnified">
          <UiIcon name="copy" :size="13" />
        </button>
        <button class="launcher-btn ghost" title="导出 .patch" @click="downloadPatch">
          <UiIcon name="download" :size="13" />
        </button>
        <button class="launcher-btn ghost" title="载入示例" @click="loadSample"><UiIcon name="wand" :size="13" /></button>
        <button class="launcher-btn ghost" title="清空" @click="clearAll"><UiIcon name="trash" :size="13" /></button>
        <button class="launcher-btn ghost" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
          <UiIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="13" />
        </button>
      </div>
    </header>

    <div v-if="seedNotice" class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
      <UiIcon name="info" :size="13" />{{ seedNotice }}
    </div>

    <!-- 编辑两侧 -->
    <div v-if="view === 'edit'" class="flex min-h-0 flex-1">
      <div
        v-for="side in (['a', 'b'] as const)"
        :key="side"
        class="flex min-w-0 flex-1 flex-col border-line"
        :class="side === 'b' ? 'border-l' : ''"
        @drop="onDrop(side, $event)"
        @dragover.prevent
      >
        <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
          <span>{{ side === 'a' ? '原始文本' : '修改后文本' }}</span>
          <span class="text-faint">
            {{ (side === 'a' ? textA : textB).length.toLocaleString() }} 字符 ·
            {{ (side === 'a' ? textA : textB).split('\n').length }} 行
          </span>
          <span class="ml-auto flex items-center gap-1">
            <button class="launcher-btn ghost !px-1.5" title="粘贴剪贴板" @click="pasteInto(side)">
              <UiIcon name="clipboard" :size="12" />
            </button>
            <button class="launcher-btn ghost !px-1.5" title="打开文件" @click="openInto(side)">
              <UiIcon name="folder" :size="12" />
            </button>
            <button
              class="launcher-btn ghost !px-1.5"
              title="清空"
              @click="side === 'a' ? (textA = '') : (textB = '')"
            >
              <UiIcon name="close" :size="12" />
            </button>
          </span>
        </div>
        <textarea
          v-if="side === 'a'"
          v-model="textA"
          class="launcher-textarea launcher-scroll"
          spellcheck="false"
          placeholder="把原始文本粘到这里，或直接拖入文件…"
        />
        <textarea
          v-else
          v-model="textB"
          class="launcher-textarea launcher-scroll"
          spellcheck="false"
          placeholder="把修改后的文本粘到这里…"
        />
      </div>
    </div>

    <!-- 比对结果 -->
    <div v-else class="min-h-0 flex-1">
      <DiffView v-if="result && result.rows.length" :rows="result.rows" :mode="mode" />
      <div v-else class="grid h-full place-items-center px-6 text-center">
        <div class="space-y-2">
          <UiIcon name="branch" :size="26" class="mx-auto text-faint" />
          <p class="text-[13px] text-muted">
            {{ hasBoth ? '没有差异' : '还没有内容可以比对' }}
          </p>
          <p class="text-[11.5px] text-faint">
            在「编辑两侧」里粘贴文本；一段文本里含 <code class="font-mono">---</code> 单独成行时会自动拆成两侧
          </p>
          <button class="launcher-btn mx-auto" @click="view = 'edit'">
            <UiIcon name="pencil" :size="13" />去填写文本
          </button>
        </div>
      </div>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <template v-if="stats">
        <span class="text-success">+{{ stats.added }}</span>
        <span class="text-danger">-{{ stats.removed }}</span>
        <span>~{{ stats.changed }}</span>
        <span>{{ stats.hunks }} 个变更块</span>
        <span v-if="result?.degraded" class="text-warn">规模过大，已用粗略策略</span>
      </template>
      <span v-else>等待输入</span>
      <span class="ml-auto flex items-center gap-3">
        <span><span class="launcher-kbd">{{ modLabel }}</span> <span class="launcher-kbd">↵</span> 比对</span>
        <span><span class="launcher-kbd">{{ modLabel }}</span> <span class="launcher-kbd">E</span> 视图</span>
        <span>Myers 差分 · Worker 内计算</span>
      </span>
    </footer>
  </AppShell>
</template>
