# 动效语言

> 读者：改启动台 UI 或插件页的人。令牌定义在 `apps/launcher-ui/src/styles/app.css`（宿主 `--motion-*`）
> 与 `packages/ui/styles/theme.css`（插件侧同名加 `--launcher-` 前缀）；本文是取值与协作规则。

窗口是 `transparent(true)` + `decorations(false)`，视觉上只有 `.shell` 这层圆角面板会被画出来 ——
所以「弹出感」完全可以在 CSS 里做，不需要壳参与绘制。

## 1. 令牌是唯一来源

| 令牌 | 值 | 用途 |
|---|---|---|
| `--motion-instant` | 90ms | 按压、hover、状态色 |
| `--motion-fast` | 140ms | 离场、小元件 |
| `--motion-base` | 200ms | 进场、面板 |
| `--motion-slow` | 320ms | 大块内容（骨架） |
| `--motion-ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进场：强减速「落到位」 |
| `--motion-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | 离场：加速「果断走」 |
| `--motion-ease-move` | `cubic-bezier(0.4, 0, 0.2, 1)` | 位移 / 颜色 |
| `--motion-ease-spring` | `cubic-bezier(0.34, 1.4, 0.64, 1)` | 只给「弹出」用（轻微过冲） |

两条硬规矩：

- **离场一定比进场短。** 离场时用户已经在等结果，拖长只会让人觉得卡。
- **`prefers-reduced-motion` 只重定义令牌**：缩放归 1、位移归 0，时长只压短（120 / 150 / 180ms）、**不归零**。
  保留淡入淡出是刻意的：全压成 1ms 等于把动效整个丢掉，用户看到的是硬跳。组件里不再写第二遍媒体查询。

命名刻意避开 `--ease-*` / `--duration-*`：那是 Tailwind v4 的主题命名空间，同名会被覆盖。

## 2. 窗口显隐：广播 → 回执 → 落地

```
壳 show/hide ──► window/toggled{visible} ──► 内核 emit shell/visibility ──► UI 播动画
                                  ↑
内核自己发起：showWindowAnimated() / hideWindowAnimated()
```

- **裁决权在壳**：`window/toggled` 的方向不变，内核只广播、绝不 toggle。
- **隐藏等 UI 回执**：内核先 `emit('shell/visibility', {visible:false})` 让 UI 播 140ms 淡出 + 缩放，
  等 UI 回执「离场最后一帧画出来了」（`POST /api/window/hidden`）才去敲壳；`HIDE_FALLBACK_MS`(500ms) 只兜底回执不来。
  固定延时落地会把半透明的一帧留成「最后一帧」，下次唤出先亮它（观感：闪一下，像打开了两次）。
- **显示晚一点广播**：壳 `show()` 返回 ≠ 已上屏 + WebView 恢复绘制，CSS 时间线却不会等。
  内核推迟 `SHOW_ANIMATION_MS`(80ms) 再广播（带令牌：排队期间又被隐藏就作废）；隐藏仍立刻广播。
- **壳自己发起的隐藏只报告意图**（热键 toggle / 托盘 / `⌘W`）：走 `window::toggle()` → `notify_toggled(false)`
  + 800ms 兜底（防内核失联），真正的 `hide()` 由内核在回执后发起。离场途中再按一次 = 取消隐藏
  （用「计划落地时间戳」当令牌）。
- **迟到的回执不能把窗口偷走**：`cancelPendingHide()` 换令牌，回执 / 兜底到点发现令牌变了就退出。
  内核自己 `showWindowAnimated()` 与壳报 `window/toggled{visible:true}` 两处都要调用。
- **重复调用搭同一班车**：一次 `ctx.hostUi.hide` 会从内核与 UI 两条路走回来，只落地一次。
- 同一高度重复请求、`prefers-reduced-motion`、幅度 > 280px 时，`windowMotion.ts` 直接落位不缓动。
- **谁改了跨进程共享状态，谁就必须回报**：托盘「唤出启动台」、单实例二次启动、`CloseRequested`（`⌘W`）
  都必须通知内核 —— 漏报会让 UI 停在透明态或下次唤出没有入场动画。

## 3. UI 侧实现规则

- **两个稳定态之间做 `transition`，不用 keyframes 重放**：隐藏态是静止态
  （`opacity: 0` + `scale(0.94) translateY(-10px)`，落差对齐聚焦搜索）。keyframes 需要「移除类 → 强制重排 → 加回类」，
  且窗口被提前隐藏时 WebView 暂停渲染，动画可能永远卡在半透明。
- **显示要等页面真的在画**：统一走 `setWindowVisible()` —— 隐藏立即做；显示先等 `visibilitychange`
  （400ms 兜底）、再等 `waitForPaint()`（页面可见后两帧；120ms 上限 + setTimeout 保险），然后才摘掉隐藏态。
  白屏比没有动画严重得多。
- 所有 Vue `<Transition>` 显式传 `:duration`，收尾走定时器而不是 `transitionend`。
- 窗口高度逐帧 `setHeight`（约 10 次 IPC / 160ms），顺序发送、不并发 —— 并发会让到达顺序不确定，窗口来回抖。
- 任何新的隐藏入口都必须走 `hideWindowAnimated()`（内核侧）或 `window::toggle()`（壳侧），否则回执链路会断。

## 4. 明确不采用

- **壳侧加 `set_opacity` / NSWindow 动画**：壳保持零业务，CSS 已能画，多一条跨进程通道只增加同步负担。
- **UI hold 住 hide（先演再让内核隐藏）**：裁决权会分裂到两个进程。**回执不是裁决** —— UI 只说「演完了」，落地仍由内核决定。
- **隐藏保持瞬时**（Raycast 的做法）：与「弹入」不对称，观感是「唤出很顺、关闭很生硬」。
- **结果格子逐条错峰进场**：搜索 80ms 防抖 + 每次按键都换内容，错峰会和下一次按键的动画叠在一起。
- **`@starting-style` / `allow-discrete`**：解决的是 `display` 过渡，管不了组件真正被卸载的场景。
