<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import IconGlyph from './IconGlyph.vue'

const props = defineProps<{ modelValue: string; placeholder?: string; busy?: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'settings'): void
}>()

const input = ref<HTMLInputElement | null>(null)

const placeholderText = computed(() => props.placeholder || '搜索')

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
  <div class="search-row flex items-center gap-3 px-4 h-[56px] shrink-0" data-drag-region>
    <div class="search-well">
      <span class="search-glyph"><IconGlyph name="search" :size="18" /></span>
      <input
        ref="input"
        :value="modelValue"
        :placeholder="placeholderText"
        class="search-input"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        @input="onInput"
      />
      <div v-if="busy" class="search-busy">
        <IconGlyph name="loader" :size="14" />
      </div>
    </div>
    <!-- 宿主注入的尾部件（CPU / 内存状态条、恢复默认大小） -->
    <slot name="trailing" />
    <button type="button" class="settings-btn" title="设置 (⌘,)" @click="emit('settings')">
      <IconGlyph name="settings" :size="17" />
    </button>
  </div>
</template>

<style scoped>
/* 搜索井：一块下沉表面，焦点时亮起一条蓝边 */
.search-well {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--sunken);
  transition:
    border-color var(--motion-fast) var(--motion-ease-move),
    background-color var(--motion-fast) var(--motion-ease-move),
    box-shadow var(--motion-fast) var(--motion-ease-move);
}

.search-well:focus-within {
  border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 20%, transparent);
}

.search-glyph {
  flex: none;
  display: inline-flex;
  color: var(--fg-muted);
  transition: color var(--motion-fast) var(--motion-ease-move);
}

.search-well:focus-within .search-glyph {
  color: var(--color-accent);
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--fg);
  font-size: var(--text-hero);
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1;
}

.search-input::placeholder {
  color: var(--fg-muted);
  font-weight: 400;
  letter-spacing: 0;
}

.search-busy {
  flex: none;
  display: inline-flex;
  color: var(--fg-muted);
  animation: search-spin 0.9s linear infinite;
}

@keyframes search-spin {
  to {
    transform: rotate(360deg);
  }
}

.settings-btn {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  border: 1px solid var(--border);
  background: transparent;
  transition:
    color var(--motion-instant) var(--motion-ease-move),
    background-color var(--motion-instant) var(--motion-ease-move),
    border-color var(--motion-instant) var(--motion-ease-move),
    transform var(--motion-instant) var(--motion-ease-move);
}

.settings-btn:hover {
  color: var(--fg);
  background: var(--hover);
}

.settings-btn:active {
  transform: scale(0.94);
}
</style>
