<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useVirtualList } from '@launcher/ui/virtual'
import { useToast } from '@launcher/ui/toast'
import { copyText } from '@launcher/ui/clipboard'
import { formatJson } from '../core/format'
import { escapeHtml } from '../core/highlight'
import {
  KIND,
  isContainerKind,
  jsonPath,
  matchNodes,
  nodeSource,
  projectRows,
  type FlatTree,
} from '../core/tree'

const props = defineProps<{
  tree: FlatTree | null
  /** 树对应的文本（复制节点原文 / 子树用） */
  source: string
  /** 源码行号列（压缩成单行时没有意义，隐藏） */
  showLine?: boolean
}>()

const emit = defineEmits<{ reveal: [line: number] }>()

const ROW = 24
const INDENT = 14
/** 超过这个大小时复制节点不再重新缩进，直接给原文 */
const PRETTY_LIMIT = 200_000
const scroller = ref<HTMLElement | null>(null)
const toast = useToast()

const expanded = new Set<number>()
const rev = ref(0)
const filter = ref('')
const filterDebounced = ref('')
const selected = ref(0)

let filterTimer = 0
watch(filter, (v) => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    filterDebounced.value = v.trim()
  }, 160) as unknown as number
})

const matched = computed(() => {
  if (!props.tree || !filterDebounced.value) return null
  return matchNodes(props.tree, filterDebounced.value)
})

const visible = computed(() => matched.value?.visible ?? null)

const effectiveExpanded = computed(() => {
  if (!visible.value || !props.tree) return expanded
  const all = new Set<number>()
  const { kind } = props.tree
  for (const i of visible.value) if (isContainerKind(kind[i])) all.add(i)
  return all
})

const rows = computed<number[]>(() => {
  rev.value
  if (!props.tree) return []
  return Array.from(projectRows(props.tree, effectiveExpanded.value, visible.value))
})

const { startIndex, endIndex, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count: computed(() => rows.value.length),
  rowHeight: ROW,
})

const visibleRows = computed(() => rows.value.slice(startIndex.value, endIndex.value))

/** 选中节点到根的分段（末 4 段，更长的用 … 折叠） */
const crumbs = computed(() => {
  const tree = props.tree
  if (!tree) return { parts: [] as number[], clipped: false }
  const chain: number[] = []
  let cur = selected.value
  while (cur >= 0) {
    chain.push(cur)
    cur = tree.parent[cur]
  }
  chain.reverse()
  const parts = chain.length > 4 ? chain.slice(-4) : chain
  return { parts, clipped: parts.length < chain.length }
})

const selectedPath = computed(() => (props.tree ? jsonPath(props.tree, selected.value) : ''))

/** 行号列宽跟随最大行号的位数 */
const lineWidth = computed(() => {
  const t = props.tree
  if (!t || !t.nodeCount) return 28
  return Math.max(28, String(t.line[t.nodeCount - 1]).length * 7 + 12)
})

watch(rows, () => {
  if (rows.value.length && selected.value >= rows.value.length) selected.value = rows.value.length - 1
})

function toggle(idx: number) {
  if (!props.tree) return
  if (!isContainerKind(props.tree.kind[idx])) return
  if (expanded.has(idx)) expanded.delete(idx)
  else expanded.add(idx)
  rev.value++
}

function rowClick(idx: number) {
  selected.value = idx
  const i = rows.value.indexOf(idx)
  if (i >= 0) scrollToIndex(i)
  if (props.tree && isContainerKind(props.tree.kind[idx])) toggle(idx)
  else void copyValue()
}

/** 展开祖先链并把选中节点滚进视野（面包屑 / 反向定位共用） */
function revealNode(idx: number, center = true) {
  const tree = props.tree
  if (!tree) return
  let cur = tree.parent[idx]
  while (cur >= 0) {
    expanded.add(cur)
    cur = tree.parent[cur]
  }
  if (isContainerKind(tree.kind[idx])) expanded.add(idx)
  rev.value++
  selected.value = idx
  const i = rows.value.indexOf(idx)
  if (i >= 0) scrollToIndex(i, center ? 'center' : 'start')
}

function prettify(raw: string): string {
  if (!raw || raw.length > PRETTY_LIMIT) return raw
  const res = formatJson(raw, { indent: 2 })
  return res.ok ? res.output : raw
}

async function copyPath() {
  if (!props.tree) return
  if (await copyText(selectedPath.value)) toast.ok('已复制路径')
}

