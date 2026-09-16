<script setup lang="ts">
/** 二级面板：覆盖在网格右侧（不挤压网格列数），ZTools 的 DetailPanel 同款做法 */
defineProps<{ title: string; text: string }>()
defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div
    class="detail-panel absolute inset-y-0 right-0 z-20 w-[320px] border-l border-[var(--border)] bg-[var(--panel)] backdrop-blur-xl flex flex-col"
  >
    <div class="flex items-center gap-2 px-3 h-[38px] shrink-0">
      <span class="text-[11px] uppercase tracking-wider text-[var(--fg-muted)] truncate">{{ title }}</span>
      <button
        type="button"
        class="ml-auto rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--hover)]"
        @click="$emit('close')"
      >
        ← 收起
      </button>
    </div>
    <pre class="flex-1 overflow-auto px-3 pb-3 text-[12px] leading-relaxed whitespace-pre-wrap break-words font-sans">{{
      text
    }}</pre>
  </div>
</template>

<style scoped>
.detail-panel {
  animation: detail-slide-in 0.18s ease-out;
  box-shadow: -18px 0 36px rgba(15, 23, 42, 0.12);
}

@keyframes detail-slide-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
</style>
