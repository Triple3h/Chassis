import type { MatchSpan, ResultItem } from '@launcher/plugin-manifest'

export interface RankedResult {
  pluginId: string
  pluginTitle: string
  command: string
  item: ResultItem
  itemKey: string
  score: number
  titleMatch?: MatchSpan | null
  pinned?: boolean
  fromHistory?: boolean
  stale?: boolean
}

export interface SearchResponse {
  token: number
  query: string
  groups: {
    pinned: RankedResult[]
    best: RankedResult[]
    recent: RankedResult[]
  }
  collapse: { pinned: number; recent: number }
  pending: string[]
}

export type RowKind = 'header' | 'item'

export interface Row {
  kind: RowKind
  key: string
  /** header 用 */
  label?: string
  count?: number
  collapsed?: boolean
  group?: 'pinned' | 'best' | 'recent'
  /** item 用 */
  result?: RankedResult
  index?: number
}

export type { ResultItem, MatchSpan }
