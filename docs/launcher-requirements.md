# 启动台底座 · 需求与实现文档

> 版本：v1.0 ｜ 状态：已实施（进度见 `README.md` 的「当前状态」）｜ 日期：2026-09-14，最后更新：2026-09-17
> 读者：实现者 / 评审者 / 后续参与的人
> 用法：本文件是**唯一的需求源**。开工时按 §13 的里程碑推进；遇到本文件没写的行为，先补文档再写代码。
> 说明：§5 的目录树是**规划口径**（模块视角）；**实际落地的结构以 `README.md` 的「目录结构」为准**。

---

## 1. 产品定义

### 1.1 一句话

一个**插件化的 macOS 启动台**：全局热键唤出、输入即搜、结果支持**最近使用**与**已固定**。底座**零能力**，所有能力（包括「启动应用」本身）都以插件形式一点点集成进来。

### 1.2 核心原则

| # | 原则 | 含义 | 违反的后果 |
|---|---|---|---|
| P1 | 底座零能力 | 内核里不出现任何具体能力（扫描应用、读文件、连网、算 TOTP…） | 插件化就不彻底，第三方插件永远是二等公民 |
| P2 | 出厂自带 ≠ 内核内嵌 | 官方插件走同一套插件机制，可禁用、可卸载（仅管理面除外） | 官方能力会慢慢爬回内核 |
| P3 | 能力无关的数据模型 | 历史/固定/结果项的 schema 里不出现能力特定字段（如 `app.path`） | 加一类插件就要改内核 |
| P4 | 注册即可逆 | 任何注册必须返回 disposer，插件停用按序回滚 | 启停/热重载/崩溃重启留残留 |
| P5 | 能力即权限 | 未声明的 capability 在装配期就不注册，插件侧表现为"方法不存在" | 权限只能靠运行时判断 + 提示，安全边界形同虚设 |
| P6 | 一切跨进程调用可审计 | 插件→宿主调用统一入口 + 落本地审计日志 | 插件出问题只能靠猜，无法定位是哪次调用出的错 |
| P7 | 插件代码只读、数据分离 | `extensions/<id>/` 只读；数据落 appData 下独立目录 | 升级插件丢用户数据 |

### 1.3 验收口径（贯穿全程的一句话）

> **清空所有插件目录后，应用仍能启动、能唤出、能搜索（结果为空）、能显示空的"已固定／已安装插件"、能安装插件。**

### 1.4 明确不做（第一版）

打包体积外的**一切具体能力**、插件市场、云同步、多账户、超级面板（中键唤出）、自动化/CDP、AI、移动端、Windows（M0–M3 只做 macOS）。

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| **壳（Shell）** | Rust 层。只提供系统原语（窗口/热键/托盘/通知/剪贴板/打开），**零业务逻辑** |
| **内核（Kernel）** | Rust 进程（bin `launcher-kernel`）。插件运行时 + 服务总线 + 注册表 + 历史/固定 + 审计 |
| **底座** | 壳 + 内核 + 启动台 UI + 管理面，即"零能力"的那部分 |
| **插件（Plugin）** | 一个目录，含清单 + 可选的 Web 页（view）+ 可选的可执行产物（no-view / script） |
| **能力（Capability）** | 插件可申请的宿主能力，如 `storage`、`clipboard.write`、`shell.open`、`exec.spawn` |
| **接缝（Seam）** | 内核里以抽象 key 暴露的服务（`ctx.storage` 等），实现可由 provider 替换 |
| **internal 插件** | 不可卸载的插件（设置、插件管理器） |
| **bundle** | 出厂自带的插件集合，机制与第三方插件完全相同 |

---

## 3. 用户可见行为规格

### 3.1 唤出与隐藏

| 行为 | 规格 |
|---|---|
| 全局热键 | 默认 `⌥Space`（可改，存配置）。**注册失败要提示并引导换键**（被别的 App 占用是常态） |
| 唤出表现 | 无边框、置顶、圆角、居中于**当前鼠标所在屏幕**（多屏），宽度 720px，高度自适应（初始 480px，最多 640px） |
| 拖动 | 按住面板顶部（搜索栏那一行 / 顶缘 8px 热区）可移动窗口；输入框与按钮上不触发（那是文本选择与点击） |
| 缩放 | 面板四边 + 四角可拖拽缩放（最小 480×240，上限为屏幕工作区）；缩放后停止自适应高度 |
| 尺寸记忆 | 用户调过的尺寸**按模式分别记住**：`host` = 搜索态，`plugin` = **所有插件页**（设置页 / 各插件视图共用这一份，不按插件拆分），存 `config.windowSizes`；下次唤出 / 进入插件页时还原 |
| 恢复默认大小 | 当前模式的尺寸被改过时，搜索栏右侧（插件页在 footer 右侧）出现「恢复默认大小」按钮：清掉该模式的记忆尺寸 + 回到默认形态（启动台 = 内容自适应，插件页 = 560 高） |
| 选中文本 | 唤出时若前台 App 里选中了文本，且搜索框当前为空 ⇒ 这段文本作为初始查询带入（macOS 需"辅助功能"权限，未授权时静默跳过） |
| 状态显示 | 搜索栏右侧常显**启动台自身**的 CPU 与内存占用（壳 + 内核两个进程；约 3s 刷新一次，窗口隐藏时暂停），悬停给出分解与整机对照 |
| 隐藏 | `Esc`；失焦（可配置，默认开）；再次按热键；执行完"隐藏型"命令后 |
| 显示时 | 搜索框自动聚焦，输入框内容**保留上次的选中状态但默认清空**（可配置"保留上次输入"） |
| 托盘 | 左键点击 = 唤出/隐藏；右键菜单 = 设置 / 插件管理 / 重载全部插件 / 退出 |
| 单实例 | 第二次启动只唤起已运行实例 |
| 开机自启 | 可配置，默认关 |

### 3.2 搜索与结果网格

**结果以「图标网格」呈现**：分区标题 + 每行 N 个格子（图标 + 名称两行截断），列数由窗口宽度算出（720px ⇒ 7 列，上限 9）。

**空输入时**展示（按此顺序）：

1. **已固定**（`PinnedItem`，按用户拖拽顺序；默认露 1 行，超出时标题右侧显示「展开 (N)」）
2. **已安装插件**（首页 = 插件的入口清单：每个插件一条，取 `mode: view`、未 `hidden` 的入口命令 —— 同插件有多条时取清单顺序里第一条 `searchable` 的；按该插件**最近一次使用**倒序，没用过的排在后面按标题；已固定在上一分区的入口不重复出现；默认露 2 行，超出同上）

空输入的首页**不展示最近使用** —— 它只在有输入时作为命中分区出现（见下）；`ResultItem` 里的应用 / 文件 / 网址这类条目仍可通过固定或搜索直达。

**有输入时**展示：

1. **最佳匹配**（跨插件合并后的搜索结果，最多 20 条；默认露 3 行）
2. **已固定**中命中的项（置顶，带固定标记）
3. **最近使用**中命中的项（权重低于最佳匹配；可在设置里关掉"最近使用参与搜索"）

**每个格子的渲染**：图标 36px（无图标时退化为字形磁贴 / 首字母磁贴）+ 名称（2 行截断）；副标题与插件名进 tooltip。非固定分区里命中固定项时右上角有固定角标，插件不可用时整格置灰并标 `!`。

**分区标题**：左「最近使用」右「展开 (19) / 收起」，整行可点。

**键盘**：

