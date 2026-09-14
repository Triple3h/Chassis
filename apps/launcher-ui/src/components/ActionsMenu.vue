<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import IconGlyph from './IconGlyph.vue'
import type { ActionDecl } from '@launcher/plugin-manifest'

const props = defineProps<{
  x: number
  y: number
  pinned: boolean
  fromHistory: boolean
  canReveal: boolean
  canDisable: boolean
  pluginId: string
  pluginTitle: string
  extra: Array<{ label: string; action: ActionDecl; icon?: string }>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'togglePin'): void
  (e: 'copyTitle'): void
  (e: 'removeHistory'): void
  (e: 'reveal'): void
  (e: 'disable'): void
  (e: 'uninstall'): void
  (e: 'runExtra', action: ActionDecl): void
}>()

const el = ref<HTMLElement | null>(null)
const pos = ref({ left: props.x, top: props.y })

onMounted(() => {
  const rect = el.value?.getBoundingClientRect()
  if (!rect) return
  const maxX = window.innerWidth - rect.width - 8
  const maxY = window.innerHeight - rect.height - 8
  pos.value = { left: Math.max(8, Math.min(props.x, maxX)), top: Math.max(8, Math.min(props.y, maxY)) }
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('keydown', onKey, true)
})

onUnmounted(() => {
  window.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
})

function onOutside(event: MouseEvent): void {
  if (el.value && !el.value.contains(event.target as Node)) emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

const items = computed(() => {
  const list: Array<{ id: string; label: string; icon: string; run: () => void; danger?: boolean }> = []
  list.push({
    id: 'pin',
    label: props.pinned ? '取消固定' : '固定',
    icon: props.pinned ? 'pin-off' : 'pin',
    run: () => emit('togglePin'),
  })
  list.push({ id: 'copy', label: '复制标题', icon: 'copy', run: () => emit('copyTitle') })
  if (props.fromHistory) {
    list.push({ id: 'remove', label: '移出最近使用', icon: 'trash', run: () => emit('removeHistory') })
  }
  for (const [index, item] of props.extra.entries()) {
    list.push({
      id: `extra-${index}`,
      label: item.label,
      icon: item.icon ?? 'chevron-right',
      run: () => emit('runExtra', item.action),
    })
  }
  if (props.canReveal) {
    list.push({ id: 'reveal', label: '打开插件所在目录', icon: 'folder', run: () => emit('reveal') })
  }
  if (props.canDisable) {
    list.push({ id: 'disable', label: `禁用插件「${props.pluginTitle}」`, icon: 'puzzle', run: () => emit('disable') })
    list.push({ id: 'uninstall', label: `卸载插件「${props.pluginTitle}」`, icon: 'trash', run: () => emit('uninstall'), danger: true })
  }
  return list
})
</script>

<template>
  <div
    ref="el"
    class="fixed z-50 min-w-[220px] rounded-[10px] border border-[var(--border)] bg-[var(--panel)] backdrop-blur-xl py-1 shadow-[0_16px_40px_rgba(0,0,0,0.35)]"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
  >
    <div class="px-3 py-1 text-[10.5px] text-[var(--fg-muted)] uppercase tracking-wider">{{ pluginTitle }}</div>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[var(--hover)]"
      :class="item.danger ? 'text-red-400' : ''"
      @click="
        () => {
          item.run()
          emit('close')
        }
      "
    >
      <IconGlyph :name="item.icon" :size="14" />
      <span class="truncate">{{ item.label }}</span>
    </button>
  </div>
</template>
