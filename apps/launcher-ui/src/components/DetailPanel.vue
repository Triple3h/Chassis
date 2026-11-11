<script setup lang="ts">
/** 二级面板：覆盖在网格右侧（不挤压网格列数） */
defineProps<{ title: string; text: string }>()
defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div
    class="detail-panel glass-strong absolute inset-y-0 right-0 z-20 w-[320px] flex flex-col overflow-hidden rounded-l-2xl"
  >
    <div class="flex items-center gap-2 px-3.5 h-[40px] shrink-0 border-b border-[var(--border)]">
      <span class="text-[11.5px] font-medium text-[var(--fg-muted)] truncate">{{ title }}</span>
      <button
        type="button"
        class="detail-close ml-auto rounded-md px-2 py-0.5 text-[11.5px]"
        @click="$emit('close')"
      >
        ← 收起
      </button>
    </div>
    <pre class="flex-1 overflow-auto px-4 pb-4 pt-3 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words font-sans">{{
      text
    }}</pre>
  </div>
</template>

<style scoped>
/* 进出场由 App.vue 的 <Transition name="motion-slide-right"> 负责：
   放在父组件才能拿到离场（组件自己被 v-if 卸载时，内部的动画是来不及播的）。
   这里只留不参与动效的静态表现。 */
.detail-panel {
  border-left: 1px solid var(--border);
}

.detail-close {
  color: var(--fg-muted);
  border: 1px solid transparent;
  transition:
    color var(--motion-instant) var(--motion-ease-move),
    background-color var(--motion-instant) var(--motion-ease-move),
    border-color var(--motion-instant) var(--motion-ease-move);
}

.detail-close:hover {
  color: var(--fg);
  background: color-mix(in srgb, var(--panel) 55%, transparent);
  border-color: var(--border);
}
</style>