| 键 | 行为 |
|---|---|
| `↑` `↓` | 同列换到上一排 / 下一排（跨分区连续；落点排更短时贴到排尾） |
| `←` `→` | 逐格左右移动（跨分区连续） |
| `Tab` / `⇧Tab` | 同上，逐格前后移动 |
| `Enter` | 执行选中项的默认动作 |
| `⌘Enter` / `⇧Enter` | 执行第二动作（若声明） |
| `⌘I` | 展开 / 收起二级面板（该项有 `detail` 时） |
| `⌘K` | 打开动作面板（等同右键菜单） |
| `⌘,` | 打开设置 |
| `Esc` | 分步退出：收起二级面板 → 清空输入 → 隐藏窗口 |

**鼠标**：单击执行；右键 = 动作菜单；拖拽固定项 = 重排（仅空输入且该分区已展开）；点空白处回到搜索框。

**性能红线**：输入到首屏结果 ≤ 100ms（可用旧结果 + 高亮，不闪空白）；结果 > 200 条必须虚拟滚动。

### 3.3 动作菜单（右键 / ⌘K）

底座提供固定项：

| 动作 | 条件 |
|---|---|
| 固定 / 取消固定 | 总是 |
| 复制标题 | 总是 |
| 移出最近使用 | 该条来自历史 |
| 打开插件所在目录 | internal 项或已安装插件 |
| 禁用 / 卸载该插件 | 该条来自插件 |

插件可通过 `ResultItem.actions[]` 追加自己的动作。

### 3.4 设置面板（internal 插件）

分组：**通用**（热键、开机自启、隐藏行为、语言）、**外观**（主题 跟随系统/浅/深、主题色、结果密度）、
**插件**（主从两栏，见下）、**数据**（历史条数上限、清空历史、清空审计日志、数据目录位置）、
**关于**（版本、检查更新、许可证、日志）。

**插件页（主从两栏）**：左列表带搜索（插件名 / id / 命令名）与状态筛选（全部 / 启用 / 禁用 / 异常），
每行显示**插件图标**（清单 `icon`，与宿主结果网格同一个图标表；没有可渲染的图标就退回首字母磁贴）、
状态点（做在图标右下角的角标上）与命令数；右侧详情是**分页（TAB）排版**：头部（图标 / 名称 / 版本 / 状态徽章 / 描述）固定在上，
下面一条**吸顶**的页签栏，再下面是页内容（详情很长时页签不会被命令列表挤出去）。页签：

- **概览**（默认）：插件信息（id / apiVersion / 作者 / 安装目录）、能力、操作；
- **设置**：**由清单 `settings` 声明激活** —— 声明了才有这一页，没声明的插件不出现
  （字段与语义见 plugin-spec §3.4）；按声明渲染 select（自绘下拉）/ switch / text 三类控件，
  改完立即保存并重载该插件（script / no-view 通过 `ctx().settings` 读取，值在 worker 启动时注入）；
  值存 `<dataRoot>/plugin-settings.json`，未改过的项回落清单 `default`，改过的项提供「恢复默认」；
- **别名**：插件级别的兜底别名（命令自己的别名在「命令」页）；
- **命令**：逐条列出（名称 / 标题 / 模式 / 是否可搜索 / 是否贡献结果 / 报错），
  `searchable` 与 `contributes` 的命令可就地编辑**命令级别名**；

页签细节：切换插件时保留当前页（换到没有该页的插件时回落「概览」）；`←/→` 可切页；
页签上带小圆点 = 该页里有「被用户改过」的项（设置项 / 别名），一眼看出动过哪里。

详情内容：

- **基础能力**（出厂 bundle 里 `essential: true`，即应用启动器 / 文件搜索 / 设置与插件管理）带「基础」标记并**置顶**；
  不可禁用、不可卸载（界面不渲染禁用开关与卸载按钮，内核 `setDisabled` 直接拒绝；配置里残留的禁用项在启动时被清掉）；
- 其余插件在列表行上有**启用 / 禁用开关**（启用中半透明、悬停与选中全显；已禁用常显；`role=switch` 键盘可达），详情「概览」页也有对应按钮；
- 能力列表可点击**拒绝 / 恢复**（写 `config.denied`，插件立即重载）；已拒绝的能力红字划掉；
- 别名编辑走 chip 输入：回车或逗号添加、`×` 删除、停顿或失焦自动保存并提示「搜索立即生效」；
  实际参与搜索 = 插件级 ∪ 命令级；每项提供「恢复默认」；
- 别名存 `<dataRoot>/plugin-overrides.json`，**不写插件产物**（重装 / 更新插件不丢），改完无需重载；
- 危险操作（卸载，需二次确认）与常规操作（重载 / 打开目录 / 数据目录）都在「概览」页的操作区（卸载靠右、红色）；
- 安装入口在列表底部（zip / 目录路径），另支持把 zip 拖进启动台窗口。

刷新策略：列表轮询只在**摘要真的变了**且用户没有正在编辑时才重渲染（否则会打断输入、丢焦点）。

### 3.5 插件安装

| 方式 | 规格 |
|---|---|
| 从文件夹 | 拖 zip 或选区目录 → 校验清单 → 落到 `extensions/<id>/` → 立即加载 |
| 从 zip | 同上（zip 内必须含 `package.json`，允许一层包裹目录） |
| 目标目录 | `<dataRoot>/extensions/`（用户级）；`<appRoot>/builtin-plugins/`（出厂 bundle，只读、可禁用不可卸载） |
| 冲突 | 同 id 时提示覆盖 / 并存（并存则后加载者 id 加后缀 `-2`） |

---

## 4. 总体架构

### 4.1 进程与通信

> **2026-09-17 更新（M5）**：内核与逻辑层插件的**实现语言改变、对外协议不变** —— 三条链路（壳 ↔ 内核 stdio JSON-RPC、UI ↔ 内核 HTTP/SSE、插件页 ↔ 宿主 postMessage）**字段级不变**；逻辑层插件（`no-view` / `script`）载体从 Node `worker_threads`（`.mjs`）改为**独立子进程 + NDJSON over stdio**（可执行产物）。决策与理由见 `docs/decisions/ADR-0005-kernel-language.md`。

```
┌──────────────────────── 壳（Rust / Tauri 2） ────────────────────────┐
│  窗口 · 全局热键 · 托盘 · 单实例 · 通知 · 剪贴板 · open(URL/文件/应用)  │
└───────▲──────────────────────────────────────────────┬───────────────┘
        │ Tauri command / event                         │ spawn + stdio
        │                                               ▼
┌────────────── 内核（Rust sidecar，bin: launcher-kernel） ─────────────┐
│  插件运行时 · 服务总线(seam) · 命令/搜索注册表 · 执行管线 · 历史/固定   │
│  审计 · 默认存储 provider · 每插件一个 HTTP listener（独立 origin）    │
└───▲───────────────────────────────┬───────────────────────────────────┘
    │ postMessage（每会话 token）     │ spawn + NDJSON（done/log/progress）
    │                                 ▼
┌───┴────────────┐          ┌────────────────────────┐
│ 插件 view 页    │          │ 插件逻辑层命令           │
│ （iframe，独立  │          │ （可执行产物 dist/<name>）│
│   origin）      │          └────────────────────────┘
└────────────────┘
```

- **壳 ↔ 内核**：内核作为 Tauri sidecar 由壳拉起，走 **stdio + newline-delimited JSON-RPC 2.0**。壳只实现 §6.1 的原语方法，不实现业务。
- **内核 ↔ 启动台 UI**：启动台 UI 由壳的 WebView 加载（Tauri 的 asset 协议），通过 Tauri 的 `invoke`/`event` 与壳通信，再由壳转发给内核；**或者**（推荐实现更简单）内核也托管启动台 UI 的静态资源（`http://127.0.0.1:<uiPort>`），WebView 直接加载该 URL。二选一，ADR 记录。
- **内核 ↔ 插件页**：`http://127.0.0.1:<pluginPort>/index.html?sid=&cmd=&theme=&token=`，每插件一个 listener（端口不同 ⇒ origin 不同 ⇒ localStorage/IndexedDB 天然隔离）。
- **内核 ↔ 插件逻辑层**（M5 起）：宿主 `spawn` 可执行产物（`dist/<name>`，Windows 加 `.exe`），上下文经 `--launcher-context`（base64url JSON）注入；
  插件侧按行写 NDJSON：`{type:'log'|'progress'|'result'|'done'|'rpc'}`，宿主侧下发 `{type:'query'|'rpc-result'|'shutdown'}`。完整协议见 `docs/plugin-spec.md` §4.4。

