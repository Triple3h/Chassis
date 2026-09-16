<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import IconGlyph from './IconGlyph.vue'
import { api } from '../lib/api'
import type { PluginViewState } from '../stores/ui'

const props = defineProps<{ state: PluginViewState }>()
const emit = defineEmits<{
  (e: 'loaded'): void
  (e: 'crash', reason: string): void
  (e: 'fatal', message: string): void
}>()

const iframe = ref<HTMLIFrameElement | null>(null)
const failed = ref(false)

/**
 * 加载态遮罩。**延迟 150ms 才显示**：插件页在内核自己的 listener 上，通常几十毫秒就好了，
 * 立刻显示只会换来「闪一下的转圈」——比什么都不显示更像卡了。慢加载才值得给反馈。
 */
const VEIL_DELAY_MS = 150
const veilVisible = ref(false)
/** iframe 首帧就带着内容进场，避免「先白底再出画面」的跳变 */
const loaded = ref(false)
let veilTimer: number | null = null

const expectedOrigin = computed(() => {
  try {
    return new URL(props.state.url).origin
  } catch {
    return ''
  }
})

/**
 * 插件页 → 宿主 的转发（requirements §8.5）。
 * 三重校验：origin === 插件端口 origin、event.source === 该 iframe 的 contentWindow、token 由内核校验。
 */
async function onMessage(event: MessageEvent): Promise<void> {
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return

  const frame = iframe.value
  if (!frame || event.source !== frame.contentWindow) return
  if (expectedOrigin.value && event.origin !== expectedOrigin.value) return

  // 只认原生信封：`__launcher: 1`
  if (data.__launcher !== 1) return

  const id = Number(data.id ?? 0)
  const method = String(data.method ?? '')
  if (!method) return
  const params = (data.params ?? {}) as Record<string, unknown>
  const token = typeof data.token === 'string' && data.token ? data.token : props.state.url.match(/token=([^&]+)/)?.[1] ?? ''

  try {
    const res = await api.bridge({ sid: props.state.sid, token, id, method, params })
    frame.contentWindow?.postMessage(
      { __launcher: 1, id: res.id, ok: res.ok, result: res.result ?? null, ...(res.error ? { error: res.error } : {}) },
      expectedOrigin.value || '*',
    )
  } catch (err) {
    frame.contentWindow?.postMessage(
      { __launcher: 1, id, ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } },
      expectedOrigin.value || '*',
    )
  }
}

function clearVeil(): void {
  if (veilTimer !== null) {
    window.clearTimeout(veilTimer)
    veilTimer = null
  }
  veilVisible.value = false
}

function onLoad(): void {
  clearVeil()
  loaded.value = true
  emit('loaded')
}

function onError(): void {
  clearVeil()
  failed.value = true
  emit('crash', '插件页加载失败')
}

function postEvent(name: string, payload: unknown): void {
  const frame = iframe.value
  if (!frame?.contentWindow) return
  frame.contentWindow.postMessage({ __launcher: 1, event: name, payload }, expectedOrigin.value || '*')
}

defineExpose({ postEvent })

onMounted(() => {
  veilTimer = window.setTimeout(() => {
    veilVisible.value = true
  }, VEIL_DELAY_MS)
  window.addEventListener('message', onMessage, false)
})

onUnmounted(() => {
  clearVeil()
  window.removeEventListener('message', onMessage, false)
})
</script>

<template>
  <div class="relative flex-1 min-h-0 flex flex-col bg-[var(--bg-solid)]">
    <iframe
      v-if="!failed"
      ref="iframe"
      :src="state.url"
      class="plugin-frame"
      :class="loaded ? 'is-ready' : ''"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      allow="clipboard-read; clipboard-write"
      @load="onLoad"
      @error="onError"
    />
    <div v-else class="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--fg-muted)]">
      <p class="text-[13px]">插件页加载失败：{{ state.title }}</p>
      <div class="flex gap-2">
        <button class="plugin-retry" @click="failed = false">重试</button>
        <button class="plugin-retry" @click="emit('fatal', '已放弃加载')">关闭</button>
      </div>
    </div>

    <Transition name="motion-fade" :duration="{ enter: 200, leave: 140 }">
      <div v-if="veilVisible && !failed" class="plugin-veil">
        <span class="plugin-veil-spin"><IconGlyph name="loader" :size="18" /></span>
        <span class="text-[12px]">正在打开「{{ state.title }}」…</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.plugin-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: transparent;
  /* 载入完成后才淡入：插件页首帧自带内容，不再「先白底再出画面」。
     用最慢那一档是因为这是全应用最大的一块面 —— 强减速下 100ms 就已经七成不透明，
     实感是「画面落定」，不是「等它变清楚」。 */
  opacity: 0;
  transition: opacity var(--motion-slow) var(--motion-ease-enter);
}

.plugin-frame.is-ready {
  opacity: 1;
}

.plugin-veil {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-muted);
  background: var(--bg-solid);
}

.plugin-veil-spin {
  display: inline-flex;
  animation: plugin-veil-spin 0.9s linear infinite;
}

@keyframes plugin-veil-spin {
  to {
    transform: rotate(360deg);
  }
}

.plugin-retry {
  border-radius: 6px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  transition: background-color var(--motion-instant) var(--motion-ease-move);
}

.plugin-retry:hover {
  background: var(--hover);
}
</style>
