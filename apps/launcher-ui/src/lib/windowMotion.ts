import { api } from './api'

/**
 * 窗口高度缓动。
 *
 * 结果行数一变窗口就跟着变高变矮，直接发一次 `setHeight` 是「啪」地跳一下 ——
 * 在一整套弹窗动效里这是最扎眼的一处，因为它是整块画面在动。
 *
 * 做法就是逐帧发 `setHeight`：**顺序发、每帧一次**，绝不并发。
 * 并发发出去的话壳那边的到达顺序无法保证，窗口会来回抖。
 * 幅度过大（换了一屏内容）时不做缓动 —— 那本来就该是一步到位，慢慢拉过去反而像卡住。
 */

const DURATION_MS = 160
/** 超过这个幅度就一步到位：这不是「调整」，是「换了一屏」 */
const MAX_ANIMATED_DELTA = 280

let latest = 0
/** 每次调用 +1，用于让上一个还没跑完的 tween 自己退出 */
let generation = 0
/** 首帧不缓动：启动时窗口的初始高度和算出来的目标高度差一截，那不该被看见 */
let started = false

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 把窗口高度调到 `target`（逻辑像素）。
 * 同一个高度重复调用会被忽略；带 `immediate` 时直接落位不缓动。
 */
export function setWindowHeight(target: number, options: { immediate?: boolean } = {}): void {
  const to = Math.round(target)
  if (to === latest && started) return
  const from = Math.round(window.innerHeight)
  latest = to

  const snap = options.immediate === true || !started || Math.abs(to - from) > MAX_ANIMATED_DELTA || prefersReducedMotion()
  started = true
  const token = ++generation

  if (snap) {
    void api.setWindowHeight(to).catch(() => undefined)
    return
  }
  void animateHeight(from, to, token)
}

async function animateHeight(from: number, to: number, token: number): Promise<void> {
  const startedAt = performance.now()
  for (;;) {
    if (token !== generation) return // 期间来了新目标，交给新的一次接管
    const progress = Math.min(1, (performance.now() - startedAt) / DURATION_MS)
    const value = Math.round(from + (to - from) * easeOutCubic(progress))
    await api.setWindowHeight(value).catch(() => undefined)
    if (progress >= 1) return
    await nextFrame()
  }
}
