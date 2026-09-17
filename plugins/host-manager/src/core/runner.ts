import { parseBlocks, parseBlocksDoc, type Block, type BlocksDoc } from './blocks'
import { diffLines, type DiffResult } from './hosts'
import type { HostsReply, HostsRequest } from './worker'

/**
 * 计算调度层：解析 / 差分优先丢进 Worker。
 * Worker 建不起来（CSP、老 WebView）或运行中崩了，就地在主线程跑同一份纯函数——
 * 降级分支不是可选项。
 */

/**
 * Omit 直接作用在联合类型上会把三个分支压成一个「只剩公共字段」的形状，
 * 判别属性 op 之外的字段全丢。用分配式版本逐个分支处理。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

type HostsRequestInit = DistributiveOmit<HostsRequest, 'id'>

let worker: Worker | null = null
let broken = false
let seq = 0
const pending = new Map<number, (reply: HostsReply | null) => void>()

function ensureWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const reply = e.data as HostsReply
      const resolve = pending.get(reply.id)
      if (!resolve) return
      pending.delete(reply.id)
      resolve(reply)
    }
    worker.onerror = () => {
      // 一旦出错就永久降级，避免每次操作都再撞一次
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

async function call<T>(request: HostsRequestInit, fallback: () => T): Promise<T> {
  const w = ensureWorker()
  if (!w) return fallback()

  const id = ++seq
  const reply = await new Promise<HostsReply | null>((resolve) => {
    pending.set(id, resolve)
    try {
      w.postMessage({ ...request, id })
    } catch {
      pending.delete(id)
      resolve(null)
    }
  })

  if (reply?.ok) return reply.result as T
  return fallback()
}

/** 整份文件 → 块模型（几万行也走 Worker） */
export function runParseBlocks(text: string): Promise<BlocksDoc> {
  return call({ op: 'parse', text }, () => parseBlocksDoc(text))
}

export function runDiffLines(prev: string, next: string): Promise<DiffResult> {
  return call({ op: 'diff', prev, next }, () => diffLines(prev, next))
}

/** 托管区文本 → 块列表（批量编辑器边打边解析用；粘贴几千行也走 Worker） */
export function runParseRegion(text: string, eol: '\n' | '\r\n', sep: string): Promise<Block[]> {
  return call({ op: 'blocks', text, eol, sep }, () => parseBlocks(text, eol, sep))
}

/** 丢弃在途请求的挂起点（卸载时调用，避免回调打到已销毁的组件上） */
export function dropPending() {
  pending.clear()
}
