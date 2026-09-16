<script setup lang="ts">
import { computed } from 'vue'
import { iconPath } from '../lib/icons'

const props = withDefaults(defineProps<{ name?: string; size?: number; tile?: boolean }>(), {
  size: 20,
  tile: false,
})

const isRemote = computed(() => Boolean(props.name && /^(https?:|data:)/.test(props.name)))
const path = computed(() => iconPath(props.name))
const radius = computed(() => `${Math.round(props.size * 0.22)}px`)
const initials = computed(() => {
  const raw = props.name ?? ''
  return raw.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 1).toUpperCase() || '·'
})
/** 磁贴模式下字形只占外框的 56%（对照 ZTools 的 AppList 占位图标） */
const glyphSize = computed(() => (props.tile ? Math.round(props.size * 0.56) : props.size))
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <img
    v-if="isRemote"
    :src="name"
    :width="size"
    :height="size"
    class="shrink-0 object-contain"
    :style="{ borderRadius: radius }"
    alt=""
    draggable="false"
  />
  <span
    v-else-if="path"
    class="shrink-0 flex items-center justify-center"
    :class="tile ? 'bg-[var(--hover)] text-[var(--fg-muted)]' : 'text-[var(--fg-muted)]'"
    :style="tile ? { ...box, borderRadius: radius } : undefined"
  >
    <svg
      :width="glyphSize"
      :height="glyphSize"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path :d="path" />
    </svg>
  </span>
  <span
    v-else
    class="shrink-0 flex items-center justify-center bg-[var(--hover)] font-semibold text-[var(--fg-muted)]"
    :style="{ ...box, borderRadius: radius, fontSize: `${Math.round(size * 0.42)}px` }"
    >{{ initials }}</span
  >
</template>
