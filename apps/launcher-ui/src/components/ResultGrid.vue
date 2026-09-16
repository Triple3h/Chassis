<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import GridItem from './GridItem.vue'
import SectionHeader from './SectionHeader.vue'
import { GRID_HEADER_HEIGHT, displayRowIndex, type GridMetrics, type GridRow } from '../lib/grid'
import { useVirtualRows } from '../lib/virtual'
import type { RankedResult } from '../lib/types'

const props = defineProps<{
  rows: GridRow[]
  selectedIndex: number
  metrics: GridMetrics
  columns: number
  viewportHeight: number
  /** 固定区当前可拖拽重排（空输入且已展开） */
  pinDraggable: boolean
}>()

const emit = defineEmits<{
  (e: 'hover', index: number): void
  (e: 'activate', index: number): void
  (e: 'context', index: number, event: MouseEvent): void
  (e: 'toggle', group: string): void
  (e: 'reorder', payload: { from: RankedResult; to: RankedResult }): void
  (e: 'measure', width: number): void
  (e: 'background'): void
}>()

const container = ref<HTMLElement | null>(null)
const rowsRef = computed(() => props.rows)
const viewportRef = computed(() => props.viewportHeight)
const heightOf = (row: GridRow): number => (row.kind === 'header' ? GRID_HEADER_HEIGHT : props.metrics.itemHeight)

const { enabled, visible, totalHeight, offsetTop, onScroll, scrollIndexIntoView } = useVirtualRows(
  rowsRef,
  heightOf,
  viewportRef as never,
)

let observer: ResizeObserver | null = null

watch(
  () => props.selectedIndex,
  (index) => scrollIndexIntoView(displayRowIndex(props.rows, index), container.value),
)
watch(
  () => props.rows,
  () => scrollIndexIntoView(displayRowIndex(props.rows, props.selectedIndex), container.value),
)

onMounted(() => {
  scrollIndexIntoView(displayRowIndex(props.rows, props.selectedIndex), container.value)
  emit('measure', Math.round(container.value?.clientWidth ?? 0))
  observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width) emit('measure', Math.round(width))
  })
  if (container.value) observer.observe(container.value)
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
  stopDrag()
})

/** 固定区序号 → 结果项（拖拽落点解析） */
const pinMap = computed(() => {
  const map = new Map<number, RankedResult>()
  for (const row of props.rows) {
    if (row.kind !== 'items' || row.group !== 'pinned') continue
    row.items.forEach((item, i) => map.set(row.start + i, item))
  }
  return map
})

// ── 固定项拖拽重排（HTML5 DnD 在 WebView 里不可靠，改用指针事件） ──
const drag = ref<{ from: RankedResult; over: RankedResult | null; active: boolean } | null>(null)
let dragOrigin: { x: number; y: number } | null = null

function startDrag(result: RankedResult, event: MouseEvent): void {
  if (!props.pinDraggable || event.button !== 0) return
  dragOrigin = { x: event.clientX, y: event.clientY }
  drag.value = { from: result, over: null, active: false }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', endDrag)
}

function onDragMove(event: MouseEvent): void {
  const state = drag.value
  const origin = dragOrigin
  if (!state || !origin) return
  if (!state.active) {
    if (Math.abs(event.clientX - origin.x) < 5 && Math.abs(event.clientY - origin.y) < 5) return
    state.active = true
    document.body.style.userSelect = 'none'
  }
  const hit = document.elementFromPoint(event.clientX, event.clientY)
  const holder = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-pin-index]') : null
  const index = holder?.dataset.pinIndex
  const target = index === undefined ? null : (pinMap.value.get(Number(index)) ?? null)
  state.over = target && target.itemKey !== state.from.itemKey ? target : null
}

function endDrag(): void {
  const state = drag.value
  stopDrag()
  if (!state?.active || !state.over) return
  emit('reorder', { from: state.from, to: state.over })
}

function stopDrag(): void {
  drag.value = null
  dragOrigin = null
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', endDrag)
}

function onBackgroundClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('.grid-item') || target?.closest('.section-header')) return
  emit('background')
}
</script>

<template>
  <div
    ref="container"
    class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar relative"
    @scroll="onScroll"
    @click="onBackgroundClick"
  >
    <div
      :style="{
        '--grid-cols': String(columns),
        padding: '6px 12px',
        ...(enabled ? { height: `${totalHeight}px`, position: 'relative' } : {}),
      }"
    >
      <div :style="enabled ? { transform: `translateY(${offsetTop}px)` } : undefined">
        <template v-for="item in visible" :key="item.row.key">
          <SectionHeader
            v-if="item.row.kind === 'header'"
            :label="item.row.label"
            :total="item.row.total"
            :expanded="item.row.expanded"
            :collapsible="item.row.collapsible"
            :height="GRID_HEADER_HEIGHT"
            @toggle="emit('toggle', item.row.group)"
          />
          <div v-else class="grid-row">
            <GridItem
              v-for="(result, i) in item.row.items"
              :key="result.itemKey"
              :result="result"
              :metrics="metrics"
              :selected="item.row.start + i === selectedIndex"
              :index="item.row.start + i"
              :show-pin="item.row.group !== 'pinned'"
              :draggable="pinDraggable && item.row.group === 'pinned'"
              :pin-index="item.row.start + i"
              :dragging="drag?.active === true && drag.from.itemKey === result.itemKey"
              :drop-target="drag?.over?.itemKey === result.itemKey"
              @hover="(index) => !drag?.active && emit('hover', index)"
              @activate="(index) => !drag?.active && emit('activate', index)"
              @context="(index, event) => emit('context', index, event)"
              @grab="(event) => startDrag(result, event)"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid-row {
  display: grid;
  grid-template-columns: repeat(var(--grid-cols, 7), minmax(0, 1fr));
  gap: 0;
}
</style>
