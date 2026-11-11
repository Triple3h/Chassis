<script setup lang="ts">
/** 分区标题：左「最近使用」右「展开 (19) / 收起」，整行可点 */
defineProps<{ label: string; total: number; expanded: boolean; collapsible: boolean; height: number }>()
defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div
    class="section-header flex items-center"
    :class="collapsible ? 'is-collapsible' : ''"
    :style="{ height: `${height}px` }"
    @click="collapsible && $emit('toggle')"
  >
    <span class="section-title">{{ label }}</span>
    <span class="section-rule" aria-hidden="true" />
    <span v-if="collapsible" class="section-action">{{ expanded ? '收起' : `展开 (${total})` }}</span>
  </div>
</template>

<style scoped>
.section-header {
  padding: 0 12px;
  gap: 8px;
  user-select: none;
  transition: background-color var(--motion-instant) var(--motion-ease-move);
}

.section-header.is-collapsible {
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.section-header.is-collapsible:hover {
  background: var(--hover);
}

.section-title {
  flex: none;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--fg-muted);
}

/* 标题右侧的发丝线：把“分区”这件事画出来，而不是只靠字号 */
.section-rule {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.section-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--fg-muted);
  opacity: 0.85;
  transition:
    opacity var(--motion-instant) var(--motion-ease-move),
    color var(--motion-instant) var(--motion-ease-move);
}

.section-header:hover .section-action {
  opacity: 1;
  color: var(--fg);
}
</style>
