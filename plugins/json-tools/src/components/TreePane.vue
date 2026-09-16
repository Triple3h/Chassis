<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import UiIcon from '@shared/ui/UiIcon.vue'
import { useVirtualList } from '@shared/lib/virtual'
import { useToast } from '@shared/lib/toast'
import { copyText } from '@shared/lib/clipboard'
import { KIND, isContainerKind, matchNodes, projectRows, type FlatTree } from '../core/tree'

const props = defineProps<{ tree: FlatTree | null }>()

const ROW = 22
const INDENT = 14
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

const visible = computed(() => {
  if (!props.tree || !filterDebounced.value) return null
  return matchNodes(props.tree, filterDebounced.value).visible
})

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
  else copyValue(idx)
}

async function copyValue(idx: number) {
  const tree = props.tree
  if (!tree) return
  const kind = tree.kind[idx]
  const raw =
    kind === KIND.string
      ? JSON.stringify(tree.value[idx])
      : isContainerKind(kind)
        ? tree.preview[idx]
        : tree.value[idx]
  if (await copyText(raw)) toast.ok('已复制该节点的值')
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
      rowClick(selected.value)
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
  return { paddingLeft: 8 + depth * INDENT + 'px' }
}

function kindClass(kind: number) {
  switch (kind) {
    case KIND.string:
      return 'text-[color:var(--launcher-string)]'
    case KIND.number:
      return 'text-[color:var(--launcher-number)]'
    case KIND.boolean:
    case KIND.null:
      return 'text-[color:var(--launcher-code)]'
    default:
      return 'text-muted'
  }
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

    <div ref="scroller" class="launcher-scroll relative flex-1 outline-none" tabindex="0">
      <div class="relative" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(idx, i) in visibleRows"
          :key="idx"
          class="absolute left-0 right-0 flex items-center gap-1.5 overflow-hidden whitespace-nowrap pr-3 font-mono text-[12.5px] leading-[22px] h-[22px] cursor-default"
          :class="{ 'bg-active': idx === selected }"
          :style="{ top: (startIndex + i) * ROW + 'px' }"
          @click="rowClick(idx)"
        >
          <span :style="indentStyle(tree?.depth[idx] ?? 0)" class="flex items-center gap-1.5 min-w-0">
            <UiIcon
              v-if="tree && isContainerKind(tree.kind[idx])"
              :name="expanded.has(idx) ? 'chevronDown' : 'chevronRight'"
              :size="12"
              class="text-muted"
            />
            <span v-else class="w-3 text-center text-faint">·</span>
            <span class="text-[color:var(--launcher-key)]">{{ tree?.key[idx] }}</span>
            <span class="text-faint">:</span>
            <span v-if="tree && isContainerKind(tree.kind[idx])" class="text-muted">{{ tree.preview[idx] }}</span>
            <span v-else :class="kindClass(tree?.kind[idx] ?? 0)" class="truncate">
              {{ tree?.kind[idx] === KIND.string ? JSON.stringify(tree.value[idx]) : tree?.value[idx] }}
            </span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
