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

<!--
  进场由 `appear` 驱动：调用方仍是「父组件 v-if 挂载/卸载」（插件里 ImportDialog 等依赖 onMounted
  做摄像头初始化，不能改成常驻），所以这里只能补进场、拿不到离场。
  面板只做缩放、遮罩统一负责透明度，两层不叠加。
-->
<template>
  <Transition name="launcher-mask" appear :duration="{ enter: 200, leave: 140 }">
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4" @click.self="emit('close')">
      <div
        class="launcher-dialog-pop flex max-h-[86vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
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
  </Transition>
</template>
