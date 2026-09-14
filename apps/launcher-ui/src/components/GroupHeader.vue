<script setup lang="ts">
defineProps<{ label: string; count?: number; collapsed?: boolean; collapsible?: boolean }>()
defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div class="flex items-center gap-2 px-4 h-[30px] text-[10.5px] uppercase tracking-wider text-[var(--fg-muted)]">
    <span>{{ label }}</span>
    <span v-if="count !== undefined" class="tabular-nums opacity-70">{{ count }}</span>
    <button
      v-if="collapsible"
      type="button"
      class="ml-auto text-[10.5px] normal-case tracking-normal rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
      @click.stop="$emit('toggle')"
    >
      {{ collapsed ? '展开' : '收起' }}
    </button>
  </div>
</template>
