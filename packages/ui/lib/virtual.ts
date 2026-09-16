import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'

export interface VirtualListOptions {
  /** 总行数 */
  count: Ref<number>
  /** 行高（px），等高于所有行，便于 O(1) 定位 */
  rowHeight: number
  /** 上下额外渲染的行数，减少滚动白屏 */
  overscan?: number
}

/**
 * 定高虚拟滚动。
 * diff 视图、JSON 树、TOTP 账户列表都是等高行，所以用最简单也最快的定高方案：
 * 只渲染可视窗口内的行，滚动时按 scrollTop 反推区间，不做任何 DOM 测量。
 */
export function useVirtualList(container: Ref<HTMLElement | null>, opts: VirtualListOptions) {
  const scrollTop = ref(0)
  const viewport = ref(0)
  const overscan = opts.overscan ?? 6

  let raf = 0

  function onScroll() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      scrollTop.value = container.value?.scrollTop ?? 0
    })
  }

  let ro: ResizeObserver | null = null

  onMounted(() => {
    const el = container.value
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    viewport.value = el.clientHeight
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        viewport.value = el.clientHeight
      })
      ro.observe(el)
    }
  })

  onUnmounted(() => {
    container.value?.removeEventListener('scroll', onScroll)
    ro?.disconnect()
    if (raf) cancelAnimationFrame(raf)
  })

  const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / opts.rowHeight) - overscan))
  const endIndex = computed(() =>
    Math.min(
      opts.count.value,
      Math.ceil((scrollTop.value + (viewport.value || 400)) / opts.rowHeight) + overscan,
    ),
  )
  const offsetY = computed(() => startIndex.value * opts.rowHeight)
  const totalHeight = computed(() => opts.count.value * opts.rowHeight)

  /** 滚动到指定行 */
  function scrollToIndex(index: number, align: 'start' | 'center' = 'center') {
    const el = container.value
    if (!el) return
    const target =
      align === 'center'
        ? index * opts.rowHeight - el.clientHeight / 2 + opts.rowHeight / 2
        : index * opts.rowHeight
    el.scrollTop = Math.max(0, target)
  }

  return { scrollTop, startIndex, endIndex, offsetY, totalHeight, scrollToIndex }
}
