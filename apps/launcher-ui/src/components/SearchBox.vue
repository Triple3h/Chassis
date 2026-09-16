<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import IconGlyph from './IconGlyph.vue'

const props = defineProps<{ modelValue: string; placeholder?: string; busy?: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'settings'): void
}>()

const input = ref<HTMLInputElement | null>(null)

const placeholderText = computed(() => props.placeholder || '搜索应用、命令或文件…')

watch(
  () => props.modelValue,
  (value) => {
    const el = input.value
    if (el && el.value !== value) el.value = value
  },
)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function focus(): void {
  input.value?.focus()
  input.value?.select()
}

defineExpose({ focus, input })
</script>

<template>
  <div class="flex items-center gap-3 px-4 h-[58px] shrink-0">
    <IconGlyph name="search" :size="20" />
    <input
      ref="input"
      :value="modelValue"
      :placeholder="placeholderText"
      class="flex-1 bg-transparent border-0 outline-none text-[20px] font-light placeholder:text-[var(--fg-muted)]"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @input="onInput"
    />
    <div v-if="busy" class="text-[var(--fg-muted)] animate-spin shrink-0">
      <IconGlyph name="loader" :size="15" />
    </div>
    <button
      type="button"
      class="shrink-0 w-[34px] h-[34px] rounded-full flex items-center justify-center text-[var(--fg-muted)] bg-[var(--hover)] hover:text-[var(--color-accent)] transition-colors"
      title="设置 (⌘,)"
      @click="emit('settings')"
    >
      <IconGlyph name="settings" :size="17" />
    </button>
  </div>
</template>
