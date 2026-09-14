<script setup lang="ts">
defineProps<{ title: string; text: string }>()
defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div class="w-[300px] shrink-0 border-l border-[var(--border)] bg-[var(--panel)] flex flex-col">
    <div class="flex items-center gap-2 px-3 h-[38px]">
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