async function copyValue() {
  const tree = props.tree
  if (!tree) return
  const idx = selected.value
  const raw = nodeSource(tree, props.source, idx)
  const text = isContainerKind(tree.kind[idx]) ? prettify(raw) : raw
  if (await copyText(text)) toast.ok(isContainerKind(tree.kind[idx]) ? '已复制该节点的 JSON' : '已复制该节点的值')
}

function revealSource() {
  const tree = props.tree
  if (!tree) return
  emit('reveal', tree.line[selected.value])
}

function expandAll() {
  if (!props.tree) return
  const { kind } = props.tree
  for (let i = 0; i < props.tree.nodeCount; i++) if (isContainerKind(kind[i])) expanded.add(i)
  rev.value++
}

function collapseAll() {
  expanded.clear()
  rev.value++
}

function expandDepth(depth: number) {
  if (!props.tree) return
  expanded.clear()
  const { kind, depth: d } = props.tree
  for (let i = 0; i < props.tree.nodeCount; i++) {
    if (isContainerKind(kind[i]) && d[i] < depth) expanded.add(i)
  }
  rev.value++
}

function onKeydown(e: KeyboardEvent) {
  if (!rows.value.length) return
  const pos = rows.value.indexOf(selected.value)
  const at = pos < 0 ? 0 : pos
  const move = (delta: number) => {
    e.preventDefault()
    const next = Math.max(0, Math.min(rows.value.length - 1, at + delta))
    selected.value = rows.value[next]
    scrollToIndex(next)
  }
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    if (e.shiftKey) void copyPath()
    else void copyValue()
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      move(1)
      break
    case 'ArrowUp':
      move(-1)
      break
    case 'PageDown':
      move(20)
      break
    case 'PageUp':
      move(-20)
      break
    case 'Home':
      move(-rows.value.length)
      break
    case 'End':
      move(rows.value.length)
      break
    case 'ArrowRight':
      if (props.tree && isContainerKind(props.tree.kind[selected.value]) && !expanded.has(selected.value)) {
        e.preventDefault()
        toggle(selected.value)
      }
      break
    case 'ArrowLeft':
      if (props.tree && isContainerKind(props.tree.kind[selected.value]) && expanded.has(selected.value)) {
        e.preventDefault()
        toggle(selected.value)
      }
      break
    case 'Enter':
      e.preventDefault()
      void copyValue()
      break
    default:
      break
  }
}

/** 初始展开两层，避免一进来只看到一根线 */
watch(
  () => props.tree,
  (t) => {
    if (!t) return
    expanded.clear()
    for (let i = 0; i < t.nodeCount; i++) {
      if (isContainerKind(t.kind[i]) && t.depth[i] < 2) expanded.add(i)
    }
    rev.value++
    selected.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
  },
  { immediate: true },
)

onMounted(() => scroller.value?.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  scroller.value?.removeEventListener('keydown', onKeydown)
  clearTimeout(filterTimer)
})

function indentStyle(depth: number) {
  return { paddingLeft: 6 + depth * INDENT + 'px' }
}

const KIND_LABEL = ['对象', '数组', '字符串', '数字', '布尔', '空值']

function kindLabel(kind: number): string {
  return KIND_LABEL[kind] ?? ''
}

function kindClass(kind: number) {
  switch (kind) {
    case KIND.string:
      return 'launcher-kind-str'
    case KIND.number:
      return 'launcher-kind-num'
    case KIND.boolean:
      return 'launcher-kind-bool'
    case KIND.null:
      return 'launcher-kind-null'
    default:
      return 'launcher-kind-container'
  }
}

function valueClass(kind: number) {
  switch (kind) {
    case KIND.string:
      return 'text-[color:var(--launcher-string)]'
    case KIND.number:
      return 'text-[color:var(--launcher-number)]'
    case KIND.boolean:
      return 'text-[color:var(--launcher-code)]'
    case KIND.null:
      return 'italic text-faint'
    default:
      return 'text-muted'
  }
}

/** 过滤命中处加底色（只高亮第一个匹配，够用且省 DOM） */
function hl(text: string): string {
  const q = filterDebounced.value
  if (!q) return escapeHtml(text)
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return escapeHtml(text)
  return (
    escapeHtml(text.slice(0, at)) +
    `<mark class="launcher-mark">${escapeHtml(text.slice(at, at + q.length))}</mark>` +
    escapeHtml(text.slice(at + q.length))
  )
}

