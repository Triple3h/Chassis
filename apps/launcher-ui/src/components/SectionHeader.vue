<script setup lang="ts">
/** 分区标题：左「最近使用」右「展开 (19) / 收起」，整行可点（对照 ZTools 的 CollapsibleList） */
defineProps<{ label: string; total: number; expanded: boolean; collapsible: boolean; height: number }>()
defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div
    class="section-header flex items-center"
    :class="collapsible ? 'cursor-pointer hover:bg-[var(--hover)]' : ''"
    :style="{ height: `${height}px` }"
    @click="collapsible && $emit('toggle')"
  >
    <span class="section-title">{{ label }}</span>
    <span v-if="collapsible" class="section-action">{{ expanded ? '收起' : `展开 (${total})` }}</span>
  </div>
</template>

<style scoped>
.section-header {
  padding: 0 12px;
  user-select: none;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
}

.section-action {
  margin-left: auto;
  font-size: 12px;
  opacity: 0.6;
}

.section-header:hover .section-action {
  opacity: 1;
}
</style>
