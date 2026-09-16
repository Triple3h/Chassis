# ADR-0004：动效语言 —— 令牌单一来源 + 窗口离场由内核收口

- 状态：已采纳
- 日期：2026-09-16
- 相关：`docs/launcher-requirements.md` §3.1 / §3.2 / §6.2；`apps/launcher-ui/src/styles/app.css`；`packages/ui/styles/theme.css`

## 背景

启动台是对标 macOS 面板类应用的常驻工具，"唤出来那一下"就是它的第一印象。改造前实测的现状：

- **窗口完全没有显隐动画**：壳 `show()` / `hide()` 都是瞬时的。UI 早已订阅 `shell/visibility`，但收到即忽略。
- **时长散落无处可查**：`0.12s` / `0.14s` / `0.15s` / `0.18s` 与 Tailwind 默认 `150ms` 混用，缓动在 `ease` / `ease-out` / `ease-in-out` 之间随机。
- **`prefers-reduced-motion` 全仓库 0 处**。
- 二级面板只有进场没有离场；右键菜单、toast、插件视图、插件侧对话框完全没有动效；窗口高度随结果行数瞬跳。

窗口本身是 `transparent(true)` + `decorations(false)`，视觉上只有 `.shell` 这层圆角毛玻璃会被画出来 ——
所以"窗口弹出"完全可以在 CSS 里做，不需要壳参与绘制。

## 决策

### 1. 令牌是唯一来源，降级只改令牌

两处 `:root` 各一份同值令牌（宿主 `--motion-*`、插件 `--launcher-motion-*`）：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--motion-instant` | 90ms | 按压、hover、状态色 |
| `--motion-fast` | 140ms | 离场、小元件 |
| `--motion-base` | 200ms | 进场、面板 |
| `--motion-slow` | 320ms | 大块内容（骨架） |
| `--motion-ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进场：强减速"落到位" |
| `--motion-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | 离场：加速"果断走" |
| `--motion-ease-move` | `cubic-bezier(0.4, 0, 0.2, 1)` | 位移 / 颜色 |
| `--motion-ease-spring` | `cubic-bezier(0.34, 1.4, 0.64, 1)` | 只给"弹出"用（轻微过冲） |

两条硬规矩：

- **离场一定比进场短。** 离场是用户已经在等结果的动作，拖长只会让人觉得卡。
- **`prefers-reduced-motion` 只重定义令牌本身**（时长压到 1ms、缩放归 1、位移归 0），
  组件里不再写第二遍媒体查询。保留了透明度变化 —— 那是淡入淡出而非位移，无障碍规范普遍接受。

命名刻意避开 `--ease-*` / `--duration-*`：那是 Tailwind v4 的主题命名空间，同名会被覆盖。

### 2. 窗口显隐拆成「广播」和「落地」两步，落在内核

```
壳 show/hide ──► window/toggled{visible} ──► 内核 emit shell/visibility ──► UI 播动画
                                  ↑
内核自己发起：showWindowAnimated() / hideWindowAnimated()
```

- **`window/toggled` 的方向不变**：壳仍然是显隐的唯一裁决者，内核只广播、绝不 toggle（ADR 之前的不变量，测试仍在守）。
- **新增的是「隐藏晚 130ms 落地」**：`hideWindowAnimated()` 先 `emit('shell/visibility', {visible:false})`，
  等 `HIDE_ANIMATION_MS` 再真去敲壳。UI 拿到广播后播 140ms 的淡出 + 缩放。
- **队列中的隐藏可以被撤销**：`cancelPendingHide()` 换一个令牌，定时器到点发现令牌被换过就自己退出。
  必须在两处调用 —— 内核自己 `showWindowAnimated()` 时，以及壳报来 `window/toggled{visible:true}` 时。
  少了后者就是「热键连按 → 窗口被上一次隐藏偷走」。
- **重复调用搭同一班车**：一次 `ctx.hostUi.hide` 会同时从内核和 UI 两条路走回来，重启计时器只会让窗口多赖 130ms。
- 同一高度重复请求、`prefers-reduced-motion`、幅度 > 280px 时，`windowMotion.ts` 直接落位不缓动。

### 3. 所有显隐路径都必须回报结果

改这条时发现壳有两条路径改完显隐**不通知内核**，在"隐藏态是透明的"新前提下会直接白屏，已一并修掉：

| 路径 | 原来的问题 |
|---|---|
| 托盘菜单「唤出启动台」 | 只 `show()` 不回报 ⇒ UI 停在透明态 |
| 单实例二次启动（`single_instance`） | 只 `show()` 不回报 ⇒ 同上 |
| `CloseRequested`（`⌘W`） | 只 `hide()` 不回报 ⇒ UI 以为还可见，下次唤出没有入场动画 |

规律可以推广成一句话：**谁真正改了跨进程共享的状态，谁就必须把结果报回来。**

### 4. 用「两个稳定态之间做 transition」，不用 keyframes 重放

`.shell` 的隐藏态（`opacity: 0` + `scale(0.97) translateY(-6px)`）本身是一个静止态，
显隐就是在这两个态之间做 `transition`。刻意不选 keyframes 动画，是因为要避开两个坑：

- 重放动画需要"移除类 → 强制重排 → 加回类"那套 hack；
- 窗口被壳提前隐藏时 webview 会暂停渲染，动画可能卡在中途，元素就永远停在半透明。

同理，所有 Vue `<Transition>` 都显式传 `:duration`，收尾走定时器而不是 `transitionend`。

## 后果

**收益**

- 唤出/收起有了完整的弹出感；二级面板、右键菜单、toast、插件视图、插件对话框全部对齐同一手感。
- 想调整整体节奏只改 8 个数值；降级只改一处。
- 修掉了三条"改完显隐不回报"的路径（其中两条原本会导致白屏）。

**代价**

- 隐藏晚 130ms 落地。这是刻意的取舍：换来的是不"啪"地消失。130ms 在人类感知阈值附近，
  且与壳原有的 120ms 失焦防抖叠加后仍然无感。
- 窗口高度改为逐帧 `setHeight`（约 10 次 IPC / 160ms）。顺序发送、每帧一次，不并发 ——
  并发会让壳侧的到达顺序不确定，窗口会来回抖。
- `HideAnimation` 让"隐藏"不再是同步操作，任何新的隐藏入口都必须走 `hideWindowAnimated()`。

## 备选方案与不采纳原因

| 方案 | 不采纳原因 |
|---|---|
| 壳侧加 `set_opacity` / NSWindow 动画 | 壳要保持零业务；且 CSS 已经能画，多一条跨进程通道只增加同步负担 |
| UI 侧 hold 住 hide（先演再让内核隐藏） | "什么时候隐藏"的裁决权会分裂到两个进程，正是 §6.2 明确否掉的形态 |
| 隐藏保持瞬时（Raycast 的做法） | 与"弹入"不对称；实测观感是"唤出很顺、关闭很生硬" |
| 结果格子逐条错峰进场 | 搜索是 80ms 防抖 + 每次按键都换内容，错峰会和下一次按键的动画叠在一起，看着更乱 |
| 用 `@starting-style` / `allow-discrete` 做卸载动画 | 解决的是 `display` 过渡，管不了组件真正被卸载的场景 |
| 插件侧对话框改造成受控 `open` prop 以拿到离场 | `ImportDialog` / `SaveDialog` 依赖 `onMounted` 做摄像头与自动聚焦初始化，改成常驻会改变行为；先只补进场 |