### 4.2 谁负责什么（边界表）

| 职责 | 壳 | 内核 | 启动台 UI | 插件 |
|---|---|---|---|---|
| 窗口/热键/托盘/通知/剪贴板/open | ✅ | 调用 | — | 通过 API 申请 |
| 插件扫描、清单解析、生命周期 | — | ✅ | — | — |
| 插件页 HTTP 托管、会话与 token | — | ✅ | — | — |
| 搜索调度、排序、去重 | — | ✅ | 渲染 | 提供结果 |
| 历史/固定 的持久化与排序 | — | ✅ | 读写 | — |
| 权限裁剪、审计 | — | ✅ | — | 声明 capability |
| 具体能力（扫描应用、文件搜索…） | — | ❌ | — | ✅ |

---

## 5. 目标仓库结构

```
launcher/
├── apps/
│   ├── shell/                        # Rust / Tauri 2
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── icons/
│   │   └── src/
│   │       ├── main.rs               # 启动、单实例、拉起内核
│   │       ├── ipc.rs                # JSON-RPC over stdio
│   │       ├── primitives/
│   │       │   ├── window.rs         # show/hide/position/resize/center-on-cursor
│   │       │   ├── hotkey.rs         # 注册/改键/冲突提示
│   │       │   ├── tray.rs
│   │       │   ├── notify.rs
│   │       │   ├── clipboard.rs      # 读/写文本（图片 v2）
│   │       │   └── opener.rs         # open URL / 文件 / 应用
│   │       └── sidecar.rs            # 内核进程管理（重启、日志转发、退出清理）
│   ├── kernel/                       # Rust（M5 起，bin: launcher-kernel；M0–M4 是 TypeScript / Node）
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── main.rs               # 启动装配：配置 → 壳连接 → HTTP → 载插件
│   │   │   ├── kernel.rs             # 编排：start/stop、patchConfig、托盘、退出收口
│   │   │   ├── config.rs             # 配置读写（含默认值、迁移）
│   │   │   ├── registry.rs           # 命令·搜索源·能力 注册表（全部返回 disposer）
│   │   │   ├── pipeline.rs           # pre-execute / execute / post-execute
│   │   │   ├── plugin/               # 清单解析、加载、启停、热重载、zip 安装
│   │   │   ├── audit.rs              # 统一 RPC 入口 + 审计日志
│   │   │   ├── history.rs            # 最近使用 + 已固定（持久化 + 排序）
│   │   │   ├── search.rs             # 搜索调度（debounce、合并、排序、去重）
│   │   │   ├── exec.rs               # 逻辑层子进程运行时（NDJSON）
│   │   │   ├── services/             # 宿主服务：storage / bridge / hostUi / primitives / …
│   │   │   ├── http/                 # UI 服务 + 每插件 listener 池（静态文件 + CSP）
│   │   │   └── link.rs               # 壳通信用（stdio JSON-RPC）
│   │   └── tests/
│   ├── launcher-ui/                  # Vue 3 + Vite + Pinia + Tailwind v4
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.ts
│   │       ├── App.vue
│   │       ├── components/{SearchBox,ResultGrid,GridItem,SectionHeader,DetailPanel,FooterBar,ActionsMenu}.vue
│   │       ├── stores/{data.ts,ui.ts}
│   │       ├── lib/grid.ts           # 结果网格：列数/度量/分区/导航
│   │       ├── lib/virtual.ts        # 虚拟滚动
│   │       ├── lib/keys.ts           # ⌘/Ctrl 归一化、快捷键表
│   │       └── styles/app.css        # @source 声明本包 src 与 packages/ui
│   └── ...
├── Cargo.toml                        # M5：Rust workspace 根（成员：packages/plugin-sdk-rs、apps/kernel、各逻辑层插件 plugins/<id>；
│                                     #     apps/shell 显式 exclude —— Cargo 要求成员位于根之下）
├── packages/
│   ├── plugin-api/                   # npm: @launcher/api（视图层 SDK，postMessage 客户端）
│   ├── plugin-sdk-rs/                # Rust 插件 SDK（launcher-plugin-sdk；取代 v1 的 plugin-api-node）
│   ├── plugin-manifest/              # 清单 TS 类型 + 校验（视图层 / 工具链 / 测试夹具；内核侧为 Rust 实现）
│   ├── ui/                           # npm: @launcher/ui（设计令牌 + AppShell / UiIcon / UiDialog + 前端工具）
│   └── plugin-cli/                   # 脚手架 + 打包（待办，尚未实现）
├── plugins/                          # 出厂 bundle（机制与第三方完全相同）
│   ├── app-launcher/                 # 应用扫描 + 启动（第一个做）
│   ├── file-search/
│   ├── web-open/                     # 网址 / 搜索引擎直达
│   └── internal-settings/            # internal：设置 + 插件管理（不可卸载）
├── scripts/
│   ├── build-all.mjs                 # 内核 + UI + 全部出厂插件
│   ├── run-ts.mjs                    # esbuild 打包 TS 后交给 node（测试用）
│   └── dev.mjs                       # 开发模式：内核（standalone）+ UI（vite dev）
├── tests/
│   ├── fixtures/echo-plugin/         # 覆盖全部宿主 API 的契约测试插件（Rust 版）
│   └── unit/ · contract/ · smoke/    # （harness 拉起真内核二进制）
└── docs/
    ├── launcher-requirements.md      # 本文件（需求源）
    ├── plugin-spec.md                # 第三方插件开发文档（面向插件作者）
    ├── architecture.md               # 内核实现细节
    ├── plugin-dev-guide.md           # 插件开发手册（Vue 工程实操）
    └── decisions/ADR-0001~0005.md
```

> 这棵树是 §5 的**规划口径**；实际落地的目录（含 `packages/ui` 与构建脚本分布）见 `README.md` 的「目录结构」。

---

## 6. 壳层规格（Rust）

### 6.1 原语清单（全部，不再多）

