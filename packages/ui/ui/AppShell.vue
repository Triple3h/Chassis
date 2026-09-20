<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useTheme } from '../lib/theme'
import { useToast } from '../lib/toast'

/**
 * 统一页面骨架：铺满 iframe、应用主题、渲染轻提示。
 * 主题只读 —— 插件页内不提供切换（plugin-spec §5.3），切换是宿主的职责。
 */
const { theme } = useTheme()
const { items } = useToast()

let observer: MutationObserver | null = null

onMounted(() => {
  // 宿主若在文档上切换 data-theme，跟随一次
  observer = new MutationObserver(() => {
    const attr = document.documentElement.dataset.theme
    if ((attr === 'dark' || attr === 'light') && attr !== theme.value) theme.value = attr
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div class="relative h-full w-full flex flex-col bg-bg text-fg overflow-hidden">
    <slot />

    <!-- 轻提示：显式给 duration，收尾走定时器而不是 transitionend（宿主隐藏窗口会暂停渲染） -->
    <div class="pointer-events-none fixed inset-x-0 bottom-14 z-50 flex flex-col items-center gap-1.5">
      <TransitionGroup name="launcher-toast" :duration="{ enter: 200, leave: 140 }">
        <div
          v-for="t in items"
          :key="t.id"
          class="rounded-lg border border-line px-3 py-1.5 text-[12.5px] shadow-lg backdrop-blur"
          :class="{
            'bg-panel text-fg': t.tone === 'info',
            'bg-panel text-success': t.tone === 'success',
            'bg-panel text-danger': t.tone === 'error',
          }"
        >
          {{ t.text }}
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>
