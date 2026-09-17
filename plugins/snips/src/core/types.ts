/** 快贴条目：文本 / 代码 / 图片（图片正文是 data URL，随 storage 一起落盘） */
export type SnipKind = 'text' | 'code' | 'image'

export interface Snip {
  id: string
  kind: SnipKind
  title: string
  content: string
  /** 代码片段的语言标签（仅展示用） */
  lang?: string
  createdAt: number
  updatedAt: number
  usedAt: number
  /** 使用次数：详情里展示「常用程度」 */
  uses: number
  pinned: boolean
}

/** 图片快贴的体积上限（data URL 字符数）——storage 是单个 JSON 文件，别塞爆 */
export const IMAGE_MAX_CHARS = 1_400_000