| 方法 | 参数 | 返回 | 备注 |
|---|---|---|---|
| `window.show` | `{ focus?: boolean }` | `{ selection?: string }` | 居中于鼠标所在屏；`selection` = 显示**之前**读到的前台选中文本（窗口一显示就来不及了） |
| `window.hide` | — | `void` | |
| `window.isVisible` | — | `boolean` | |
| `window.setHeight` | `{ height: number }` | `void` | 启动台自适应高度，钳制 320–640（宽度一并回到 720） |
| `window.setSize` | `{ width: number; height: number }` | `{ width, height }` | 用户记忆的窗口尺寸（宽度 480–2000、高度 240–1400）；内容自适应仍走 `window.setHeight` |
| `window.startDragging` | — | `void` | 无边框窗口：UI 在拖拽区 mousedown 时调用，之后的移动交给系统 |
| `window.startResizeDragging` | `{ direction: 'north'\|'south'\|'east'\|'west'\|'northEast'\|'northWest'\|'southEast'\|'southWest' }` | `void` | 无边框窗口的四边 / 四角缩放 |
| `selection.read` | `{ prompt?: boolean }` | `{ ok: boolean; text?: string; reason?: string }` | 前台 App 的选中文本（macOS 走 Accessibility API、Windows 走 UI Automation；`reason` 见 §6.2） |
| `hotkey.register` | `{ accelerator: string }` | `{ ok: boolean; reason?: string }` | 失败要能给出"被占用"的原因 |
| `hotkey.unregister` | — | `void` | |
| `tray.setMenu` | `{ items: TrayItem[] }` | `void` | 菜单由内核提供（便于插件加项） |
| `notify.show` | `{ title, body, silent? }` | `void` | 需要系统权限时返回 `{ ok:false, reason:'denied' }` |
| `clipboard.readText` | — | `string` | |
| `clipboard.writeText` | `{ text: string }` | `void` | 优先 `arboard`；失败回落 |
| `clipboard.watch` | `{ enabled: boolean }` | `{ ok: boolean; reason?: string }` | 订阅系统剪贴板**变化事件**（不带内容）。Windows：`AddClipboardFormatListener` → `WM_CLIPBOARDUPDATE`（零轮询）；其余平台 `{ ok:false, reason:'unsupported' }`。变化时壳主动通知内核 `clipboard/changed`（见 §4.1 通知表） |
| `open.url` | `{ url: string }` | `void` | 只允许 http/https/mailto |
| `open.path` | `{ path: string }` | `void` | 用系统默认程序打开 |
| `open.reveal` | `{ path: string }` | `void` | 文件管理器中显示（macOS Finder / Windows 资源管理器） |
| `app.quit` | — | `void` | |
| `app.setAutostart` | `{ enabled: boolean }` | `void` | |
| `app.info` | — | `{ version, platform, arch, dataRoot }` | |
| `app.usage` | — | `{ ok: boolean; rss: number; cpuMs: number }` | 壳进程**自身**的常驻内存（bytes）与累计 CPU 时间（ms）—— 状态条要"启动台一共占多少"，内核算另一半（Windows 上含挂在壳下的 WebView2 进程组：它是系统托管的独立进程，不加会严重低估） |

**壳主动通知内核**（无 `id`、不等应答，与请求同走 stdio JSON-RPC）：

| 通知 | 载荷 | 触发 |
|---|---|---|
| `window/toggled` | `{ visible, selection? }` | 热键 / 托盘 / 单实例**真正改了显隐**之后（不是"按了键"） |
| `window/blurred` | `{}` | 启动台失焦（延迟 120ms；`hideOnBlur` 打开时内核才隐藏） |
| `tray/menu` | `{ id }` | 托盘菜单项被点 |
| `clipboard/changed` | `{ changeCount, kinds: ('text'\|'image'\|'file'\|'unknown')[] }` | `clipboard.watch` 已开启且系统剪贴板变化。**不带内容**（内容由插件自己读，见 §8.6）；`unknown` = 本次没抢到剪贴板所有权、没读出格式 |

**壳不做的事**：不做搜索、不读插件目录、不认识"命令"这个概念、不做排序、不存历史。

### 6.2 窗体行为

- 无边框（`decorations: false`）、`alwaysOnTop: true`、`skipTaskbar: true`、透明圆角背景
- **可拖动 / 可缩放**（`resizable: true` + 最小 480×240）：无边框窗口的系统拖拽区已经不存在，
  拖动与四边/四角缩放由 UI 自己画把手、在 `mousedown` 时调 `window.startDragging` /
  `window.startResizeDragging`（系统接管后续的移动）。**手动缩放后不再自动调高度**，
  尺寸按模式记忆（`config.windowSizes.host` / `.plugin`，见 §3.1「尺寸记忆」）——
  下次唤出 / 进入插件页由 UI 用 `window.setSize` 还原；「恢复默认大小」清掉记忆、回到内容自适应
- macOS：`activationPolicy: Accessory`（不进 Dock）；`titleBarStyle: Overlay` 不需要（无边框）
- 失焦隐藏：监听 window blur（延迟 120ms，避免点击自身子窗口时误隐）
- 多屏：唤出时读鼠标坐标 → 选最近屏 → 该屏工作区居中（y 取 1/4 高度处更符合习惯）
- **选中文本**（`selection.read`）：macOS 走 Accessibility API（`AXFocusedUIElement` → `AXSelectedText`），
  需要"辅助功能"权限；未授权时**首次**带 `prompt` 调用一次系统引导，之后静默返回 `reason: 'denied'`。
  读不到时壳会先替前台 App 打开 `AXEnhancedUserInterface` / `AXManualAccessibility`（Chromium 系默认不建
  无障碍树 —— Chrome、Electron 的 VS Code / ZCode 都在此列）再短重试（预算约 90ms），并有后台线程按
  前台 App 预热，使常规唤出不吃这次等待；原生 App（企微、备忘录等）本就直接可读，不受影响。
  Windows 走 UI Automation（`GetFocusedElement` → `TextPattern.GetSelection`），**不需要任何授权**；
  只支持实现了 TextPattern 的控件（原生编辑框 / 浏览器内容 / Office），其余静默返回 `reason: 'unsupported'`。
  读取必须发生在 `window.show` **之前**（窗口一显示，前台 App 就变成了自己，选区也随之消失）
- 内核崩溃时：壳显示错误面板 + "重载内核 / 查看日志 / 退出"三个动作（不许白屏）

### 6.3 打包

- Tauri 2；内核作为 sidecar 打进 app bundle（`Contents/Resources/kernel/`）。**M5 起为 Rust 二进制 `launcher-kernel`（无 Node 运行时，见 ADR-0005）**；M0–M4 过渡期是 Node sidecar + 系统 Node
- macOS：签名 + 公证（**需第 1 周启动 Apple Developer 流程**）；更新走 `tauri-plugin-updater` + minisign
- Windows（M6）：**绿色版 zip**（`pnpm app:win` → `dist-app/Chassis-<version>-win-<arch>.zip`，解压双击即用；
  资源布局 `resources/{kernel,ui,builtin-plugins}` 与壳的查找顺序对齐）+ NSIS 安装包
  （`cargo tauri build --bundles nsis`；`webviewInstallMode: downloadBootstrapper` 安装时自取 WebView2，Win11 已自带）；
  **未签名** ⇒ 首次运行有 SmartScreen 提示（"更多信息 → 仍要运行"，写进 README）
- 目标（2026-09-17 更新为 M5 口径）：App 体积 ≤ 35MB（Rust 内核 + 5 个插件二进制 + 壳，不含 Node）；冷启动到可唤出 ≤ 800ms；常驻内存（壳 + 内核 + 常驻插件子进程，状态条口径）≤ 150MB

---

## 7. 内核规格（语言无关）

> **实现语言（2026-09-17 更新，M5）**：本节是**行为规格**，与实现语言无关。v1（M0–M4）实现为 TypeScript（`apps/kernel/src/`）；M5 起实现为 Rust（`apps/kernel/src/`，bin `launcher-kernel`）。下文代码片段用 TS 书写以便阅读 —— **字段名与语义是契约**，两份实现逐条一致。
> v1 模块 → M5 模块（完整映射见 `docs/m5-rust-and-windows.md` §A1.1）：`registry.ts` / `pipeline.ts` / `history.ts` / `audit.ts` / `search.ts` → 同名 `.rs`；`plugin.ts` → `plugin/{manager,admin,settings}.rs`；`context.ts` 的装配职责并入 `kernel.rs` 与 `plugin/manager.rs`。

### 7.1 服务总线

```ts
export interface PluginContext {
  readonly id: string                      // 插件 id
  readonly capabilities: ReadonlySet<string>
  // 声明式依赖（硬依赖）：缺任一服务，插件不构造
  // 可选依赖：ctx.inject(['clipboard'], () => { ... })，服务出现时才激活
  inject<T extends keyof Services>(names: (keyof Services)[], fn: (ctx: this) => void): Disposer
  // 一切注册都走 effect：返回 disposer，插件卸载时按注册逆序回滚
  effect<T>(fn: () => T | Disposer, label: string): T
  on(event: KernelEvent, fn: (payload: any) => void): Disposer
  // 服务访问（受 capabilities 约束，未授权时抛 CapabilityError 且方法不存在）
  readonly storage: StorageService
  readonly commands: CommandRegistry
  readonly searchResult: SearchResultService
  readonly hostUi: HostUiService
  readonly clipboard?: ClipboardService      // 需要 clipboard.write / clipboard.read
  readonly shell?: ShellService              // 需要 shell.open
  readonly exec?: ExecService                // 需要 exec.spawn
  readonly notify?: NotifyService            // 需要 notify.show
  readonly quicklink?: QuicklinkService
  readonly audit: AuditService
}
```

