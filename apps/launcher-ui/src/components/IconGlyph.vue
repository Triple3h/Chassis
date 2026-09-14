<script setup lang="ts">
import { computed } from 'vue'
import { iconPath } from '../lib/icons'

const props = withDefaults(defineProps<{ name?: string; size?: number }>(), { size: 20 })

const isRemote = computed(() => Boolean(props.name && /^(https?:|data:)/.test(props.name)))
const path = computed(() => iconPath(props.name))
const initials = computed(() => {
  const raw = props.name ?? ''
  return raw.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 1).toUpperCase() || '·'
})
</script>

<template>
  <img
    v-if="isRemote"
    :src="name"
    :width="size"
    :height="size"
    class="shrink-0 rounded-[5px] object-contain"
    alt=""
    draggable="false"
  />
  <svg
    v-else-if="path"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0 text-[var(--fg-muted)]"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
  <span
    v-else
    class="shrink-0 rounded-[5px] bg-[var(--hover)] text-[10px] font-semibold flex items-center justify-center text-[var(--fg-muted)]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    >{{ initials }}</span
  >
</template>
