import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { GridRow } from './grid'

export interface VirtualRow {
  row: GridRow
  index: number
  top: number
  height: number
}

/**
 * 定高虚拟滚动（requirements §10：列表 > 200 行必须虚拟滚动）。
 * 一行 = 一个分区标题，或一排网格格子（最多 `columns` 个条目），高度由 heightOf 给出。
 */
export function useVirtualRows(
  rows: ComputedRef<GridRow[]>,
  heightOf: (row: GridRow) => number,
  viewportHeight: Ref<number>,
  opts: { threshold?: number; overscan?: number } = {},
) {
  // 一排最多 9 个条目 ⇒ 24 排 ≈ 200 条，越过这条线就开虚拟滚动
  const threshold = opts.threshold ?? 24
  const overscan = opts.overscan ?? 4
  const scrollTop = ref(0)

  const enabled = computed(() => rows.value.length > threshold)

  const layout = computed(() => {
    const items: Array<{ row: GridRow; top: number; height: number }> = []
    let top = 0
    for (const row of rows.value) {
      const height = heightOf(row)
      items.push({ row, top, height })
      top += height
    }
    return { items, total: top }
  })

  const visible = computed<VirtualRow[]>(() => {
    const { items } = layout.value
    if (!enabled.value) {
      return items.map((item, index) => ({ ...item, index }))
    }
    const start = scrollTop.value
    const end = scrollTop.value + viewportHeight.value
    // 线性扫描足够快（< 1 千行）；起始位置用简单估算再回退
    let first = Math.max(0, Math.floor(start / 90) - overscan * 3)
    while (first > 0 && (items[first]?.top ?? 0) > start) first -= 1
    let last = Math.min(items.length - 1, first)
    while (last < items.length - 1 && (items[last]?.top ?? 0) + (items[last]?.height ?? 0) < end) last += 1
    last = Math.min(items.length - 1, last + overscan)

    const out: VirtualRow[] = []
    for (let i = first; i <= last; i += 1) {
      const item = items[i]
      if (item) out.push({ ...item, index: i })
    }
    return out
  })

  const totalHeight = computed(() => layout.value.total)
  const offsetTop = computed(() => (enabled.value ? (visible.value[0]?.top ?? 0) : 0))

  function onScroll(event: Event): void {
    scrollTop.value = (event.target as HTMLElement).scrollTop
  }

  /** 选中项滚动到可视区 */
  function scrollIndexIntoView(index: number, container: HTMLElement | null): void {
    if (!container) return
    const item = layout.value.items[index]
    if (!item) return
    const top = item.top
    const bottom = item.top + item.height
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    if (top < viewTop) container.scrollTop = top
    else if (bottom > viewBottom) container.scrollTop = bottom - container.clientHeight
  }

  return { enabled, visible, totalHeight, offsetTop, onScroll, scrollIndexIntoView, scrollTop }
}
