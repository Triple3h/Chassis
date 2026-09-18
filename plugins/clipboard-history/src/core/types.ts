/** 一条历史（逻辑层 `clip-io list` 返回的形态；标题 / 副标题由 Rust 侧算好，view 只渲染） */
export interface HistoryEntry {
  id: string
  kind: 'text' | 'image' | 'file'
  title: string
  subtitle: string
  createdAt: number
  pinned: boolean
  uses: number
  text?: string
  width?: number
  height?: number
  paths?: string[]
  hasBlob: boolean
}

export interface ListResult {
  ok: boolean
  entries: HistoryEntry[]
  total: number
  pausedUntil: number
  now: number
  error?: string
}

export interface ImageResult {
  ok: boolean
  data?: string
  error?: string
}

export type OpResult = { ok: boolean; total?: number; pausedUntil?: number; pinned?: boolean; error?: string }

export type KindFilter = 'all' | 'text' | 'image' | 'file'
