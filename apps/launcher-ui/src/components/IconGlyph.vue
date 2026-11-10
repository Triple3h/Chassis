<script setup lang="ts">
import { computed } from 'vue'
import { iconMarkup } from '../lib/icons'

const props = withDefaults(defineProps<{ name?: string; size?: number; tile?: boolean }>(), {
  size: 20,
  tile: false,
})

const isRemote = computed(() => Boolean(props.name && /^(https?:|data:)/.test(props.name)))
/** 字典里存的是 svg 子元素（v-html 渲染），未命中就退回首字母占位 */
const markup = computed(() => iconMarkup(props.name))
const radius = computed(() => `${Math.max(8, Math.round(props.size * 0.3))}px`)
const initials = computed(() => {
  const raw = props.name ?? ''
  return raw.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 1).toUpperCase() || '·'
})
/** 磁贴模式下字形只占外框的 54% */
const glyphSize = computed(() => (props.tile ? Math.round(props.size * 0.54) : props.size))
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <img
    v-if="isRemote"
    :src="name"
    :width="size"
    :height="size"
    class="icon-remote shrink-0 object-contain"
    :style="{ borderRadius: radius }"
    alt=""
    draggable="false"
  />
  <span
    v-else-if="markup"
    class="shrink-0 flex items-center justify-center"
    :class="tile ? 'icon-tile text-[var(--fg-muted)]' : 'text-current'"
    :style="tile ? { ...box, borderRadius: radius } : undefined"
  >
    <svg
      :width="glyphSize"
      :height="glyphSize"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      v-html="markup"
    />
  </span>
  <span
    v-else
    class="icon-tile shrink-0 flex items-center justify-center font-semibold text-[var(--fg-muted)]"
    :style="{ ...box, borderRadius: radius, fontSize: `${Math.round(size * 0.42)}px` }"
    >{{ initials }}</span
  >
</template>

<style scoped>
/* 图标磁贴：分层玻璃 —— 斜向镜面 + 冷灰渐变 + 1px 内高光；字形由 currentColor 跟着明暗走 */
.icon-tile {
  background:
    linear-gradient(160deg, var(--tile-sheen), transparent 46%),
    linear-gradient(155deg, var(--tile-from), var(--tile-to));
  border: 1px solid var(--tile-edge);
  box-shadow:
    inset 0 1px 0 var(--glass-hi),
    inset 0 -1px 0 rgba(0, 0, 0, 0.08),
    0 8px 18px -12px var(--tile-shadow);
  transition:
    border-color var(--motion-fast) var(--motion-ease-move),
    box-shadow var(--motion-fast) var(--motion-ease-move);
}

.icon-remote {
  filter: drop-shadow(0 6px 10px var(--tile-shadow));
}
</style>
