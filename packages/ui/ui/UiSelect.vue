<script setup lang="ts">
/**
 * 自绘下拉框。
 *
 * 为什么不直接用 `<select>`：macOS 上它的**弹出菜单**由系统（NSMenu）绘制 ——
 * 不跟主题、不跟主题色，`color-scheme` / `appearance:none` 都改不动它。
 * 要菜单和界面完全同款，只能自己画一个。
 *
 * 菜单 Teleport 到 body + fixed 定位：对话框内容区是 `overflow: auto`，
 * 就地绝对定位会被裁掉（顺带把容器撑出滚动条）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from './UiIcon.vue'

interface SelectOption {
  value: string | number
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string | number | null
    options: SelectOption[]
    disabled?: boolean
    /** 没有匹配选项时的占位文案 */
    placeholder?: string
  }>(),
  { disabled: false, placeholder: '请选择' },
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string | number): void }>()

const rootEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const open = ref(false)
const menuStyle = ref<Record<string, string>>({})

const currentIndex = computed(() => props.options.findIndex((item) => item.value === props.modelValue))
const current = computed(() => (currentIndex.value >= 0 ? props.options[currentIndex.value] : undefined))

async function openMenu(): Promise<void> {
  if (props.disabled || props.options.length === 0) return
  open.value = true
  // 渲染 → 测量 → 定位全在同一帧内完成，用户看不到中间态
  await nextTick()
  place()
  const menu = menuEl.value
  const target =
    menu?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu?.querySelector<HTMLElement>('.launcher-menu-item')
  target?.focus()
}

/** 贴着触发器定位；下方放不下且上方放得下就朝上展开 */
function place(): void {
  const root = rootEl.value
  const menu = menuEl.value
  if (!root || !menu) return
  const rect = root.getBoundingClientRect()
  const height = menu.offsetHeight
  const upward = rect.bottom + height + 8 > window.innerHeight && rect.top - height - 8 > 0
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    top: upward ? `${rect.top - height - 4}px` : `${rect.bottom + 4}px`,
  }
}

function closeMenu(focusTrigger = false): void {
  if (!open.value) return
  open.value = false
  if (focusTrigger) rootEl.value?.querySelector<HTMLElement>('.launcher-select-trigger')?.focus()
}

function toggle(): void {
  if (open.value) closeMenu()
  else void openMenu()
}

function pick(option: SelectOption): void {
  if (option.value !== props.modelValue) emit('update:modelValue', option.value)
  closeMenu(true)
}

function moveFocus(delta: number): void {
  const items = [...(menuEl.value?.querySelectorAll<HTMLElement>('.launcher-menu-item') ?? [])]
  if (items.length === 0) return
  const index = items.findIndex((item) => item === document.activeElement)
  const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length
  items[next]?.focus()
}

function onTriggerKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault() // 空格别让页面滚，回车别触发两次（button 的默认 click）
    void openMenu()
  }
}

function onMenuKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation() // 别让外层对话框把它当成「关闭自己」
    closeMenu(true)
    return
  }
  if (event.key === 'Tab') closeMenu()
}

function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return
  const node = event.target as Node
  if (rootEl.value?.contains(node) || menuEl.value?.contains(node)) return
  closeMenu()
}

function onViewportChange(): void {
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
  <div ref="rootEl" class="launcher-selectbox">
    <button
      type="button"
      class="launcher-input launcher-select-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span class="launcher-select-value">{{ current?.label ?? placeholder }}</span>
      <UiIcon name="chevronDown" :size="14" class="launcher-select-caret" />
    </button>

    <Teleport to="body">
      <Transition name="launcher-fade">
        <div
          v-if="open"
          ref="menuEl"
          class="launcher-menu launcher-scroll"
          :style="menuStyle"
          role="listbox"
          @keydown="onMenuKey"
        >
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            class="launcher-menu-item"
            role="option"
            :aria-selected="option.value === modelValue"
            @click="pick(option)"
          >
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
            <UiIcon v-if="option.value === modelValue" name="check" :size="13" />
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
