import { ref } from 'vue'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

const items = ref<ToastItem[]>([])
let seq = 0

/** 全局轻提示队列（由 AppShell 渲染） */
export function useToast() {
  function push(text: string, tone: ToastTone = 'info', ms = 1800) {
    const id = ++seq
    items.value = [...items.value.slice(-3), { id, text, tone }]
    setTimeout(() => {
      items.value = items.value.filter((t) => t.id !== id)
    }, ms)
  }
  return {
    items,
    push,
    info: (t: string) => push(t, 'info'),
    ok: (t: string) => push(t, 'success'),
    err: (t: string) => push(t, 'error', 2600),
  }
}