**装配期裁剪**：内核为每个插件构造 Context 时，**只挂载它声明且被授予的服务**。未授权 → 属性为 `undefined` 且属性名不出现在 `Object.keys`（插件侧探测 = "方法不存在"），同时写一条审计。

### 7.2 注册表

```ts
interface CommandRegistry {
  register(decl: CommandDecl): Disposer
  update(name: string, patch: Partial<CommandDecl>): void
  list(): CommandDecl[]
  invoke(name: string, args?: unknown): Promise<ActionResult>
}
interface SearchResultService {
  set(items: ResultItem[]): void      // 覆盖式：本次搜索的贡献（内核按 token 校验新鲜度）
  clear(): void
  append(items: ResultItem[]): void   // 增量（异步插件补位用）
}
```

规则：
- `CommandDecl.name` 在**插件内唯一**，全局 id = `${pluginId}:${name}`
- 停用插件 → 其命令与搜索结果全部撤回（disposer）+ 广播 `registry/changed`
- 冲突：两个插件注册同一 title 允许；同一 `pluginId:name` 不允许

### 7.3 执行管线

```
invoke(id, args)
  → resolve：命令是否存在、插件是否启用、capability 是否足够
  → pre-execute   （中间件：权限确认 / 提权提示 / 审计 / 速率限制）
  → execute       （view：打开插件页会话；no-view|script：spawn 可执行产物，NDJSON 收结果）
  → post-execute  （中间件：写历史 / 审计 / 失败重试 / 结果改写）
  → ActionResult
```

```ts
interface ActionResult {
  ok: boolean
  kind: 'view' | 'script' | 'open' | 'copy' | 'host'
  data?: unknown
  error?: { code: string; message: string }
  /** 执行后是否隐藏启动台；默认：view=隐藏，script=保持可见并展示进度 */
  hideLauncher?: boolean
}
```
中间件本身也是插件注册的（`ctx.effect(() => ctx.pipeline.use('pre-execute', fn), 'pipeline.use()')`），这就是"提权确认/审计/重试都是插件"的落点。

### 7.4 插件生命周期

状态机：`discovered → validating → loading → active → (disabled | error | crashed)`

| 事件 | 行为 |
|---|---|
| 扫描（加载前） | 识别插件根 → **平台 / 架构过滤**（`platforms` / `arch`，省略 = 不限制；不匹配 ⇒ 整包跳过，不进状态机，见 plugin-spec §3.5）；出厂基础插件被过滤记 `warn` |
| 加载 | 读清单 → 校验 → 起 HTTP listener → 构造受限接口面 → 装配期裁剪 → 逻辑层命令校验产物（缺失 → 该命令 `error`，错误码 `ENTRY_MISSING`）/ 注册命令（view 插件） |
| 停用 | 逆序回滚所有 disposer → 关 listener → 清理会话（`session/closed` 带 `reason: disable`） |
| 重载（热重载） | 停用（`reason: reload`）→ 重新读盘 → 加载 → 广播 `plugin/reloaded { pluginId, commands, ok }`；**保持历史与固定项不变**。原来开着的插件页会话必然失效（旧 listener 端口已停），由 UI 按 `commands` 用同一命令重开（新会话 / 新端口）——插件在自己的页面里重载自己也不会把页面打死 |
| 崩溃（view 页崩） | 标记 `crashed` → 命令置灰 + 可"重试"按钮，不影响其它插件 |
| 崩溃（脚本异常） | 只让该次调用 `fail()`，不改变插件状态（除非连续 N 次 = 3） |
| 目录变化 | 监听 `extensions/`（chokidar）→ 新增/更新/删除自动热重载 |

### 7.5 最近使用与已固定

```ts
/** 能力无关：不出现任何"应用/文件"概念 */
interface HistoryItem {
  key: string          // 稳定 key = `${pluginId}:${command}:${hash(args)}`（不是下标！）
  pluginId: string
  command: string      // 命令名，或非命令结果项的结果项 id（pluginKeyOf）
  title: string        // 展示快照：插件卸载/改名后仍可显示（置灰 + 提示）
  icon?: string
  args?: unknown
  action?: ActionDecl  // 结果项动作快照：open/copy 这类结果项靠它才能再次执行
  lastUsed: number     // epoch ms
  count: number        // 使用次数
}
interface PinnedItem extends Omit<HistoryItem, 'lastUsed' | 'count'> {
  order: number
}
```

- 持久化：`<dataRoot>/history.json`、`<dataRoot>/pinned.json`；写入 debounce 500ms + 原子写（临时文件 + rename）
- 历史上限：默认 500（可配置 100–2000），超出按 `lastUsed` 淘汰
- **只在 `execute` 成功且 `kind !== 'host'` 时写历史**（命令走 `invoke`；应用/文件/网址这类结果项走 `executeItem` 写快照，key 与搜索侧一致）
- **清单声明 `history: false` 的插件不写历史**（`PluginManager.excludesHistory`），启动装配期还会把已有条目摘掉（`dropHistoryBy`）：
  底座自身入口（设置 / 插件管理 / 应用启动 / 文件搜索）一用就占满「最近使用」，而它们随时搜得到。
  只影响最近使用 —— 搜索结果、**固定项**（用户的显式动作）与首页的「已安装插件」入口（按注册表算，历史只用来定顺序）都不受影响
- 置灰判定：`command` 是命令名（`COMMAND_NAME_RE`）时校验命令是否还在；是结果项 id 时只校验插件是否可用
- 排序公式（内核侧）：`score = 0.55 * match + 0.30 * recency + 0.15 * frequency`
  - `match`：标题前缀命中 1.0 / 包含 0.7 / 拼音全拼 0.6 / 首字母 0.5 / 副标题与 keywords 0.4
    - `keywords` = **插件级 ∪ 命令级**（忽略大小写去重）；用户在设置页改的别名存
      `<dataRoot>/plugin-overrides.json`，覆盖清单原值，改完注册表即时更新
  - `recency`：`exp(-Δh / 72)`（半衰 3 天）
  - `frequency`：`min(1, log2(count + 1) / 5)`
  - 插件自评 `score` 存在时：`final = 0.6 * pluginScore + 0.4 * kernelScore`
- 固定项恒在最前（按 `order`），不受搜索影响（但高亮命中）
- 失效项（插件已卸载/命令已不存在）保留展示但置灰，设置里提供"清理失效项"
- 插件改过 id（改名链模块：v1 `apps/kernel/src/legacy.ts` / M5 `apps/kernel/src/legacy.rs`）时，启动装配期把条目的 `pluginId` 与 key 前缀一次性迁到新 id（同 key 合并）——否则老条目会被置灰判定当成"插件不可用"

### 7.6 搜索调度

1. 输入（debounce 80ms）→ 生成 `queryToken`（自增）
2. 广播 `search/query` 给所有 `searchable` 命令所属插件 + 内置的拼音索引
3. 插件在 **200ms 内** 回 `ctx.searchResult.set(items)`；超时不计入（不回滚已显示的）
4. 合并：按 `id` 去重（保留 `score` 高者）→ 计算最终分 → 排序 → 交 UI
5. **防抖稳定**：新结果到达时若已显示的项集合不变，只更新分数不改顺序（避免列表抖动）
6. 空输入：不发广播，直接返回 `pinned + recent + plugins` —— `recent` 是历史快照（UI 首页不渲染），
   `plugins`（已安装插件入口）只由注册表 + 历史算出（§3.2），**不触发任何插件调用**

