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

## 4. 窗口材质：Liquid Glass 的全平台 CSS 近似

> 2026-11-10 起，启动台与插件页统一采用 **Liquid Glass** 视觉语言：折射 + 镜面高光 + 半透明分层。
> 不依赖 WKWebView 私有材质，也不引入 macOS 26 `NSGlassEffectView` 分支 —— 项目兼容 macOS 11+ 与
> Windows 便携版，必须一套 CSS 全平台成立。

### 4.1 三层结构

| 层 | 绘制内容 | 落点 |
|---|---|---|
| **折射底** | `backdrop-filter: blur() saturate()` + 极淡的桌面透过色 | `.shell::before`（宿主）/ `.launcher-glass`（插件页） |
| **镜面** | 顶部 1px 内高光、半透明描边、斜向 specular 渐变、底部内阴影 | `.shell::after`（宿主）/ 共享类 `.launcher-rim` |
| **内容** | 文本、网格、输入框、浮层 | 普通子树，永远在玻璃层之上 |

**硬约束（都是实测坑，别改回去）：**

- **不能把 `backdrop-filter` 直接加到 `.shell`**：模糊层先按矩形绘制、再事后裁剪，圆角外会漏出一圈模糊像素；
  而窗口系统阴影按内容 alpha 轮廓生成，角落一旦有像素，阴影就退化成矩形（底部两角出现直角灰边）。
- **不能给 `.shell` 加 `box-shadow`**：阴影全在窗口裁切区外，一个像素都看不见，却会让 WebKit 把元素推进
  「带外阴影的合成层」路径 —— 贴住窗口底边的两个圆角被画成直角。
- 玻璃层只能放在**伪元素 / 内部绝对定位层**里，并用 `border-radius` + `clip-path: inset(0 round var(--radius-shell))`
  双重裁剪；负 `z-index` 让它们位于内容之下、`.shell` 背景之上（`.shell` 需要 `isolation: isolate`）。
- 折射用内联 SVG filter（`feTurbulence` + `feDisplacementMap`）只作用于**边缘 1–2px 的高光环**，
  `scale` 控制在 2–6；不要对整块面板或文字做位移，否则会糊。
- 不引入彩色光斑 / 渐变球：工具类界面保持中性色，玻璃只负责层次与光线。

### 4.2 材质令牌

宿主在 `apps/launcher-ui/src/styles/app.css`、插件侧在 `theme.css`（前缀 `--launcher-`）各有一份，**取值成对**：

| 令牌 | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--glass-tint` | `rgba(250,252,255,.62)` | `rgba(18,22,30,.58)` | 窗口底色（桌面透过的基色） |
| `--glass-scrim` | `rgba(255,255,255,.20)` | `rgba(8,11,16,.26)` | 压在底色上的对比保护层 |
| `--glass-panel` | `rgba(255,255,255,.74)` | `rgba(30,36,46,.72)` | 抬升面（菜单、详情、卡片） |
| `--glass-panel-strong` | `rgba(255,255,255,.88)` | `rgba(34,41,52,.88)` | 浮层（对话框、右键菜单） |
| `--glass-sunken` | `rgba(15,23,42,.045)` | `rgba(0,0,0,.22)` | 下沉面（输入框、凹槽） |
| `--glass-hi` | `rgba(255,255,255,.90)` | `rgba(255,255,255,.16)` | 顶部 1px 内高光 |
| `--glass-lo` | `rgba(15,23,42,.12)` | `rgba(0,0,0,.50)` | 底部内阴影 |
| `--glass-rim` | `rgba(255,255,255,.55)` | `rgba(255,255,255,.14)` | 内描边（镜面环） |
| `--glass-edge` | `rgba(15,23,42,.10)` | `rgba(255,255,255,.10)` | 外发丝线（语义色 `--border` 的来源） |
| `--glass-specular` | 顶部白 55% → 透明 | 顶部白 10% → 透明 | 镜面渐变 |
| `--glass-blur` | `32px` | 同值 | 背景模糊半径 |
| `--glass-saturate` | `170%` | 同值 | 背景饱和 |
| `--elev-1/2/3` | 冷灰软阴影 | 纯黑深阴影 | 层内浮起（**不含** `.shell` 自身） |

圆角、字阶、间距同样收敛成令牌（`--radius-shell` 22px、`--radius-md` 12px、`--radius-lg` 16px、
`--text-hero` 19px / `--text-body` 13px / `--text-caption` 11.5px、`--space-4` 8px 等），
组件里不再写裸数值；插件侧镜像加 `--launcher-` 前缀。

### 4.3 明暗与对比度

- 明暗两版必须**成对**给出（插件侧沿用 `--launcher-if-light` / `--launcher-if-dark` 单行写法）。
- 正文与背景的对比度不得低于 4.5:1：玻璃的透明度只用于「看得见材质」的边缘与大块面，
  文本所在的内层面板保持 `--glass-panel-strong` 及以上不透明度。
- 焦点环统一 `0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)`，深浅主题都可见。

### 4.4 动效与材质的关系

材质不改变 §1 的时长档位。玻璃进出场沿用 `--motion-*` / `--motion-ease-*`；
`prefers-reduced-motion` 仍然只重定义令牌，玻璃层不会因为透明而变成硬跳。

## 5. 明确不采用

- **壳侧加 `set_opacity` / NSWindow 动画**：壳保持零业务，CSS 已能画，多一条跨进程通道只增加同步负担。
- **UI hold 住 hide（先演再让内核隐藏）**：裁决权会分裂到两个进程。**回执不是裁决** —— UI 只说「演完了」，落地仍由内核决定。
- **隐藏保持瞬时**（Raycast 的做法）：与「弹入」不对称，观感是「唤出很顺、关闭很生硬」。
- **结果格子逐条错峰进场**：搜索 80ms 防抖 + 每次按键都换内容，错峰会和下一次按键的动画叠在一起。
- **`@starting-style` / `allow-discrete`**：解决的是 `display` 过渡，管不了组件真正被卸载的场景。
