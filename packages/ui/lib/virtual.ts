import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'

export interface VirtualListOptions {
  /** 总行数 */
  count: Ref<number>
  /** 行高（px），等高于所有行，便于 O(1) 定位；会跟着设置变的传 ref */
  rowHeight: number | Ref<number>
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
  const rowH = computed(() => (typeof opts.rowHeight === 'number' ? opts.rowHeight : opts.rowHeight.value))

  let raf = 0
  let timer = 0

  function read() {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (timer) {
      clearTimeout(timer)
      timer = 0
    }
    scrollTop.value = container.value?.scrollTop ?? 0
  }

  /**
   * 滚动位置统一在下一帧读（一次滚动只更新一次）。
   * 再兜一个超时：隐藏的标签页 / 未激活的窗口里 rAF 根本不跑，
   * 只靠 rAF 的话视口会一直停在上一次的位置（宿主窗口常常是先隐藏、唤出时才可见）。
   */
  function onScroll() {
    if (raf || timer) return
    raf = requestAnimationFrame(read)
    timer = setTimeout(read, 80) as unknown as number
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
    if (timer) clearTimeout(timer)
  })

  const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / rowH.value) - overscan))
  const endIndex = computed(() =>
    Math.min(opts.count.value, Math.ceil((scrollTop.value + (viewport.value || 400)) / rowH.value) + overscan),
  )
  const offsetY = computed(() => startIndex.value * rowH.value)
  const totalHeight = computed(() => opts.count.value * rowH.value)

  /** 滚动到指定行 */
  function scrollToIndex(index: number, align: 'start' | 'center' = 'center') {
    const el = container.value
    if (!el) return
    const target =
      align === 'center' ? index * rowH.value - el.clientHeight / 2 + rowH.value / 2 : index * rowH.value
    el.scrollTop = Math.max(0, target)
  }

  return { scrollTop, startIndex, endIndex, offsetY, totalHeight, scrollToIndex }
}
