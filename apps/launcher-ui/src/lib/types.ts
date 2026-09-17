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
    /** 空输入时的「已安装插件」入口（内核按最近打开倒序排好） */
    plugins: RankedResult[]
  }
  pending: string[]
}

export type { ResultItem, MatchSpan }
