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
  /** 插件 id → 清单简介：hover 时展示（结果项本身不带顶层 description） */
  pluginDescriptions: Record<string, string>
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

// ── 插件简介：hover 延迟展示，离开 / 滚动立即收起 ──────────────
interface IntroPayload {
  title: string
  text: string
  left: number
  top: number
  bottom: number
  width: number
}

const INTRO_DELAY_MS = 320
const intro = ref<IntroPayload | null>(null)
let introTimer = 0

function showIntro(payload: IntroPayload): void {
  window.clearTimeout(introTimer)
  introTimer = window.setTimeout(() => {
    intro.value = payload
  }, INTRO_DELAY_MS)
}

function hideIntro(): void {
  window.clearTimeout(introTimer)
  introTimer = 0
  intro.value = null
}

function onScrollWithIntro(event: Event): void {
  hideIntro()
  onScroll(event)
}

/** 优先放在格子下方；下方放不下且上方有空间就翻到上方，左右夹在视口内 */
const introStyle = computed<Record<string, string>>(() => {
  const tip = intro.value
  if (!tip) return {}
  const gap = 8
  const half = 160
  const left = Math.min(Math.max(tip.left + tip.width / 2, half), window.innerWidth - half)
  const below = tip.bottom + gap
  if (below + 100 <= window.innerHeight) {
    return { left: `${left}px`, top: `${below}px`, transform: 'translateX(-50%)' }
  }
  return {
    left: `${left}px`,
    top: `${tip.top - gap}px`,
    transform: 'translate(-50%, -100%)',
  }
})

function introTitleOf(result: RankedResult, group: GridRow['group']): string {
  return group === 'plugins' ? result.pluginTitle : result.item.title
}

function introTextOf(result: RankedResult, group: GridRow['group']): string {
  const plugin = props.pluginDescriptions[result.pluginId] ?? ''
  if (group === 'plugins') return plugin || result.item.subtitle || ''
  return result.item.subtitle || plugin || ''
}

onUnmounted(() => hideIntro())
</script>

<template>
  <div
    ref="container"
    class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar relative"
    @scroll="onScrollWithIntro"
    @click="onBackgroundClick"
  >
    <div
      :style="{
        '--grid-cols': String(columns),
        padding: '8px 12px',
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
              :intro-title="introTitleOf(result, item.row.group)"
              :intro-text="introTextOf(result, item.row.group)"
              @hover="(index) => !drag?.active && emit('hover', index)"
              @activate="(index) => !drag?.active && emit('activate', index)"
              @context="(index, event) => emit('context', index, event)"
              @grab="(event) => startDrag(result, event)"
              @intro="showIntro"
              @intro-leave="hideIntro"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- 插件简介：fixed 定位，避开选中框；只作提示，不接收指针 -->
    <Transition name="motion-fade" :duration="{ enter: 120, leave: 90 }">
      <div v-if="intro" class="intro-tip" :style="introStyle" role="tooltip">
        <div class="intro-title">{{ intro.title }}</div>
        <p class="intro-text">{{ intro.text }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.grid-row {
  display: grid;
  grid-template-columns: repeat(var(--grid-cols, 7), minmax(0, 1fr));
  gap: 0 4px;
}

/* 插件简介：一块抬升的表面，固定定位在格子下方；不遮选中框、不吃指针 */
.intro-tip {
  position: fixed;
  z-index: 55;
  width: max-content;
  max-width: 300px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-strong);
  box-shadow: var(--elev-2);
  -webkit-backdrop-filter: blur(var(--glass-blur));
  backdrop-filter: blur(var(--glass-blur));
  color: var(--fg);
  font-size: 12px;
  line-height: 1.45;
  pointer-events: none;
}

.intro-title {
  margin-bottom: 4px;
  font-size: 12.5px;
  font-weight: 500;
}

.intro-text {
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
  color: var(--fg-muted);
}
</style>
