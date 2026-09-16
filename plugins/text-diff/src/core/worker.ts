/// <reference lib="webworker" />
import { computeDiff, type DiffOptions, type DiffResult } from './diff'

export interface DiffRequest {
  id: number
  a: string
  b: string
  options: DiffOptions
}

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (data: unknown) => void
}

const scope = self as unknown as Scope

scope.onmessage = (e: MessageEvent) => {
  const req = e.data as DiffRequest
  let result: DiffResult
  try {
    result = computeDiff(req.a, req.b, req.options)
  } catch (err) {
    result = {
      rows: [],
      stats: { added: 0, removed: 0, changed: 0, equal: 0, hunks: 0 },
      unified: '',
      degraded: false,
      ms: 0,
      // 出错时把信息塞进 unified，UI 会显示出来
      ...({ error: err instanceof Error ? err.message : String(err) } as object),
    } as DiffResult
  }
  scope.postMessage({ id: req.id, result })
}
