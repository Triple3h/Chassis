import { formatJson, type FormatOptions, type FormatResult } from './format'
import { buildTree, type BuildTreeOptions, type FlatTree } from './tree'

/**
 * 计算调度层：优先丢进 Web Worker，保证再大的 JSON 也不会卡住输入。
 * Worker 不可用（CSP / 老 WebView）时自动降级为主线程同步执行。
 */

interface Pending {
  resolve: (value: never) => void
}

let worker: Worker | null = null
let broken = false
let seq = 0
const pending = new Map<number, Pending>()

function rejectAll() {
  const waiters = [...pending.values()]
  pending.clear()
  for (const w of waiters) w.resolve(undefined as never)
}

function ensureWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { id: number; result?: FormatResult; tree?: FlatTree; issue?: unknown }
      const waiter = pending.get(data.id)
      if (!waiter) return
      pending.delete(data.id)
      waiter.resolve(data as never)
    }
    worker.onerror = () => {
      broken = true
      worker = null
      rejectAll()
    }
    return worker
  } catch {
    broken = true
    worker = null
    return null
  }
}

function call<T>(payload: object): Promise<T | null> {
  const w = ensureWorker()
  if (!w) return Promise.resolve(null)
  const id = ++seq
  return new Promise<T | null>((resolve) => {
    pending.set(id, { resolve: resolve as (value: never) => void })
    try {
      w.postMessage({ ...payload, id })
    } catch {
      pending.delete(id)
      resolve(null)
    }
  })
}

export async function runFormat(text: string, options: FormatOptions): Promise<FormatResult> {
  const res = await call<{ result?: FormatResult }>({ op: 'format', text, options })
  if (res?.result) return res.result
  return formatJson(text, options)
}

export async function runBuildTree(text: string, options: BuildTreeOptions): Promise<FlatTree | null> {
  const res = await call<{ tree?: FlatTree }>({ op: 'tree', text, options })
  if (res?.tree) return res.tree
  try {
    return buildTree(text, options)
  } catch {
    return null
  }
}
