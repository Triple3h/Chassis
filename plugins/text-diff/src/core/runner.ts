import { computeDiff, type DiffOptions, type DiffResult } from './diff'

/**
 * 计算调度层：优先丢进 Worker，保证十万行文本也不会冻住界面；
 * Worker 不可用时（CSP / 老 WebView）自动降级到主线程。
 */

let worker: Worker | null = null
let broken = false
let seq = 0
const pending = new Map<number, (value: DiffResult | null) => void>()

function ensureWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { id: number; result: DiffResult }
      const resolve = pending.get(data.id)
      if (!resolve) return
      pending.delete(data.id)
      resolve(data.result)
    }
    worker.onerror = () => {
      broken = true
      worker = null
      for (const resolve of pending.values()) resolve(null)
      pending.clear()
    }
    return worker
  } catch {
    broken = true
    worker = null
    return null
  }
}

export async function runDiff(a: string, b: string, options: DiffOptions): Promise<DiffResult> {
  const w = ensureWorker()
  if (!w) return computeDiff(a, b, options)
  const id = ++seq
  const viaWorker = new Promise<DiffResult | null>((resolve) => {
    pending.set(id, resolve)
    try {
      w.postMessage({ id, a, b, options })
    } catch {
      pending.delete(id)
      resolve(null)
    }
  })
  const result = await viaWorker
  return result ?? computeDiff(a, b, options)
}

/** 主动取消在途计算（切换输入时避免旧结果覆盖新结果） */
export function dropPending() {
  pending.clear()
}