function displayValue(idx: number): string {
  const tree = props.tree
  if (!tree) return ''
  if (isContainerKind(tree.kind[idx])) return tree.preview[idx]
  const raw = tree.value[idx]
  if (tree.kind[idx] === KIND.string) {
    const shown = JSON.stringify(raw)
    return tree.truncated && shown.length > 290 ? shown.slice(0, 290) + '…"' : shown
  }
  return raw
}
</script>

<template>
  <div class="flex h-full w-full flex-col bg-panel">
    <div class="flex items-center gap-2 border-b border-line px-3 py-2">
      <div class="relative flex-1">
        <UiIcon name="search" :size="13" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input v-model="filter" class="launcher-input pl-7" placeholder="过滤键或值…" spellcheck="false" />
      </div>
      <button class="launcher-btn ghost" title="展开两层" @click="expandDepth(2)">
        <UiIcon name="chevronDown" :size="13" />2 层
      </button>
      <button class="launcher-btn ghost" title="全部展开" @click="expandAll">展开</button>
      <button class="launcher-btn ghost" title="全部折叠" @click="collapseAll">折叠</button>
      <span class="launcher-chip">{{ tree?.nodeCount ?? 0 }} 节点</span>
    </div>

    <!-- 选中节点的路径 + 复制 -->
    <div class="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-[11.5px]">
      <UiIcon name="branch" :size="12" class="shrink-0 text-faint" />
      <div class="min-w-0 flex-1 truncate font-mono text-muted" :title="selectedPath">
        <template v-if="crumbs.clipped">… / </template>
        <template v-for="(idx, i) in crumbs.parts" :key="idx">
          <button
            class="rounded px-0.5 hover:text-fg hover:underline"
            :class="idx === selected ? 'text-fg' : ''"
            @click="revealNode(idx)"
          >
            {{ tree && idx === 0 ? '$' : tree?.key[idx] }}
          </button>
          <span v-if="i < crumbs.parts.length - 1" class="text-faint">/</span>
        </template>
      </div>
      <button class="launcher-btn ghost !px-1.5" title="复制路径（JSONPath）" @click="copyPath">
        <UiIcon name="link" :size="12" />路径
      </button>
      <button class="launcher-btn ghost !px-1.5" title="复制该节点的值（容器为 JSON）" @click="copyValue">
        <UiIcon name="copy" :size="12" />值
      </button>
      <button v-if="showLine !== false" class="launcher-btn ghost !px-1.5" title="在文本视图里定位这一行" @click="revealSource">
        <UiIcon name="external" :size="12" />定位
      </button>
    </div>

    <div ref="scroller" class="launcher-scroll relative flex-1 outline-none" tabindex="0">
      <div class="relative" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(idx, i) in visibleRows"
          :key="idx"
          class="absolute left-0 right-0 flex h-[24px] cursor-default items-center gap-1.5 overflow-hidden whitespace-nowrap pr-2 font-mono text-[12.5px] leading-[24px]"
          :class="{ 'bg-active': idx === selected }"
          :style="{ top: (startIndex + i) * ROW + 'px' }"
          @click="rowClick(idx)"
        >
          <button
            v-if="showLine !== false && tree"
            class="launcher-tree-line"
            :class="{ '!text-accent': idx === selected }"
            :style="{ width: lineWidth + 'px' }"
            title="在文本视图里定位这一行"
            @click.stop="emit('reveal', tree.line[idx])"
          >
            {{ tree.line[idx] }}
          </button>

          <span :style="indentStyle(tree?.depth[idx] ?? 0)" class="flex min-w-0 items-center gap-1.5">
            <UiIcon
              v-if="tree && isContainerKind(tree.kind[idx])"
              :name="expanded.has(idx) ? 'chevronDown' : 'chevronRight'"
              :size="12"
              class="shrink-0 text-muted"
            />
            <span v-else class="w-3 shrink-0 text-center text-faint">·</span>
            <span class="text-[color:var(--launcher-key)]" v-html="hl(tree?.key[idx] ?? '')" />
            <span class="text-faint">:</span>
            <span
              v-if="tree && isContainerKind(tree.kind[idx])"
              class="truncate text-muted"
              v-html="hl(displayValue(idx))"
            />
            <span v-else :class="valueClass(tree?.kind[idx] ?? 0)" class="truncate" v-html="hl(displayValue(idx))" />
          </span>

          <span
            v-if="tree"
            class="launcher-kind ml-auto shrink-0 rounded px-1 py-[1px] text-[10px] leading-[13px]"
            :class="[kindClass(tree.kind[idx]), matched?.matched.has(idx) ? 'ring-1 ring-accent' : '']"
          >
            {{ kindLabel(tree.kind[idx]) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
