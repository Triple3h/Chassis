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
  <!-- data-drag-region：这一行（除输入框与按钮外）是「按住拖动窗口」的手柄，见 App.vue -->
  <div class="flex items-center gap-3 px-4 h-[58px] shrink-0" data-drag-region>
    <IconGlyph name="search" :size="20" />
    <input
      ref="input"
      :value="modelValue"
      :placeholder="placeholderText"
      class="flex-1 min-w-0 bg-transparent border-0 outline-none text-[20px] font-light placeholder:text-[var(--fg-muted)]"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @input="onInput"
    />
    <div v-if="busy" class="text-[var(--fg-muted)] animate-spin shrink-0">
      <IconGlyph name="loader" :size="15" />
    </div>
    <!-- 宿主注入的尾部件（当前是 CPU / 内存状态条） -->
    <slot name="trailing" />
    <button type="button" class="settings-btn" title="设置 (⌘,)" @click="emit('settings')">
      <IconGlyph name="settings" :size="17" />
    </button>
  </div>
</template>

<style scoped>
.settings-btn {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  background: var(--hover);
  transition:
    color var(--motion-instant) var(--motion-ease-move),
    background-color var(--motion-instant) var(--motion-ease-move),
    transform var(--motion-instant) var(--motion-ease-move);
}

.settings-btn:hover {
  color: var(--color-accent);
}

.settings-btn:active {
  transform: scale(0.94);
}
</style>
