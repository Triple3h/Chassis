<script setup lang="ts">
/**
 * 工具条上的「动作下拉」（对齐 bejson 的 `Unicode ▾` / `\ 转义 ▾`）。
 *
 * 与 UiSelect 同一套做法：菜单 Teleport 到 body + fixed 定位（面板内容区会裁绝对定位），
 * 打开时测量触发按钮再落位、下方放不下就朝上翻。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from '@launcher/ui/UiIcon.vue'

interface MenuItem {
  id: string
  label: string
}

const props = defineProps<{
  label: string
  icon?: string
  items: MenuItem[]
}>()

const emit = defineEmits<{ pick: [id: string] }>()

const rootEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const open = ref(false)
const menuStyle = ref<Record<string, string>>({})

async function openMenu() {
  open.value = true
  await nextTick()
  place()
  menuEl.value?.querySelector<HTMLElement>('.launcher-menu-item')?.focus()
}

function place() {
  const root = rootEl.value
  const menu = menuEl.value
  if (!root || !menu) return
  const rect = root.getBoundingClientRect()
  const height = menu.offsetHeight
  const upward = rect.bottom + height + 8 > window.innerHeight && rect.top - height - 8 > 0
  menuStyle.value = {
    left: `${rect.left}px`,
    minWidth: `${Math.max(rect.width, 150)}px`,
    top: upward ? `${rect.top - height - 4}px` : `${rect.bottom + 4}px`,
  }
}

function closeMenu(focusTrigger = false) {
  if (!open.value) return
  open.value = false
  if (focusTrigger) rootEl.value?.querySelector<HTMLElement>('.jmenu-trigger')?.focus()
}

function toggle() {
  if (open.value) closeMenu()
  else void openMenu()
}

function pick(item: MenuItem) {
  closeMenu(true)
  emit('pick', item.id)
}

function moveFocus(delta: number) {
  const items = [...(menuEl.value?.querySelectorAll<HTMLElement>('.launcher-menu-item') ?? [])]
  if (items.length === 0) return
  const at = items.findIndex((item) => item === document.activeElement)
  const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length
  items[next]?.focus()
}

function onTriggerKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    void openMenu()
  }
}

function onMenuKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
    return
  }
  if (event.key === 'Tab') closeMenu()
}

function onDocPointerDown(event: MouseEvent) {
  if (!open.value) return
  const node = event.target as Node
  if (rootEl.value?.contains(node) || menuEl.value?.contains(node)) return
  closeMenu()
}

function onViewportChange() {
  closeMenu()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocPointerDown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <div ref="rootEl" class="jmenu-root">
    <button
      type="button"
      class="launcher-btn ghost jmenu-trigger"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <UiIcon v-if="icon" :name="icon" :size="13" />{{ label }}
      <UiIcon name="chevronDown" :size="12" class="jmenu-caret" />
    </button>

    <Teleport to="body">
      <Transition name="launcher-fade">
        <div ref="menuEl" v-if="open" class="launcher-menu launcher-scroll" :style="menuStyle" role="menu" @keydown="onMenuKey">
          <button
            v-for="item in items"
            :key="item.id"
            type="button"
            class="launcher-menu-item"
            role="menuitem"
            @click="pick(item)"
          >
            <span class="min-w-0 flex-1 truncate text-left">{{ item.label }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
