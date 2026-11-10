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
  /** hover 简介的标题与正文（插件入口用清单 description） */
  introTitle?: string
  introText?: string
}>()

interface IntroPayload {
  title: string
  text: string
  left: number
  top: number
  bottom: number
  width: number
}

const emit = defineEmits<{
  (e: 'hover', index: number): void
  (e: 'activate', index: number): void
  (e: 'context', index: number, event: MouseEvent): void
  (e: 'grab', event: MouseEvent): void
  (e: 'intro', payload: IntroPayload): void
  (e: 'introLeave'): void
}>()

function onEnter(event: MouseEvent): void {
  emit('hover', props.index)
  const text = props.introText?.trim()
  if (!text) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit('intro', {
    title: props.introTitle || props.result.item.title,
    text,
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
  })
}

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
    maxHeight: `${lineHeight * 2}px`,
  }
})
</script>

<template>
  <div
    class="grid-item group"
    :class="[
      selected ? 'is-selected' : '',
      result.stale ? 'opacity-45' : '',
      dragging ? 'is-dragging' : '',
      dropTarget ? 'is-drop-target' : '',
    ]"
    :style="{ height: `${metrics.itemHeight}px` }"
    :data-pin-index="draggable ? pinIndex : undefined"
    :data-selected="selected ? 'true' : undefined"
    @mouseenter="onEnter"
    @mouseleave="emit('introLeave')"
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
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 8px 4px;
  border-radius: var(--radius-md);
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

.grid-item:hover:not(.is-selected) {
  background: color-mix(in srgb, var(--panel) 38%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--glass-hi) 65%, transparent);
}

.grid-item.is-selected {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--glass-hi) 62%, transparent), transparent 86%),
    color-mix(in srgb, var(--color-accent) 10%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--glass-hi) 85%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent),
    0 10px 22px -18px color-mix(in srgb, var(--color-accent) 55%, transparent);
}

.grid-item.is-selected .grid-name {
  font-weight: 600;
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
  transition: transform var(--motion-instant) var(--motion-ease-move);
}

.grid-item:hover .grid-icon {
  transform: translateY(-1px);
}

/* 选中 / 悬停时磁贴边缘亮起 —— 图标是格子里最重的视觉锚点 */
.grid-item.is-selected :deep(.icon-tile) {
  color: var(--fg);
  border-color: color-mix(in srgb, var(--color-accent) 48%, transparent);
  box-shadow:
    inset 0 1px 0 var(--glass-hi),
    0 0 0 1px color-mix(in srgb, var(--color-accent) 26%, transparent),
    0 12px 24px -14px color-mix(in srgb, var(--color-accent) 55%, transparent);
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
  border: 1.5px solid color-mix(in srgb, var(--panel-strong) 92%, transparent);
  box-shadow: 0 2px 6px -2px var(--tile-shadow);
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
  text-shadow: 0 1px 0 color-mix(in srgb, var(--glass-hi) 40%, transparent);
}
</style>
