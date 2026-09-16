<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import UiIcon from './UiIcon.vue'

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** 宽度档位，内容多的时候用 wide */
    size?: 'sm' | 'md' | 'wide'
  }>(),
  { size: 'md' },
)

const emit = defineEmits<{ (e: 'close'): void }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onUnmounted(() => window.removeEventListener('keydown', onKey, true))

const widthClass = { sm: 'max-w-[380px]', md: 'max-w-[520px]', wide: 'max-w-[720px]' }[props.size]
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4" @click.self="emit('close')">
    <div
      class="flex max-h-[86vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
      :class="widthClass"
    >
      <header class="flex items-start gap-2 border-b border-line px-4 py-3">
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13.5px] font-semibold">{{ title }}</div>
          <div v-if="subtitle" class="mt-0.5 text-[11.5px] text-muted">{{ subtitle }}</div>
        </div>
        <button class="launcher-btn ghost" title="关闭" @click="emit('close')">
          <UiIcon name="close" :size="14" />
        </button>
      </header>

      <div class="launcher-scroll flex-1 px-4 py-3">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="flex items-center gap-2 border-t border-line px-4 py-2.5">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>
