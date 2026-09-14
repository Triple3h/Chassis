<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import IconGlyph from './IconGlyph.vue'

const props = defineProps<{ modelValue: string; placeholder?: string; busy?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const input = ref<HTMLInputElement | null>(null)

const placeholderText = computed(() => props.placeholder || '搜索命令、应用、文件…')

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
  <div class="flex items-center gap-2.5 px-4 h-[54px]">
    <IconGlyph name="search" :size="18" />
    <input
      ref="input"
      :value="modelValue"
      :placeholder="placeholderText"
      class="flex-1 bg-transparent border-0 outline-none text-[15px] placeholder:text-[var(--fg-muted)]"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @input="onInput"
    />
    <div v-if="busy" class="text-[var(--fg-muted)] animate-spin">
      <IconGlyph name="loader" :size="14" />
    </div>
  </div>
</template>