### 7.7 审计

```ts
interface AuditRecord {
  ts: number
  pluginId: string
  channel: 'ui' | 'script' | 'kernel'
  method: string            // 如 'clipboard.writeText'
  ok: boolean
  ms: number
  capability: string
  error?: { code: string; message: string }
  truncatedArgs?: string    // 截断到 200 字符，敏感字段（token/key/password）打码
}
```
- 落 `<dataRoot>/logs/audit-YYYY-MM-DD.jsonl`，滚动保留 7 天；内存环形缓冲 500 条供设置页查看
- **每个插件→宿主的调用都必须过这里**，没有旁路（这是 P6 的实现方式）
- 例外：**底座基础能力**（§7.5 的 `essential` 插件 —— 出厂声明、不可禁用）的调用不落审计。
  它们等价于底座自身的行为，且调用量最大（设置页轮询、应用扫描、文件搜索），
  全记下来只会挤满环形缓冲与日志文件、把真正需要追溯的第三方插件记录淹掉

---

## 8. 插件规范

### 8.1 目录与产物

```
<pluginId>/
├── package.json          # 清单（宿主只读顶层字段）
├── index.html            # view 命令入口（所有 view 命令共用）
├── assets/               # 前端产物
├── <command>             # no-view / script 命令产物（Windows 为 <command>.exe），文件名 == commands[].name
└── data/                 # ❌ 不要放这里（数据落 appData）
```
宿主查找产物顺序：`<name>(.exe)` → `workers/<name>(.exe)`（可执行文件；apiVersion 2）。

### 8.2 清单（`package.json`）

```jsonc
{
  "name": "my-plugin",          // = 插件 id，`[a-z0-9-]`，全局唯一
  "title": "我的插件",
  "version": "0.1.0",
  "type": "module",             // 必须
  "description": "...",
  "author": "...",
  "icon": "assets/icon.png",    // 插件级默认图标
  "apiVersion": "1",            // 协议版本，内核不认识就拒绝加载并提示升级
  "capabilities": ["storage", "clipboard.write", "notify.show"],
  "commands": [
    { "name": "hello",     "title": "打个招呼", "mode": "view", "searchable": true, "placeholder": "输入后回车" },
    { "name": "hello-job", "title": "后台任务", "mode": "no-view" },
    { "name": "read-file", "title": "读取文件", "mode": "script" }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 插件 id；也用于数据目录名 |
| `title` | ✅ | 展示名 |
| `version` | ✅ | semver |
| `apiVersion` | ✅ | M1 固定 `"1"` |
| `capabilities` | ✅ | 可为空数组（= 纯前端插件，只能用自己的 UI + `ctx.commands`） |
| `commands[]` | ✅ | 至少 1 条 |
| `icon` | ❌ | 相对路径 |
| `platforms` / `arch` | ❌ | 支持的操作系统 / CPU 架构白名单（**省略 = 不限制**）；见 plugin-spec §3.5。内核在**扫描期**过滤，不匹配的插件整包跳过（不注册命令、不进设置页）；安装时直接报 `PLATFORM_MISMATCH` |

### 8.3 命令声明

```ts
interface CommandDecl {
  name: string           // 唯一；等于脚本产物文件名
  title: string
  subtitle?: string
  icon?: string          // lucide 图标名 / data URL / 插件内相对路径
  mode: 'view' | 'no-view' | 'script'
  searchable?: boolean   // 默认 false；true 时参与全局搜索并展示 placeholder
  placeholder?: string
  keywords?: string[]    // 别名/拼音（提高命中率）
  capabilities?: string[]// 覆盖插件级声明（更细粒度）
  /** searchable 为 true 时，插件要处理这个事件来提供结果 */
  onQuery?: boolean
}
```

### 8.4 会话与 URL 契约

```
http://127.0.0.1:<port>/index.html?sid=<uuid>&cmd=<command>&theme=dark|light&token=<perSessionToken>
```
- 每次打开 view 命令 = 一个新会话（同插件复用同一 listener/端口，`sid` 区分）
- 退出：footer 最左「返回」/ `Esc` / `⌘W` 三条路径统一由宿主收口（回到搜索态）。插件页是独立文档，宿主收不到焦点在 iframe 里的按键 ⇒ `@launcher/api` 在插件侧兜底：**没有被插件消费**的 `Esc` 自动交还宿主（等价 `ctx.commands.close`）；插件消费 Esc（关自己的弹层 / 清空搜索）必须 `preventDefault()`
- 只绑 `127.0.0.1`（**不要 0.0.0.0**，避免 macOS 防火墙弹窗）
- 静态服务只暴露插件目录，禁止目录穿越；响应头带 CSP：`default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https:; frame-src 'none'`（`'wasm-unsafe-eval'` 只放行随包 wasm 的编译，不放行 JS 的 `eval`）

### 8.5 桥协议（postMessage）

**插件 → 宿主**
```ts
window.parent.postMessage({ __launcher: 1, token, id, method, params }, '*')
// method: 'ctx.storage.get' | 'ctx.hostUi.setSearchContent' | 'ctx.exec.run' | ...
```
**宿主 → 插件**
```ts
{ __launcher: 1, id, ok: true, result }          // 应答
{ __launcher: 1, event: 'search/query', payload } // 事件推送（无 id）
```
**校验**：token 必须匹配该会话；`event.origin` 必须等于该插件端口；`event.source` 必须是该 iframe 的 contentWindow。任一不符 → 丢弃 + 审计。

### 8.6 宿主 API 全表（UI 侧）

| 方法 | capability | 参数 | 返回 |
|---|---|---|---|
| `ctx.commands.invoke` | — | `{ command, args? }` | `ActionResult` |
| `ctx.commands.close` | — | — | `void`（关闭插件会话） |
| `ctx.searchResult.set` | — | `{ items: ResultItem[] }` | `void` |
| `ctx.storage.get` | `storage` | `{ key }` | `unknown \| undefined` |
| `ctx.storage.set` | `storage` | `{ key, value }` | `void` |
| `ctx.storage.remove` | `storage` | `{ key }` | `void` |
| `ctx.storage.all` | `storage` | — | `Record<string, unknown>` |
| `ctx.storage.clear` | `storage` | — | `void` |
| `ctx.hostUi.getSearchContent` | `hostUi` | — | `string` |
| `ctx.hostUi.setSearchContent` | `hostUi` | `{ value }` | `boolean` |
| `ctx.hostUi.clearSearchContent` | `hostUi` | — | `boolean` |
| `ctx.hostUi.setFooter` | `hostUi` | `{ buttons }` | `boolean` |
| `ctx.hostUi.hide` | `hostUi` | — | `void` |
| `ctx.clipboard.readText` | `clipboard.read` | — | `string` |
| `ctx.clipboard.writeText` | `clipboard.write` | `{ text }` | `void` |
| `ctx.shell.openUrl` | `shell.open` | `{ url }` | `void` |
| `ctx.shell.openPath` | `shell.open` | `{ path }` | `void` |
| `ctx.shell.reveal` | `shell.open` | `{ path }` | `void` |
| `ctx.exec.run` | `exec.spawn` | `{ command, args?, timeoutMs? }` | `unknown`（= 脚本 `done(x)` 的 x） |
| `ctx.notify.show` | `notify.show` | `{ title, body }` | `boolean` |
| `ctx.screenshot.start` | `screenshot` | — | `boolean` |
| `ctx.quicklink.all/add/edit/remove` | `quicklink` | 见 §8.8 | — |
| `ctx.host.info` | — | — | `{ version, platform, dataRoot, pluginId, command, sid }` |
| `ctx.log` | — | `{ level, message, data? }` | `void` |

错误统一为 `{ code, message }`：`CAPABILITY_DENIED` / `NOT_FOUND` / `TIMEOUT` / `BAD_ARGS` / `INTERNAL`。

### 8.7 插件运行时 API（逻辑层：`no-view` / `script`）

> **2026-09-17 更新（M5）**：逻辑层载体从 Node `worker_threads`（v1，`@launcher/api-node` + `.mjs`）改为**独立子进程 + NDJSON over stdio**（v2，Rust SDK `launcher-plugin-sdk`）。API 形状与消息语义逐条对齐 v1；完整协议（上下文注入 / 双向消息表 / 生命周期与超时降级 / v1→v2 迁移）见 `docs/plugin-spec.md` §4.4。

```rust
// Rust SDK（v2）：与 v1 的 ctx / log / progress / done / fail / onError / onQuery / storage 一一对应
fn main() {
    launcher_plugin_sdk::run(|ctx| {
        let args = ctx.args::<MyArgs>()?;
        ctx.log("开始", json!({ "foo": 1 }), Level::Info);
        ctx.progress(0.4, json!({ "step": "halfway" }));
        ctx.done(json!({ "ok": true }))?;      // 正常结束，返回值交给 ctx.exec.run
        Ok(())
    });
}
```
消息协议（NDJSON）：插件 → 宿主 `{type:'log'|'progress'|'result'|'done'|'rpc'}`；宿主 → 插件 `{type:'query'|'rpc-result'|'shutdown'}`。

### 8.8 ResultItem 与 ActionDecl

```ts
interface ResultItem {
  id: string                 // 插件内唯一且稳定（如 `app:/Applications/Safari.app`）
  title: string
  subtitle?: string
  icon?: string
  score?: number             // 0..1，插件自评（可选）
  action: ActionDecl         // 默认动作
  actions?: ActionDecl[]     // 右键菜单追加项
  detail?: string            // 二级面板内容（纯文本/Markdown 子集；v1 只支持纯文本）
}
type ActionDecl =
  | { type: 'command'; command: string; args?: unknown }     // 本插件命令
  | { type: 'invoke'; pluginId: string; command: string; args?: unknown } // 其它插件命令
  | { type: 'open'; target: string; targetKind?: 'url' | 'path' | 'app' }
  | { type: 'copy'; text: string }
  | { type: 'host'; method: 'hostUi.setSearchContent' | 'hostUi.hide' }
