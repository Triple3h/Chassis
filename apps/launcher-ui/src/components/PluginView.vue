<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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

function onLoad(): void {
  emit('loaded')
}

function onError(): void {
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
  window.addEventListener('message', onMessage, false)
})

onUnmounted(() => {
  window.removeEventListener('message', onMessage, false)
})
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col bg-[var(--bg-solid)]">
    <iframe
      v-if="!failed"
      ref="iframe"
      :src="state.url"
      class="flex-1 w-full border-0 bg-transparent"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      allow="clipboard-read; clipboard-write"
      @load="onLoad"
      @error="onError"
    />
    <div v-else class="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--fg-muted)]">
      <p class="text-[13px]">插件页加载失败：{{ state.title }}</p>
      <div class="flex gap-2">
        <button class="rounded px-3 py-1 border border-[var(--border)] hover:bg-[var(--hover)]" @click="failed = false">
          重试
        </button>
        <button class="rounded px-3 py-1 border border-[var(--border)] hover:bg-[var(--hover)]" @click="emit('fatal', '已放弃加载')">
          关闭
        </button>
      </div>
    </div>
  </div>
</template>
