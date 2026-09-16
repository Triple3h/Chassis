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
/** 缩放原点：从锚点那一侧长出来（--motion-origin 由 .motion-menu-* 消费） */
const origin = ref('top left')

onMounted(() => {
  const rect = el.value?.getBoundingClientRect()
  if (!rect) return
  const maxX = window.innerWidth - rect.width - 8
  const maxY = window.innerHeight - rect.height - 8
  const left = Math.max(8, Math.min(props.x, maxX))
  const top = Math.max(8, Math.min(props.y, maxY))
  pos.value = { left, top }
  // 锚点换算成菜单内的相对坐标，再夹进菜单盒子 —— 贴边被推回来时原点也不会跑到菜单外
  const ox = Math.max(0, Math.min(props.x - left, rect.width))
  const oy = Math.max(0, Math.min(props.y - top, rect.height))
  origin.value = `${Math.round(ox)}px ${Math.round(oy)}px`
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
    // 菜单吃掉这次 Esc：否则 App 的全局 Esc 会顺手清空输入 / 隐藏窗口
    event.stopImmediatePropagation()
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
    class="menu fixed z-50 min-w-[220px] rounded-[10px] border border-[var(--border)] bg-[var(--panel)] backdrop-blur-xl py-1 shadow-[0_16px_40px_rgba(0,0,0,0.35)]"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px`, '--motion-origin': origin }"
  >
    <div class="px-3 py-1 text-[10.5px] text-[var(--fg-muted)] uppercase tracking-wider">{{ pluginTitle }}</div>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="menu-item w-full flex items-center gap-2.5 px-3 py-1.5 text-left"
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

<style scoped>
.menu-item {
  transition:
    background-color var(--motion-instant) var(--motion-ease-move),
    color var(--motion-instant) var(--motion-ease-move);
}

.menu-item:hover {
  background: var(--hover);
}

/* 按压反馈：菜单点下去的那一下要有回应，否则点了没反应会觉得是没点上 */
.menu-item:active {
  background: var(--sel);
}
</style>
