<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '../lib/api'
import { createCallDedupe } from '../lib/bridge-calls'
import type { PluginViewState } from '../stores/ui'

const props = defineProps<{ state: PluginViewState }>()
const emit = defineEmits<{
  (e: 'loaded'): void
  (e: 'crash', reason: string): void
  (e: 'fatal', message: string): void
}>()

const iframe = ref<HTMLIFrameElement | null>(null)
const failed = ref(false)
/** 每次会话一份：丢弃 SDK 为兼容旧桥而多发的平铺副本（见 lib/bridge-calls.ts） */
const dedupe = createCallDedupe()

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

  // 兼容：原生协议 `__launcher: 1`，也接受任何 { id, method } 形态的旧桥（如快 Sofast）
  const isNative = data.__launcher === 1
  const looksLikeCall = typeof data.id === 'number' && typeof data.method === 'string'
  if (!isNative && !looksLikeCall) return

  const id = Number(data.id ?? 0)
  const method = String(data.method ?? '')
  if (!method) return
  // SDK 为兼容旧宿主会同时发原生信封与平铺副本：原生那条是唯一裁决者，副本丢掉
  if (dedupe.isDuplicate(id, isNative)) return
  const params = data.params ?? inferParams(method, data)
  const token = typeof data.token === 'string' && data.token ? data.token : props.state.url.match(/token=([^&]+)/)?.[1] ?? ''

  try {
    const res = await api.bridge({ sid: props.state.sid, token, id, method, params })
    frame.contentWindow?.postMessage(
      { __launcher: 1, id: res.id, ok: res.ok, result: res.result ?? null, ...(res.error ? { error: res.error } : {}) },
      expectedOrigin.value || '*',
    )
    // 兼容旧桥：同时回一份平铺格式
    if (!isNative) {
      frame.contentWindow?.postMessage(
        { ...(res.ok ? { result: res.result } : { error: res.error }), id: res.id, success: res.ok },
        expectedOrigin.value || '*',
      )
    }
  } catch (err) {
    frame.contentWindow?.postMessage(
      { __launcher: 1, id, ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } },
      expectedOrigin.value || '*',
    )
  }
}

/** 旧桥把参数平铺在顶层（如快：{ method:'setFooter', buttons:[...] }） */
function inferParams(method: string, data: Record<string, unknown>): Record<string, unknown> {
  const skip = new Set(['__launcher', 'id', 'method', 'token', 'from'])
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (skip.has(key)) continue
    params[key] = value
  }
  void method
  return params
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
  // 兼容旧桥的事件形态
  frame.contentWindow.postMessage({ ...(payload as object), event: name, type: name }, expectedOrigin.value || '*')
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
