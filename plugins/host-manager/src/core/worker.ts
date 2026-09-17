/// <reference lib="webworker" />
import { parseBlocksDoc, type BlocksDoc } from './blocks'
import { diffLines, type DiffResult } from './hosts'

/**
 * Worker 侧薄壳：把消息分派给 blocks.ts / hosts.ts 里的纯函数。
 * hosts 文件被拿去做广告屏蔽时能有几万行，解析与差分不能在主线程上跑。
 */
export type HostsRequest =
  | { id: number; op: 'parse'; text: string }
  | { id: number; op: 'diff'; prev: string; next: string }

export type HostsReply =
  | { id: number; op: 'parse'; ok: true; result: BlocksDoc }
  | { id: number; op: 'diff'; ok: true; result: DiffResult }
  | { id: number; op: string; ok: false; error: string }

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (data: unknown) => void
}

const scope = self as unknown as Scope

scope.onmessage = (e: MessageEvent) => {
  const req = e.data as HostsRequest
  try {
    if (req.op === 'parse') {
      scope.postMessage({ id: req.id, op: req.op, ok: true, result: parseBlocksDoc(req.text) })
    } else {
      scope.postMessage({ id: req.id, op: req.op, ok: true, result: diffLines(req.prev, req.next) })
    }
  } catch (err) {
    scope.postMessage({
      id: req.id,
      op: req.op,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
