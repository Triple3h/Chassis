<script setup lang="ts">
import UiIcon from './UiIcon.vue'

/**
 * 空状态：图标 + 一句说明 + 可选的下一步。
 *
 * 以前每个插件自己拼：有的图标+标题+正文+主按钮，有的只有一行字，有的干脆没有
 * （空文档、加载中）。统一这里，三段都可省：
 *   <EmptyState icon="clipboard" title="还没有快贴" hint="按 ⌘N 存一条" />
 *   <EmptyState title="还没有账户">
 *     <template #actions><button class="launcher-btn primary">扫码导入</button></template>
 *   </EmptyState>
 *
 * 列表内的「过滤后为空」也跟着用，标题换成「没有匹配的…」。
 */
defineProps<{
  icon?: string
  title: string
  hint?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <slot name="icon">
      <UiIcon v-if="icon" :name="icon" :size="24" class="text-faint" />
    </slot>
    <p class="text-[12.5px] text-muted">{{ title }}</p>
    <p v-if="hint" class="max-w-[340px] text-[11px] leading-4 text-muted">{{ hint }}</p>
    <div v-if="$slots.actions" class="mt-1.5 flex items-center gap-1.5">
      <slot name="actions" />
    </div>
  </div>
</template>
