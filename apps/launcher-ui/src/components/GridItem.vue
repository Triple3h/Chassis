<script setup lang="ts">
import { computed } from 'vue'
import IconGlyph from './IconGlyph.vue'
import type { GridMetrics } from '../lib/grid'
import type { RankedResult } from '../lib/types'

const props = defineProps<{
  result: RankedResult
  selected: boolean
  index: number
  metrics: GridMetrics
  /** 非固定分区里标出「已固定」的命中项（固定分区自身不标） */
  showPin?: boolean
  /** 固定区分区里可拖拽重排 */
  draggable?: boolean
  /** 固定区内的序号（拖拽命中用） */
  pinIndex?: number
  dragging?: boolean
  dropTarget?: boolean
}>()

const emit = defineEmits<{
  (e: 'hover', index: number): void
  (e: 'activate', index: number): void
  (e: 'context', index: number, event: MouseEvent): void
  (e: 'grab', event: MouseEvent): void
}>()

interface Segment {
  text: string
  hit: boolean
}

/** 标题命中高亮（内核已算好 span） */
const segments = computed<Segment[]>(() => {
  const title = props.result.item.title ?? ''
  const span = props.result.titleMatch
  if (!span || span.length <= 0 || span.start < 0 || span.start + span.length > title.length) {
    return [{ text: title, hit: false }]
  }
  return [
    { text: title.slice(0, span.start), hit: false },
    { text: title.slice(span.start, span.start + span.length), hit: true },
    { text: title.slice(span.start + span.length), hit: false },
  ].filter((s) => s.text.length > 0)
})

/** 格子里放不下副标题，进 tooltip */
const tooltip = computed(() =>
  [props.result.item.title, props.result.item.subtitle, props.result.pluginTitle].filter(Boolean).join('\n'),
)

/** 图标外框：与 metrics.icon 同尺寸，右侧的角标以它为定位基准 */
const boxStyle = computed(() => ({
  width: `${props.metrics.icon}px`,
  height: `${props.metrics.icon}px`,
}))

const nameStyle = computed(() => {
  const lineHeight = Math.round(props.metrics.name * 1.32)
  return {
    fontSize: `${props.metrics.name}px`,
    lineHeight: `${lineHeight}px`,
    height: `${lineHeight * 2}px`,
  }
})
</script>

<template>
  <div
    class="grid-item group"
    :class="[
      selected ? 'is-selected' : 'hover:bg-[var(--hover)]',
      result.stale ? 'opacity-45' : '',
      dragging ? 'is-dragging' : '',
      dropTarget ? 'is-drop-target' : '',
    ]"
    :style="{ height: `${metrics.itemHeight}px` }"
    :title="tooltip"
    :data-pin-index="draggable ? pinIndex : undefined"
    :data-selected="selected ? 'true' : undefined"
    @mouseenter="emit('hover', index)"
    @click="emit('activate', index)"
    @contextmenu.prevent="emit('context', index, $event)"
    @mousedown="draggable && emit('grab', $event)"
  >
    <span class="grid-icon" :style="boxStyle">
      <IconGlyph :name="result.item.icon ?? 'app-window'" :size="metrics.icon" tile />
      <span v-if="showPin && result.pinned" class="grid-badge pin" title="已固定">
        <IconGlyph name="pin" :size="10" />
      </span>
      <span v-else-if="result.stale" class="grid-badge warn" title="插件不可用">!</span>
    </span>
    <span class="grid-name" :style="nameStyle">
      <template v-for="(seg, i) in segments" :key="i">
        <mark v-if="seg.hit" class="bg-transparent text-[var(--color-accent)] font-semibold">{{ seg.text }}</mark>
        <span v-else>{{ seg.text }}</span>
      </template>
    </span>
  </div>
</template>

<style scoped>
.grid-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 4px;
  border-radius: 10px;
  cursor: default;
  user-select: none;
  overflow: hidden;
  /* 四个状态的过渡一次写全：选中、置灰、拖起、落点。
     以前只有背景色有过渡，其余三个是瞬跳，一起用才像同一套手感。 */
  transition:
    background-color var(--motion-instant) var(--motion-ease-move),
    opacity var(--motion-instant) var(--motion-ease-move),
    box-shadow var(--motion-instant) var(--motion-ease-move),
    transform var(--motion-instant) var(--motion-ease-move);
}

.grid-item.is-selected {
  background: var(--sel);
}

/* 按下去「陷」一下：结果项点下去就执行，这是唯一能给的触感 */
.grid-item:active:not(.is-dragging) {
  transform: scale(0.97);
}

.grid-item.is-dragging {
  opacity: 0.4;
  transform: scale(0.94);
}

.grid-item.is-drop-target {
  box-shadow: inset 0 0 0 2px var(--color-accent);
}

.grid-icon {
  position: relative;
  flex-shrink: 0;
  display: block;
}

.grid-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 1.5px solid var(--bg-solid);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.grid-badge.pin {
  background: var(--color-accent);
  color: #fff;
}

.grid-badge.warn {
  background: var(--fg-muted);
  color: var(--bg-solid);
}

.grid-name {
  width: 100%;
  font-weight: 500;
  text-align: center;
  word-break: break-word;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
</style>
