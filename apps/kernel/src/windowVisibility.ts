import type { EventBus } from './events'
import type { Primitives } from './services/shell'

/**
 * 隐藏的**兜底**时长（ms）：等不到 UI 的回执也只能落地。
 *
 * 正常路径根本不看这个数：UI 演完离场动画会回执 `/api/window/hidden`，内核拿到就立刻隐藏
 * （见 `WindowVisibility.hide`）。回执才是「演完了」的准确信号 —— 广播穿过 内核 → SSE → webview
 * 的耗时不可控，任何固定时长都可能砍在淡出中途，把半透明的一帧留成「下一场唤出先亮的旧画面」。
 *
 * 这个数只防「UI 没了 / SSE 断了 / 回执丢了」：500ms 比正常回执（约 140+100ms）宽裕一倍多。
 */
export const HIDE_FALLBACK_MS = 500

/**
 * 「显示」这条广播的延迟（ms）。
 *
 * 壳的 `show()` 只是把窗口排进显示队列：窗口真正上屏、webview 从「隐藏」恢复绘制
 * 还要几十毫秒，而 **CSS 的时间线在这段时间里照走**。广播发早了，UI 的入场动画会在
 * 窗口还没有画面的时候播完 —— 用户看到的是「啪」一下整块出现（实测反馈：动效好像没实现）。
 * 留这一段时间让窗口先跑到「能画」的状态，是入场动画能被看见的前提。
 */
export const SHOW_ANIMATION_MS = 80

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface WindowVisibilityDeps {
  /** 壳原语：只用到显隐相关的三个（测试里可替换为假实现） */
  primitives: Pick<Primitives, 'showWindow' | 'hideWindow' | 'isVisible'>
  bus: EventBus
}

/**
 * 窗口显隐的「动画协作」（ADR-0004）。
 *
 * 壳仍然是「什么时候该显、什么时候该隐」的唯一裁决者，这个类只负责**让这次显隐好看一点**：
 * 把广播和真正落地拆成两步，中间留给 UI 播动画的时间。所有跨进程路径都必须走这两个方法，
 * 否则就会出现「有的入口有动画、有的入口啪一下」这种最难查的不一致。
 *
 * 它从 `Kernel` 里抽出来：原来散在 6 个私有字段 + 一串方法里，而这个状态机不碰内核的
 * 其它任何东西（搜索 / 插件 / 会话统统无关），单独成类之后既可读、也能拿假原语直接测。
 */
export class WindowVisibility {
  /** 正在「演离场」的那次隐藏（同一时刻只允许一次） */
  private pendingHide: Promise<void> | null = null
  /** 撤销令牌：唤出时 +1，让已经排队的隐藏落地前自己失效 */
  private hideToken = 0
  /** 显示广播的令牌：排队中的那次「晚一点广播」被新的显隐动作作废 */
  private showToken = 0
  /** 兜底定时器：UI 的回执一直不来也要落地（见 HIDE_FALLBACK_MS） */
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  /** 「现在落地」的入口：回执与兜底共用；没有排队的隐藏时为 null */
  private land: (() => void) | null = null
  /** 让 `hide()` 的调用方等到真正落地（回执或兜底）再返回 */
  private settle: (() => void) | null = null

  constructor(private readonly deps: WindowVisibilityDeps) {}

  /**
   * 显示窗口：先落地，再等窗口真的能画了才广播（见 `SHOW_ANIMATION_MS`）。
   * 广播放在 `finally` 里：敲壳失败时 UI 更不能停在「隐藏态」（那正好是一块透明窗口）。
   *
   * 返回值透传壳读到的**前台选中文本**（`selection`）：那是"显示之前"那一瞬的事实，
   * 只有壳抓得住（见 `selection.rs`）；这里只负责把它原样交给调用方。
   */
  async show(focus = true): Promise<{ selection?: string }> {
    this.cancelPendingHide()
    let selection: string | undefined
    try {
      const res = await this.deps.primitives.showWindow(focus)
      selection = res?.selection
    } finally {
      await this.emitVisible()
    }
    return selection ? { selection } : {}
  }

  /** 「显示」这条广播要晚一点发：延迟期间又来了隐藏 / 新的显示，这一次就作废 */
  async emitVisible(): Promise<void> {
    const token = ++this.showToken
    await delay(SHOW_ANIMATION_MS)
    if (token !== this.showToken) return
    this.deps.bus.emit('shell/visibility', { visible: true })
  }

  /**
   * 隐藏窗口：先广播（UI 演离场动画），**等 UI 回执「最后一帧画出来了」才真正落地**。
   *
   * 为什么不能定时落地：广播要穿过 内核 → SSE → webview 才变成 CSS 的起点，
   * 这段延迟不可控；任何固定时长都可能砍在淡出中途 —— 被砍掉的那一帧（半透明面板）
   * 会被 webview 留成「最后一帧」，下次唤出时合成器先亮它（用户：「闪一下，像打开了两次」）。
   * 回执把「演完了」交给唯一知道答案的一方；`HIDE_FALLBACK_MS` 只防回执永远不来。
   *
   * 重复调用会搭同一班车（一次 `ctx.hostUi.hide` 会同时从内核和 UI 两条路走回来）。
   */
  async hide(): Promise<void> {
    if (this.pendingHide) return this.pendingHide
    // 排队中的「显示广播」一并作废：先显后隐的连按不能被它补一帧可见
    this.showToken += 1
    this.deps.bus.emit('shell/visibility', { visible: false })
    const token = ++this.hideToken
    this.pendingHide = new Promise<void>((resolve) => {
      this.settle = resolve
      this.land = () => {
        // 令牌被换过 = 这次已经作废（被唤出撤销、或已排了新的一次）：什么都不动
        if (token !== this.hideToken) return
        this.clearPending()
        void this.hideNow()
      }
      this.hideTimer = setTimeout(() => this.land?.(), HIDE_FALLBACK_MS)
    })
    return this.pendingHide
  }

  /** UI 回执：离场动画的最后一帧已经画出来了 —— 现在可以落地了 */
  finishHide(): void {
    this.land?.()
  }

  /** 撤销尚在排队的隐藏（热键连按不能被上一次隐藏偷走窗口） */
  cancelPendingHide(): void {
    this.hideToken += 1
    this.clearPending()
  }

  /** 收尾一次排队中的隐藏：定时器、入口、等待者一并清掉（重复调用无副作用） */
  private clearPending(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.land = null
    this.pendingHide = null
    const resolve = this.settle
    this.settle = null
    resolve?.()
  }

  /** 真正敲壳隐藏（回执与兜底共用的一条路） */
  private async hideNow(): Promise<void> {
    // 只有**明确知道**已经被藏掉了才跳过；问不到（壳没连上）就照常走，隐藏本身会失败并静默
    if ((await this.deps.primitives.isVisible()) === false) return
    await this.deps.primitives.hideWindow().catch(() => undefined)
  }
}
