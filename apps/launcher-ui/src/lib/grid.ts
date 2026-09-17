import type { RankedResult } from './types'

/**
 * 结果网格：分区标题 + 每行 N 个「图标 + 名称」格子，方向键按格子移动。
 */

export type ResultGroup = 'pinned' | 'best' | 'recent'

export interface GridMetrics {
  /** 图标边长 px */
  icon: number
  /** 名称字号 px */
  name: number
  /** 整格高度 px（含上下内边距，必须与 CSS 里算出来的一致） */
  itemHeight: number
}

export const GRID_METRICS: Record<'comfortable' | 'compact', GridMetrics> = {
  comfortable: { icon: 36, name: 12, itemHeight: 90 },
  compact: { icon: 30, name: 11, itemHeight: 82 },
}

export const GRID_HEADER_HEIGHT = 30
/** 左右内边距（列表容器 px-3） */
export const GRID_PADDING_X = 12
/** 上下内边距（列表容器 py-1.5） */
export const GRID_PADDING_Y = 12
/** 每格最小宽度：列数由容器宽度除以它得出 */
export const GRID_MIN_CELL = 92
export const GRID_MAX_COLUMNS = 9
export const SEARCH_BAR_HEIGHT = 58
export const FOOTER_HEIGHT = 36
export const MIN_WINDOW_HEIGHT = 320
export const MAX_WINDOW_HEIGHT = 640

/** 折叠时保留的行数；0 = 不折叠 */
const COLLAPSE_ROWS: Record<ResultGroup, number> = { pinned: 1, best: 3, recent: 2 }

/** 容器宽度 → 列数（窗口宽度固定 720，实际恒为 7；保留自适应是为了以后放开改宽） */
export function columnsFor(width: number): number {
  const usable = Math.max(0, width - GRID_PADDING_X * 2)
  const cols = Math.floor(usable / GRID_MIN_CELL)
  return Math.max(1, Math.min(GRID_MAX_COLUMNS, cols || 1))
}

export interface GridSection {
  key: string
  group: ResultGroup
  label: string
  /** 该分区的全部条数（折叠时也如实显示） */
  total: number
  expanded: boolean
  collapsible: boolean
  /** 折叠时被藏起来的条数 */
  hidden: number
  /** 实际渲染的条目（已按折叠状态裁剪） */
  items: RankedResult[]
}

export interface BuildSectionsInput {
  query: string
  pinned: RankedResult[]
  best: RankedResult[]
  recent: RankedResult[]
  columns: number
  expanded: Record<ResultGroup, boolean>
}

export function buildSections(input: BuildSectionsInput): GridSection[] {
  const { columns, query } = input
  const out: GridSection[] = []

  const push = (group: ResultGroup, label: string, items: RankedResult[]): void => {
    if (items.length === 0) return
    const rows = COLLAPSE_ROWS[group]
    const limit = rows * columns
    const collapsible = limit > 0 && items.length > limit
    const expanded = !collapsible || input.expanded[group]
    const visible = expanded ? items : items.slice(0, limit)
    out.push({
      key: group,
      group,
      label,
      total: items.length,
      expanded,
      collapsible,
      hidden: items.length - visible.length,
      items: visible,
    })
  }

  if (query) {
    // 有输入：固定命中 → 最佳匹配 → 最近命中（requirements §3.2）
    push('pinned', '已固定', input.pinned)
    push('best', '最佳匹配', input.best)
    push('recent', '最近使用', input.recent)
  } else {
    push('pinned', '已固定', input.pinned)
    push('recent', '最近使用', input.recent)
  }
  return out
}

export type GridRow =
  | {
      kind: 'header'
      key: string
      label: string
      total: number
      hidden: number
      expanded: boolean
      collapsible: boolean
      group: ResultGroup
    }
  | {
      kind: 'items'
      key: string
      group: ResultGroup
      items: RankedResult[]
      /** 本行首项在扁平条目列表里的下标（选中态用扁平下标表示） */
      start: number
    }

/** 分区 → 扁平行（标题行 + 每 columns 个一行的格子行） */
export function buildGridRows(sections: GridSection[], columns: number): GridRow[] {
  const rows: GridRow[] = []
  let cursor = 0
  const size = Math.max(1, columns)
  for (const section of sections) {
    rows.push({
      kind: 'header',
      key: `h:${section.key}`,
      label: section.label,
      total: section.total,
      hidden: section.hidden,
      expanded: section.expanded,
      collapsible: section.collapsible,
      group: section.group,
    })
    for (let i = 0; i < section.items.length; i += size) {
      const items = section.items.slice(i, i + size)
      rows.push({ kind: 'items', key: `${section.key}:${i}`, group: section.group, items, start: cursor })
      cursor += items.length
    }
  }
  return rows
}

export function flattenItems(rows: GridRow[]): RankedResult[] {
  const out: RankedResult[] = []
  for (const row of rows) if (row.kind === 'items') out.push(...row.items)
  return out
}

export function rowHeightOf(row: GridRow, metrics: GridMetrics): number {
  return row.kind === 'header' ? GRID_HEADER_HEIGHT : metrics.itemHeight
}

function clamp(value: number, max: number): number {
  if (max < 0) return 0
  return Math.max(0, Math.min(max, value))
}

/** 扁平下标 → 所在格子行的位置（行下标 + 行内列号）；没有条目时返回 null */
export function locate(rows: GridRow[], itemIndex: number): { row: number; col: number } | null {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row && row.kind === 'items' && itemIndex >= row.start && itemIndex < row.start + row.items.length) {
      return { row: i, col: itemIndex - row.start }
    }
  }
  return null
}

/** 选中项所在格子行在 rows 里的下标（虚拟滚动用），找不到返回 0 */
export function displayRowIndex(rows: GridRow[], itemIndex: number): number {
  return locate(rows, itemIndex)?.row ?? 0
}

/** 同列上下移动：落点行比当前行短时贴到该行末尾 */
export function moveVertical(rows: GridRow[], itemIndex: number, dir: 1 | -1): number {
  const at = locate(rows, itemIndex)
  if (!at) return itemIndex
  for (let i = at.row + dir; i >= 0 && i < rows.length; i += dir) {
    const row = rows[i]
    if (row?.kind !== 'items') continue
    return row.start + clamp(at.col, row.items.length - 1)
  }
  return itemIndex
}

/** 左右（或在同一行内逐格）移动，跨分区连续 */
export function moveItem(rows: GridRow[], itemIndex: number, delta: number): number {
  const total = rows.reduce((sum, row) => sum + (row.kind === 'items' ? row.items.length : 0), 0)
  return clamp(itemIndex + delta, total - 1)
}
