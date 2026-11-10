<script setup lang="ts">
/**
 * 插件页图标：**与宿主共用同一份字典**（`packages/ui/lib/icons.ts`）。
 * 命名、描边、光学尺寸只在那一处维护 —— 插件页与启动台网格不会出现两套风格。
 */
import { computed } from 'vue'
import { iconMarkup } from '../lib/icons'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number | string
    /** 描边粗细 */
    weight?: number
  }>(),
  { size: 16, weight: 1.75 },
)

const markup = computed(() => iconMarkup(props.name) ?? iconMarkup('info') ?? '')
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="props.weight"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
    v-html="markup"
  />
</template>
