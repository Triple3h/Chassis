<script setup lang="ts">
import { computed } from 'vue'
import IconGlyph from './IconGlyph.vue'
import type { RankedResult } from '../lib/types'

const props = defineProps<{ result: RankedResult; selected: boolean; index: number }>()
defineEmits<{ (e: 'hover', index: number): void; (e: 'activate', index: number): void; (e: 'context', index: number, event: MouseEvent): void }>()

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

const hint = computed(() => (props.result.item.actions?.length ? '⌘K' : ''))
</script>

<template>
  <div
    class="group flex items-center gap-3 px-3 mx-1.5 rounded-[10px] cursor-default select-none"
    :class="[selected ? 'bg-[var(--sel)]' : 'hover:bg-[var(--hover)]', result.stale ? 'opacity-50' : '']"
    :style="{ height: 'calc(var(--row-height) - 4px)' }"
    @mouseenter="$emit('hover', index)"
    @click="$emit('activate', index)"
    @contextmenu.prevent="$emit('context', index, $event)"
  >
    <IconGlyph :name="result.item.icon ?? 'app-window'" :size="20" />
    <div class="min-w-0 flex-1">
      <div class="row-title truncate">
        <template v-for="(seg, i) in segments" :key="i">
          <mark v-if="seg.hit" class="bg-transparent text-[var(--color-accent)] font-semibold">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </div>
      <div v-if="result.item.subtitle" class="row-subtitle truncate">{{ result.item.subtitle }}</div>
    </div>
    <span v-if="result.stale" class="text-[10.5px] text-[var(--fg-muted)] shrink-0">插件不可用</span>
    <span v-if="result.pinned" class="text-[var(--color-accent)] shrink-0">
      <IconGlyph name="pin" :size="13" />
    </span>
    <span v-if="result.item.actions?.length" class="kbd shrink-0 opacity-0 group-hover:opacity-100">{{ hint }}</span>
  </div>
</template>