```
**注意**：`ResultItem` 里没有"应用"这个概念，只有 `id/title/action`——这是 P3 的体现。

### 8.9 插件开发流程

```bash
# 插件是 pnpm workspace 成员，命令在仓库根执行
pnpm install
pnpm --filter <name> dev                   # 起 vite dev server，并把 dev 地址注册到运行中的内核
pnpm --filter <name> build                 # 产出 dist/（含 index.html + assets + package.json + 各命令的可执行产物）
pnpm build:plugins && pnpm pack:plugins    # 构建全部出厂插件 + 打 zip 供安装
```
- dev 注册：dev server 通过内核的本地 control 端口（仅 127.0.0.1 + 一次性 token）把 `devUrl` 挂上，内核把插件页指向 vite dev server ⇒ **热更新免重启**
- 调试：设置里有"打开插件 DevTools"（macOS WKWebView 用 `isInspectable` + Safari 开发者菜单；开发构建可用）
- 自测：`pnpm test`（含各插件 core·script 用例）+ `pnpm spec-check`（清单 / 产物 / 能力 / 数据目录）+ `tests/fixtures/echo-plugin` 的协议自检
- 新建插件：暂无脚手架包（`packages/plugin-cli` 属待办），照抄 `plugins/totp` / `plugins/host-manager` 最快；配置模板见 `docs/plugin-dev-guide.md` §4

---

## 9. 安全与权限

| 面 | 措施 |
|---|---|
| 能力授权 | 安装时展示 `capabilities` 清单，用户可拒绝（拒绝则该服务不挂载） |
| 网络隔离 | 插件页只能访问自己的 origin + https（CSP `connect-src`）；`http://127.0.0.1:*` 默认禁止（防探测本机服务） |
| 宿主 API 滥用 | 端口随机 + 每会话 token + origin/source 三重校验；未授权方法不存在 |
| 脚本危险面 | `exec` 命令路径**绝不接受调用方入参**（要写系统文件的插件只准认平台默认路径）；提权一律走系统对话框；写前备份、写后回读逐字节校验；提权不可用则落"待生效文件 + 可复制命令"手工路径 |
| 敏感数据 | 存储默认明文（本地 KV）；插件自行加密（提供 `packages/crypto` 参考实现：PBKDF2 + AES-GCM，口令不落盘） |
| 审计 | 全部调用落 jsonl，敏感字段打码 |
| 供应链 | 插件 zip 只解压到目标目录、拒绝绝对路径与 `..`、拒符号链接、单文件 ≤ 50MB |

---

## 10. 性能与约束

| 指标 | 目标 | 手段 |
|---|---|---|
| 冷启动到可唤出 | ≤ 800ms | 壳先起窗口并显示骨架，内核异步就绪；插件懒加载（首次搜索才激活） |
| 输入 → 首屏结果 | ≤ 100ms | 本地拼音索引先出、插件结果异步补位、不闪空白 |
| 单次搜索 | 插件超时 200ms | 超时插件本次丢弃并记审计 |
| 网格渲染 | > 200 条必须虚拟滚动 | `apps/launcher-ui/src/lib/virtual.ts`，按「一排格子」定高 |
| 主线程计算 | > 50ms 的必须进 Worker | 拼音索引构建、历史大文件解析、插件结果合并的排序（> 500 条时） |
| 常驻内存 | ≤ 120MB | 插件会话关闭即销毁 iframe；历史/审计全量不驻内存（按需读页） |
| 历史文件 | ≤ 500 条，写入 debounce | 原子写 |

---

## 11. 测试策略

| 层 | 内容 | 工具 |
|---|---|---|
| 单元 | `history` 排序/淘汰、`search` 去重与合并、清单校验、拼音、token 校验、路径穿越防护 | `scripts/run-ts.mjs`（esbuild → node），无框架 |
| 契约 | `tests/fixtures/echo-plugin` 覆盖 §8.6 全表 API（含错误码与未授权路径） | node + 真 HTTP listener |
| 集成 | 装一个真插件（`json-tools`）→ 搜索 → 执行 → 历史落盘 | node 驱动内核（不起壳） |
| 出厂插件 | `plugins/` 下全部插件加载、命令可见、核心动作可用 | `npm run smoke:first-batch` |
| 冒烟 | 壳 + 内核真实启动：唤出 → 输入 → 选中 → 执行 → 隐藏 | 手动清单 + 截图存证 |
| E2E | 插件页行为用 Playwright 直连 `http://127.0.0.1:<port>`（绕过壳，稳定） | Playwright |

**每个里程碑结束必须跑**：`npm run typecheck && npm run test && npm run build`，然后起真实 `.app` 手动点一遍（生产构建的资源路径与 dev 不同，只测 dev 会漏白屏）。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| WKWebView 的 iframe/postMessage 行为与 Chromium 有差异 | 插件页通信异常 | M1 第一周就用真 WKWebView 验证桥；保留"直连内核 HTTP + fetch"作降级通道 |
| 全局热键被占用 | 唤不出来 | 注册失败立即提示 + 引导设置页改键；托盘兜底 |
| 插件页跨域/端口被占 | 加载失败 | 端口从 0 开始让系统分配（绑定后读回）；listener 起不来则该插件标记 error |
| 内核与插件产物体积（内核 8–15MB + 每个逻辑层插件 1–3MB） | 安装包变大 | 认账；单进程自包含换来「运行时免 Node」与更低的常驻内存 |
| macOS 公证流程卡壳 | 发不出去 | 第 1 周启动 Apple Developer（$99/年）+ CI 签名配置 |
| 拼音/中文搜索质量差 | 搜不到 | 先做全拼 + 首字母两级索引，词库用成熟库，关键词可手配 `keywords` |
| 底座被能力污染（P1 失守） | 内核越做越大，插件化名存实亡 | 每次 PR 检查"内核 diff 里是否出现能力词"；§1.3 验收口径做成自动测试 |

