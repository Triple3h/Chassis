# Launcher

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS 11+](https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey.svg)
![Rust: stable](https://img.shields.io/badge/rust-stable-dea584.svg)

一个 **ZTools 形态的 macOS 启动台**：全局热键唤出、输入即搜，结果以图标网格呈现，支持「最近使用」与「已固定」。

它的底座是**零能力**的 —— 内核里不出现任何具体能力（扫描应用、读文件、连网…）。所有能力，包括"启动应用"本身，都以插件形式集成，**出厂插件与第三方插件走同一套机制**。

## 特性

- **唤出** —— 默认热键 `⌥Space`（被占用会自动回退并提示实际生效的键）；托盘左键唤出 / 隐藏；单实例；失焦或 `Esc` 隐藏。
- **搜索** —— 拼音 / 首字母 / 模糊匹配，多插件结果合并后按「匹配 + 最近使用 + 频率」打分；已固定与最近使用可参与搜索。
- **图标网格** —— 分区（已固定 / 最近使用 / 最佳匹配）可折叠，列数按窗口宽度计算；键盘全网格导航、动作菜单、二级面板、固定项拖拽重排。
- **开箱可用** —— 应用启动、Spotlight 文件搜索、网址直达、TOTP、Hosts 块管家、文本比对、JSON 工具箱、设置与插件管理。
- **可扩展** —— 插件 = 一个目录（`package.json` 清单 + 可选 iframe 页面 + 可选逻辑层可执行产物）；从文件夹或 zip 安装，用到的能力必须在清单里声明。
- **可审计** —— 插件 → 宿主的每次调用走统一入口并落本地审计日志；未声明的 capability 在装配期就不挂载。

## 设计原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | **底座零能力** | 内核只提供运行时；一旦出现「应用 / 文件 / 网址」这类概念，就说明有东西该做成插件 |
| P2 | **出厂自带 ≠ 内核内嵌** | 官方插件同样是普通插件，可禁用、可卸载（仅 `internal-*` 管理面例外） |
| P3 | **能力即权限** | 未声明的 capability 在装配期就不挂载，插件侧表现为「方法不存在」 |

验收口径（贯穿全程）：

> **清空所有插件目录后，应用仍能启动、能唤出、能搜索（结果为空）、能显示空的「最近使用／已固定」、能安装插件。**

## 环境要求

| | 版本 | 说明 |
|---|---|---|
| macOS | 11+ | 目前只支持 macOS |
| Rust | stable | 内核（`apps/kernel`）+ 壳 + 逻辑层插件都要编译 |
| Node.js | ≥ 22 | **仅开发期**（pnpm / Vite 工具链、测试运行器）；`.app` 运行时零 Node |
| pnpm | 10 | 工作区管理器（`pnpm@10.33.0`） |

## 安装

目前只支持从源码构建（发布链路未做）：

```bash
pnpm install
pnpm build        # 内核 + 启动台 UI + 8 个出厂插件
pnpm app:local    # release 编译 + 组装 + ad-hoc 签名 → dist-app/Chassis.app
```

把 `dist-app/Chassis.app` 拖进 `/Applications` 双击即可。

### 会弹哪些系统权限（各自对应什么功能）

| 系统设置里的名字 | 谁在用 | 不给会怎样 |
|---|---|---|
| **辅助功能** | 壳 `primitives/selection.rs`：唤出时读前台选中的文本 | 唤出不带选区，其余照常（可随时在系统设置里补授权） |
| **屏幕录制** | 内核 `services/primitives.rs` 调 `screencapture`：`screenshot` 能力（TOTP 扫码的前置） | 截图只有壁纸、扫不出码 |
| **自动化 / Apple 事件**（弹窗文案：「想控制此 Mac 并访问你的数据」） | `host-manager` 的提权写入：`osascript -e 'do shell script … with administrator privileges'` 把托管区写进 hosts | **只有**「写入托管区」这一个动作失败；读、预览与其它插件都不受影响 |
| 通知 | `notify` 能力（操作完成提示） | 少提示，不影响功能 |
| 文件与文件夹（桌面 / 图片等） | TOTP 扫截图目录、文件搜索命中受保护目录 | 对应范围搜不到 |

> **前置说明**：**打开应用 / 文件 / 网址走的是 `/usr/bin/open`（LaunchServices），不需要任何权限** —— 所以「自动化」那条只在真的动 hosts 时才弹，不是启动就弹。
> 打包用的是 **ad-hoc 签名**，而 TCC 授权是**绑代码签名**的：每次重新打包（新二进制、新签名）系统都会当成"第一次"重弹一次；自用场景下这是必然代价。
> 弹窗里只有「拒绝 / 打开系统设置」（没有「允许」）时，说明之前拒绝过或签名已变，去 系统设置 → 隐私与安全性 → 自动化 手动勾上即可。

> **为什么要 ad-hoc 签名**：Apple Silicon 上未签名的可执行文件会被内核直接杀掉（`Killed: 9`），这不是公证问题。
> 打包脚本会自动执行 `codesign --force --deep --sign -`（免费、仅本机有效），自用**不需要** Apple Developer、公证或自动更新；
> 本地构建的 `.app` 不带 quarantine 属性，双击即可运行。
> 内核与逻辑层插件都是**随包内置的二进制**（`resources/kernel/launcher-kernel` + 各插件的 `dist/<命令名>`），运行时不需要本机装 Node 或 Rust。

### 开发模式（不起壳，浏览器里就能用）

```bash
pnpm install
pnpm dev          # 内核（standalone）+ UI（vite dev，HMR）
```

终端会打印入口地址（形如 `http://127.0.0.1:3333/?kernel=http://127.0.0.1:<内核端口>`）。也可以只起一半：

```bash
pnpm dev:kernel   # 只起内核（API 在打印出的 /api，UI 托管构建产物）
pnpm dev:ui       # 只起 UI（vite dev server，3333）
pnpm shell:dev    # 跑真壳（需要 Rust 工具链；cargo run / tauri dev）
```

开发态数据落在仓库根的 `.dev-data/`，不碰真实用户数据。

## 使用

| 操作 | 说明 |
|---|---|
| `⌥Space` | 唤出 / 隐藏（可在设置里改） |
| `↑` `↓` `←` `→` / `Tab` | 网格导航（跨分区连续） |
| `Enter` / `⌘Enter` | 执行默认动作 / 第二动作 |
| `⌘K` | 动作菜单：固定、复制标题、移出最近使用、打开插件目录、禁用或卸载插件 |
| `⌘I` | 展开 / 收起二级面板 |
| `⌘,` | 打开设置 |
| `Esc` | 分步退出：收起二级面板 → 清空输入 → 隐藏窗口 |

| 数据位置 | 说明 |
|---|---|
| `~/Library/Application Support/Chassis/` | 数据目录（`LAUNCHER_DATA_ROOT` 可覆盖；从旧目录 `Launcher/` 自动接手一次） |
| `.../logs/shell.log` | 壳与内核日志（内核日志走 stderr，由壳转发落盘），排障先看这里 |
| `.../extensions/<id>/` | 已安装的插件 |
| `.../plugins/<id>/` | 插件数据目录（插件的唯一可写处） |

## 插件

出厂 8 个，预装、可禁用、可卸载；产物形态与第三方插件完全一致。

| 插件 | 命令 | 工具链 |
|---|---|---|
| `app-launcher` | `search`（script，贡献型）+ `refresh`（no-view） | esbuild |
| `file-search` | `search`（script，贡献型） | esbuild |
| `web-open` | `web`（script，贡献型） | esbuild |
| `internal-settings` | `settings` + `manage`（view） | esbuild |
| `totp` | `totp`（view）+ `read-image`（script） | Vite + Vue |
| `host-manager` | `hosts`（view）+ `hosts-read` / `hosts-write`（script） | Vite + Vue |
| `text-diff` | `diff`（view） | Vite + Vue |
| `json-tools` | `json`（view） | Vite + Vue |

写自己的插件：

| 文档 | 内容 |
|---|---|
| [`docs/plugin-spec.md`](docs/plugin-spec.md) | **插件接入规范 v2** —— 清单、命令形态、宿主 API、能力、检查清单（唯一必读） |
| [`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md) | Vue 插件开发手册：工程搭建、构建管线、脚本协议、踩坑复盘 |
| [`plugins/README.md`](plugins/README.md) | 出厂插件：两套工具链、目录约定、构建 / 自检 / 发布 |

## 架构

```
┌ 壳（Rust / Tauri 2）   窗口 · 热键 · 托盘 · 单实例 · 通知 · 剪贴板 · 打开   ← 只有系统原语
├ 内核（Rust）           插件运行时 · 服务总线 · 注册表 · 搜索 · 历史 · 审计
├ 启动台 UI（Vue 3）     搜索框 · 图标网格 · 键盘导航 · 动作菜单
└ 插件                   view = iframe 页面（每插件独立端口 ⇒ 独立 origin）；no-view / script = 独立子进程
```

- 壳 ↔ 内核：`stdio` + newline JSON-RPC 2.0（协议只走 stdout/stdin，日志一律 stderr）
- 内核 ↔ UI：HTTP `/api/*` + SSE `/api/events`（见 [ADR-0001](docs/decisions/ADR-0001-ui-hosting.md)）
- 每插件独立 HTTP listener `listen(0, '127.0.0.1')` ⇒ 独立 origin ⇒ 插件的 localStorage / IndexedDB 天然隔离
- 实现细节、与需求的差异清单与已知边界：[`docs/architecture.md`](docs/architecture.md)

### 目录结构

```
apps/
  shell/            Rust / Tauri 2：窗口、热键、托盘、单实例、通知、剪贴板、open
    src/{main,lib,ipc,sidecar,logging}.rs + src/primitives/{window,hotkey,tray,notify,clipboard,opener}.rs
    ui-stub/        冷启动骨架页（内核就绪前显示，崩溃时变错误面板）
  launcher-ui/      Vue 3 + Vite + Tailwind v4：搜索框、图标网格（分区折叠 / 虚拟滚动）、
                    键盘导航、动作菜单、二级面板
  kernel/           Rust 内核（bin: launcher-kernel）：插件运行时 + 服务总线 + 注册表 + 搜索 +
                    历史 + 审计 + HTTP/SSE + 壳协议（src/{kernel,api,link,search,history,audit,config,
                    session,exec/*,plugin/*,services/*,http/*}.rs）
packages/
  plugin-manifest/  清单类型 + 校验 + 契约类型（内核 / UI / SDK 共用）
  plugin-api/       @launcher/api —— 插件页 SDK
  plugin-sdk-rs/    launcher-plugin-sdk —— 逻辑层 Rust SDK（ctx / done / fail / log / progress / on_query）
  ui/               @launcher/ui —— 插件 UI 套件（设计令牌 + AppShell / UiIcon / UiDialog
                    + virtual / clipboard / keys / theme / toast），构建期打进插件产物
plugins/            8 个出厂插件（见上表；view 是 Vite + Vue，逻辑层是 Rust 可执行产物）
tests/
  fixtures/echo-plugin/  契约测试插件（Rust 版本，逻辑层 = SDK 的 echo 示例二进制）
  unit/ contract/ smoke/ 单元 / 契约 / 验收（harness 直接拉起真内核二进制）
scripts/            构建 / 测试 / 打包 / 自检 / 开发脚本（lib/ 为构建期工具）
docs/               需求、规范、架构、手册、ADR、第三方许可
```

## 文档

**写插件**（对外契约）：[`plugin-spec.md`](docs/plugin-spec.md) ｜ [`plugin-dev-guide.md`](docs/plugin-dev-guide.md) ｜ [`plugins/README.md`](plugins/README.md)

**改底座**（内部设计）

| 文档 | 内容 |
|---|---|
| [`docs/launcher-requirements.md`](docs/launcher-requirements.md) | **唯一需求源**：产品定义、行为规格、里程碑（计划口径） |
| [`docs/architecture.md`](docs/architecture.md) | 内核实现细节 + 与需求的差异清单 + 已知边界 + 测试与验收 |
| [`AGENTS.md`](AGENTS.md) | 仓库指南（给 AI 与新贡献者）：结构、命令、风格、提交规范 |

**历史与合规**：[`docs/decisions/`](docs/decisions)（ADR-0001~0004）｜ [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) ｜ [`LICENSE`](LICENSE)

## 当前状态

自用可用：热键唤出、搜索、应用启动、文件搜索、网址直达、TOTP / hosts / 文本比对 / JSON 工具、插件管理与安装都已在实机跑通。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 壳（窗口 / 热键 / 托盘）+ 启动台 UI + 历史落盘 | ✅ 自用版实机在用 |
| M1 | 内核 + 插件运行时（context / registry / pipeline / plugin / audit + 每插件 HTTP + 桥） | ✅ 契约测试覆盖宿主 API 全表 |
| M2 | 脚本运行时（worker_threads）+ `app-launcher` | ✅ 含 ZTools 扫描逻辑移植 |
| M3 | `file-search` / `web-open` / `internal-settings` + 拼音索引 | ✅ |
| M4 | 打包 / 签名 / 公证 / 自动更新 / CI | 🔸 只做自用版（`pnpm app:local`）；分发链路按需再补 |

质量门（当前全绿）：`pnpm typecheck` 15 个工作区包 ｜ `pnpm test` 17 个测试文件 ｜ `pnpm spec-check` 8 个出厂插件 0 不合规 ｜ `pnpm smoke:real` / `pnpm smoke:first-batch`。

**未做**（按需再补）：分发链路（公证 / 自动更新 / CI / dmg）、Windows 支持、插件脚手架 CLI、Playwright E2E、zip 安装的自动化测试。

## 开发与贡献

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | 全部工作区包类型检查（Vue 插件自动改用各自的 `vue-tsc`） |
| `pnpm test` | 全部测试；也可 `test:unit` / `test:contract` / `smoke` |
| `pnpm build` | `build:kernel` + `build:ui` + `build:plugins`（也可单独跑） |
| `pnpm spec-check` | 出厂插件规范自检（清单 / 能力 / 产物 / 远程资源） |
| `pnpm smoke:real` | 真内核 + 出厂插件冒烟（不起壳） |
| `pnpm smoke:first-batch` | 四个 Vue 插件的端到端（HTTP 驱动，不起壳） |
| `pnpm dev` / `dev:kernel` / `dev:ui` | 开发模式（见上） |
| `pnpm app:local` | 自用打包 → `dist-app/Chassis.app` |
| `pnpm pack:plugins` | 把 8 个插件打成 zip → `plugins/release/` |
| `pnpm icon` | 由 `apps/shell/icons/*.svg` 生成位图（需 `brew install librsvg`） |

约定：

1. **底座零能力**：提交前自查 `apps/kernel` 的 diff 里有没有出现能力词（应用、文件、网址…）。出现即说明有东西该做成插件。
2. **规范先行**：需求 / 规范没写的行为，先改 `docs/`（或提 ADR）再写代码；槽位、字段、章节有变动必须同步文档。
3. **注册即可逆**：任何注册都要能回滚，插件停用 / 重载 / 卸载后不留残渣（`tests/contract` 有覆盖）。
4. **跨进程的同一件事只有一个裁决者**：例：窗口显隐只由壳决定，内核只广播状态；两边都做 = 一次热键 toggle 两遍。
5. **改完必跑**：`pnpm typecheck && pnpm test && pnpm build`（插件改动再加 `pnpm spec-check`），然后起**打包产物**手动点一遍 —— 生产资源路径与 dev server 不同，只测 dev 会漏白屏。

提交信息用 Conventional Commits + 中文主题，例如 `feat: 启动台结果改为图标网格`；PR 里写明跑过的命令，UI 改动附截图。

## 致谢

- [ZTools](https://github.com/ZToolsCenter/ZTools)（MIT）—— 应用扫描与本地化名称解析逻辑的移植来源，部分工具函数（`pLimit`、路径校验）亦取自其实现；结果网格是照其聚合视图行为语义重写的原创实现。
- 依赖选型对齐 ZTools：`pinyin-pro`、`chokidar`、`adm-zip`。

完整的第三方代码与许可清单见 [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)。

## 许可证

[MIT](LICENSE)