---

## 13. 里程碑与验收

> 进度快照见 `README.md` 的「当前状态」。本节保留**计划口径**（交付物与验收标准），不随实现改动。
> M0–M4 的交付物按当时的实现口径书写（TypeScript 内核）；**M5 起为 Rust 实现**（见 ADR-0005）。

### M0 — 壳 + 启动台 UI（1–1.5 周）
**交付**：`apps/shell`（窗口/热键/托盘）、`apps/launcher-ui`（搜索框 + 结果网格 + 键盘导航 + 固定的假数据）、`history.ts` 落盘。
**验收**：
- 热键唤出/`Esc` 隐藏/失焦隐藏/多屏居中正常，托盘菜单可退出
- 输入过滤假数据、↑↓ 选择、Enter 触发（先只打日志）
- 固定/取消固定能持久化（重启后还在），最近使用按时间倒序

### M1 — 内核 + 插件运行时（3–4 周）
**交付**：`context/registry/pipeline/plugin/audit`、`services/{storage,bridge,hostUi,exec}`、每插件 HTTP listener + token、`packages/plugin-api`、`packages/plugin-manifest`、`echo-plugin`。
**验收**：
- `echo-plugin` 通过 §8.6 全表契约测试（含未授权 → 方法不存在）
- **`json-tools` 零改动跑起来**：搜索到命令 → 打开 → 内部交互 → 存储读写
- 未声明的 capability 调用失败且审计有记录
- 禁用/启用插件不留残留（命令消失又出现，历史项置灰）

### M2 — 脚本运行时 + 第一个官方插件（1–1.5 周）
**交付**：`services/exec.ts`（worker_threads）+ `plugins/app-launcher`（macOS 扫描 + 启动）。
**验收**：
- **`hosts`（现 `host-manager`）跑通**（含提权脚本的确认提示）
- `app-launcher` 能搜到 `/Applications` 下的应用并启动；历史里能出现"最近启动的应用"
- 脚本超时/异常不拖垮内核

### M3 — 补齐搜索与官方插件（1–1.5 周）
**交付**：`file-search`、`web-open`、`internal-settings`（设置 + 插件管理 + 安装/卸载 zip）、拼音索引。
**验收**：
- 从 zip 装一个第三方插件；卸载后其命令与结果消失、历史项置灰
- 拼音全拼/首字母能搜到中文标题命令
- 搜索结果 20 条以内首屏 < 100ms（1 万条历史量级下）

### M4 — 分发（2–3 周）
**交付**：打包、签名、公证、`tauri-plugin-updater` + minisign、CI（macOS arm64 + x64）、`docs/plugin-spec.md`。
**验收**：另一台机器下载 `.dmg` 安装 → 首次启动不报安全警告 → 装插件 → 自动更新到下一版。

### M5 — Rust 内核（2–3 周，2026-09-17 立项）
**交付**：`ADR-0005`（内核语言决策）、`packages/plugin-sdk-rs`（Rust 插件 SDK）、`apps/kernel`（bin `launcher-kernel`）、5 个出厂插件的逻辑层 Rust 化、构建与打包链路改造（免 Node）。
**验收**：
- `echo` fixture 在 v1 / v2 宿主上输出逐字段一致（协议一致性测试，作为全程回归门）
- UI 与插件视图**零改动**（28 个 HTTP 端点 + 12 个 SSE 事件清单不变），搜索 / 启动 / 插件页全部可用
- 从 PATH 移除 `node` 后全流程可用；`builtin-plugins/*/dist/` 内既无 `.mjs` 也无 `node_modules`
- 现网数据副本对拍：历史 / 固定 / 设置 / 别名 / 禁用状态逐项一致（无 schema 变化）
- `pnpm app:local` 出包并换包日常使用；常驻内存（壳 + 内核 + 常驻插件子进程）≤ 150MB

### M6 — Windows 平台（3–5 周，M5 之后）
**交付**：壳平台分支（热键默认值与回退链 / 彩色托盘图 / UIA 选中文本 / `app.usage` / 数据目录统一）、`app-launcher` 与 `file-search` 的 Windows 后端、`scripts/pack-win.mjs` + NSIS 安装包 + 便携版、README 安装说明、GitHub Actions 双平台构建与 Releases 分发。
**验收**（Windows 10/11 实机）：
- 双击安装 / 解压即用；首次运行无 Node 依赖报错；热键唤出、搜索（应用 / 文件 / 网页）、启动应用、选中文本带入
- hosts 插件 UAC 提权读写、区外字节不动；托盘 / 状态条 / 设置生效；退出无残留进程
- 交付给使用 Windows 的同事日常使用

**进度（2026-09-18）**：上述交付物**代码已全部落地**（逐项状态见 `docs/m5-rust-and-windows.md` §B0），
内核 / SDK / 各插件与壳均已通过 Windows 目标的交叉检查（`cargo check --target x86_64-pc-windows-msvc`）；
`build-windows.yml` 负责真机编译 / 测试 / 打包。**尚未做的**：UWP 应用扫描、文件预览增量、`release.yml`；
`clipboard-history` 已落地（含壳 `clipboard.watch` 与内核新 capability），**待 Windows 实机验收**。
文件搜索在 Windows 上**优先复用用户已装的 Everything**（按官方 IPC 协议实现，不随包分发任何第三方二进制；
探不到则回退自建索引，带目录变化增量）。
当前平台差异（对外可见的部分）：热键默认 `Ctrl+Shift+Space`（`Alt+Space` 是系统窗口菜单键）；
选中文本走 UI Automation（**无需授权**，只支持实现了 TextPattern 的控件）；
区域截图唤起系统截图（`ms-screenclip:`）；数据目录 `%APPDATA%\Chassis`。

---

## 14. 待拍板项（已给默认值，未反对即按默认执行）

| # | 问题 | 默认取值 |
|---|---|---|
| 1 | 代码放哪 | **单仓库**（本仓库）：底座 + 出厂插件 + 插件 SDK（`packages/*`）一起维护；需求源就是 `docs/launcher-requirements.md` |
| 2 | 是否兼容第三方旧协议 | **否**（2026-09-16 起）：底座只认原生协议 `@launcher/api` |
| 3 | 存储后端 | **JSON 文件 + 原子写**；历史 > 2000 条再评估 SQLite |
| 4 | 平台 | **macOS（arm64）+ Windows 10/11**（2026-09-17 更新）。Windows 由「M4 之后单独立项」提升为 **M6**（动机：分享给使用 Windows 的同事）；两端均在各自平台上原生构建 |
| 5 | 运行时依赖 | **2026-09-17 更新：不内嵌 Node，且 M5 起不再需要 Node**（内核与逻辑层插件 Rust 化）。开发期依赖系统 Node ≥ 22 只是过渡态；交付物（macOS 换包 / Windows 安装包）不含 Node |
| 6 | UI 框架 | **Vue 3 + Vite + Pinia + Tailwind v4**（与现有插件资产一致，可直接复用组件与设计令牌） |
| 7 | 默认热键 | macOS `⌥Space`；**Windows `Ctrl+Shift+Space`**（`Alt+Space` 是系统窗口菜单键，永远抢不到） |
| 8 | 插件数据目录 | `<dataRoot>/plugins/<pluginId>/`，`dataRoot` = macOS `~/Library/Application Support/<AppName>` / **Windows `%APPDATA%\<AppName>`** |
