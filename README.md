# Chassis

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS 11+](https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey.svg)
![Rust: stable](https://img.shields.io/badge/rust-stable-dea584.svg)
![Plugin API: v2](https://img.shields.io/badge/plugin%20api-v2-7c3aed.svg)

**一个插件化的 macOS 启动台**：全局热键唤出，输入即搜，结果以图标网格呈现，支持「最近使用」与「已固定」。

底座采用**零能力内核**设计：内核只提供插件运行时、搜索调度与协议，**不包含任何具体能力** —— 扫描应用、读写文件、打开网址、算验证码，全部由插件实现。**出厂插件与第三方插件走完全相同的机制**，可禁用、可卸载。壳、内核与逻辑层插件全部用 Rust 编写，应用运行时**不依赖 Node**。

## 项目简介

启动台类工具一旦把「应用扫描」「文件搜索」这类能力直接做进内核，就回不了头：加一个能力改一次内核，官方能力天然比第三方特权，安全边界只能靠运行时判断。Chassis 的选择是把边界一条条钉死，其中最核心的三条：

| # | 铁律 | 含义 |
|---|---|---|
| 1 | **底座零能力** | 内核里不出现任何具体能力（应用 / 文件 / 网址 / 网络…）；一旦出现，就说明有东西该做成插件 |
| 2 | **出厂自带 ≠ 内核内嵌** | 官方插件走同一套插件机制，可禁用、可卸载（仅 `internal-*` 管理面例外） |
| 3 | **能力即权限** | 未在清单声明的 capability，装配期就不挂载；插件侧表现为「方法不存在」，而非运行时被拒绝 |

完整的 P1–P7 原则（含「注册即可逆」「一切跨进程调用可审计」「数据与代码分离」）见 [`docs/launcher-requirements.md`](docs/launcher-requirements.md) §1.2。

验收口径（贯穿整个项目）：

> **清空所有插件目录后，应用仍能启动、能唤出、能搜索（结果为空）、能显示空的「最近使用／已固定」、能安装插件。**

## 核心特性

- **唤出** —— 默认热键 `⌥Space`（被占用自动回退并提示实际生效的键）；托盘左键唤出 / 隐藏；单实例；失焦或 `Esc` 隐藏；唤出时自动带入前台选中的文本。
- **搜索** —— 拼音（全拼 / 首字母 / 多音字变体）、前缀与模糊匹配；多插件结果合并后按「匹配 + 最近使用 + 频率」打分；已固定与最近使用参与搜索；输入算式（如 `10+22`）会直接给出结果，回车打开计算稿纸接着算。
- **图标网格** —— 分区（已固定 / 最近使用 / 最佳匹配）可折叠，列数按窗口宽度计算；键盘全网格导航、动作菜单、二级面板、固定项拖拽重排；超过 200 条自动虚拟滚动。
- **开箱可用** —— 17 个出厂插件：应用启动、文件搜索、网址直达、聚合翻译、TOTP 验证码、Hosts 管家、进程管理器、文本比对、JSON 工具箱、备忘快贴、计算稿纸、Markdown 笔记、ToDo 待办、录屏助手（macOS）、剪贴板历史（Windows）、插件更新、设置与插件管理。清单与工具链见 [`plugins/README.md`](plugins/README.md)。
- **可扩展** —— 插件 = 一个目录：`package.json` 清单 + 可选 iframe 页面（`view`）+ 可选逻辑层可执行产物（`no-view` / `script`）；支持目录 / zip 安装（zip 也可直接拖进窗口），用到的能力必须在清单里声明。
- **可审计** —— 未声明的 capability 在装配期就不挂载；插件 → 宿主的每次调用都过统一入口并落本地审计日志。
- **轻量且离线** —— Rust 内核实测常驻约 14 MB；运行时不需要本机装 Node 或 Rust；数据全部保存在本机（底座自身不联网）。

## 架构

```
┌ 壳（Rust / Tauri 2）   窗口 · 热键 · 托盘 · 单实例 · 通知 · 剪贴板 · 打开   ← 只有系统原语
├ 内核（Rust）           插件运行时 · 服务总线 · 注册表 · 搜索 · 历史 · 审计
├ 启动台 UI（Vue 3）     搜索框 · 图标网格 · 键盘导航 · 动作菜单
└ 插件                   view = iframe 页面（每插件独立端口 ⇒ 独立 origin）；no-view / script = 独立子进程
```

四条通信链路、三种命令形态（`view` / `no-view` / `script`）与模块落位见 [`docs/architecture.md`](docs/architecture.md)；设计决策见 [`docs/decisions/`](docs/decisions)（ADR-0001~0006）。

## 安装与构建

### 环境要求

| | 版本 | 说明 |
|---|---|---|
| 系统 | macOS 11+ / Windows 10+ | 两端都在各自平台上**原生构建**（Windows 走 CI，见 `.github/workflows/build-windows.yml`） |
| Rust | stable | 壳、内核、逻辑层插件都要编译 |
| Node.js | ≥ 22 | **仅开发期**（pnpm / Vite 工具链、测试运行器）；打包产物运行时零 Node |
| pnpm | 10 | 工作区管理器（`pnpm@10.33.0`） |

### 从源码构建

```bash
pnpm install
pnpm build        # 内核 + 启动台 UI + 全部出厂插件
pnpm app:local    # macOS：release 编译 + 组装 + 代码签名 → dist-app/Chassis.app
pnpm app:win      # Windows：release 编译 + 组装绿色版 → dist-app/Chassis-<version>-win-x64.zip
```

macOS：把 `dist-app/Chassis.app` 拖进 `/Applications` 双击即可。
Windows：解压 zip 后双击 `Chassis.exe`（首次运行有 SmartScreen 提示，点「更多信息 → 仍要运行」）。

> **为什么会弹系统授权、为什么要签名、怎么让它少弹**（host-manager 免授权写入 / TCC 排障 / 未公证的 quarantine / Windows 对照）
> 全部在 [`docs/permissions.md`](docs/permissions.md)。

> **Windows 的文件搜索**：如果你装了 [Everything](https://www.voidtools.com/)，启动台会**直接复用它**
> 已经建好的全盘索引（无需任何配置；只读取，不改动、也不随包分发它的任何二进制）；
> 没装则用内置索引（首次运行在后台建库，建好之前只返回空结果）。

### 开发模式（不起壳，浏览器里就能用）

```bash
pnpm install
pnpm dev          # 内核（standalone）+ UI（vite dev，HMR）
```

终端会打印入口地址（形如 `http://127.0.0.1:3333/?kernel=http://127.0.0.1:<内核端口>`）。也可以只起一半：`pnpm dev:kernel` / `pnpm dev:ui` / `pnpm shell:dev`（跑真壳，需要 Rust 工具链）。开发态数据落在仓库根的 `.dev-data/`，不碰真实用户数据。

## 使用说明

| 操作 | 说明 |
|---|---|
| `⌥Space`（Windows：`Ctrl+Shift+Space`） | 唤出 / 隐藏（可在设置里改） |
| `↑` `↓` `←` `→` / `Tab` | 网格导航（跨分区连续） |
| `Enter` / `⌘Enter` | 执行默认动作 / 第二动作 |
| `⌘K` | 动作菜单：固定、复制标题、移出最近使用、打开插件目录、禁用或卸载插件 |
| `⌘I` | 展开 / 收起二级面板 |
| `⌘,` | 打开设置 |
| `Esc` | 分步退出：收起二级面板 → 清空输入 → 隐藏窗口 |

数据目录：macOS `~/Library/Application Support/Chassis/`、Windows `%APPDATA%\Chassis\`（`LAUNCHER_DATA_ROOT` 可覆盖；macOS 上会从旧目录 `Launcher/` 自动接手一次）。排障先看 `logs/shell.log`（壳日志 + 内核 stderr 转发）与 `logs/kernel.log`；完整的目录布局（插件数据 / 审计 / 日志导出 / 内核外置副本）见 [`docs/architecture.md`](docs/architecture.md) §7。

### 更新

搜「更新」（或设置 → 插件）打开更新页：**插件**、**内核**与**应用**各自独立检查、下载、更新，sha256 逐字节校验，失败自动回滚，也可手动「恢复出厂版本」。

- **插件**：除 3 个底座基础能力（`app-launcher` / `file-search` / `internal-settings`）外的出厂插件都可被覆盖更新；来源是固定 tag `plugins-latest` 的 GitHub Release，不接受自定义源。契约与发版流程见 [`docs/plugin-spec.md`](docs/plugin-spec.md) §6.4 与附录 C。
- **内核**：固定 tag `kernel-latest`，内核 + UI 同包更新、优雅重启；打包版内核以数据目录外置副本运行，不触碰 App 的代码签名。机制与边界见 [`docs/kernel-hot-update.md`](docs/kernel-hot-update.md)。
- **应用（壳）**：固定 tag `app-latest`，整包替换——**自动检查并提示新版本：托盘常驻「检查更新…」（有新版带版本号，点击打开更新页）与「关于」页更新卡片，由你决定何时更新**；候选包先跑 `--hot-probe` 自检，连续两次启动未就绪自动回滚。**macOS 与 Windows 都支持自动替换**（macOS 换 `.app`、Windows 换绿色版目录，都由独立 helper 在进程完全退出后执行；装到只读位置时标「手动更新」）。机制与签名前提见 [`docs/shell-hot-update.md`](docs/shell-hot-update.md)。
- **资产保留**：三个固定 tag 的 Release 在发布收尾**只保留索引指向的最新包**（CI 自动清理旧版本 zip），不会越积越多——历史版本包请从 `v*` 的正式 Release 获取。

## 写插件

一个 `view` 插件就是一个静态目录加一份清单（没有编译步骤）；需要读写文件、调系统命令的用 `no-view` / `script`（Rust 可执行产物，走 [`packages/plugin-sdk-rs`](packages/plugin-sdk-rs)）。

- 动手：`pnpm create:plugin <id> [--mode view|script|full]` 生成工程骨架（清单 / Vite / Cargo / bin 一次到位，含逻辑层自动登记 Cargo members；见 [`packages/plugin-cli`](packages/plugin-cli)）

- 最小示例（附录 A 是可运行的最小插件）、清单字段、宿主 API、能力表与错误语义：[`docs/plugin-spec.md`](docs/plugin-spec.md)
- 工程搭建、构建、Rust 逻辑层与踩坑复盘：[`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md)
- 出厂插件（也是最好的范例）：[`plugins/README.md`](plugins/README.md)

在设置页安装（支持 zip 与目录路径，zip 也可直接拖进启动台窗口），或把目录放进 `<dataRoot>/extensions/hello/`；输入命令名即可搜到。

## 目录结构

```
apps/
  shell/            Rust / Tauri 2 壳：窗口、热键、托盘、单实例、通知、剪贴板、open（仅系统原语）
  kernel/           Rust 内核（bin: launcher-kernel）：插件运行时 · 服务总线 · 注册表 · 搜索 · 历史 · 审计
  launcher-ui/      Vue 3 启动台 UI：搜索框、图标网格（分区折叠 / 虚拟滚动）、键盘导航、动作菜单
packages/
  plugin-manifest/  清单类型 + 校验 + 契约类型（内核 / UI / SDK 共用）
  plugin-api/       @launcher/api —— 插件页 SDK
  plugin-sdk-rs/    launcher-plugin-sdk —— 逻辑层 Rust SDK
  ui/               @launcher/ui —— 插件 UI 套件（设计令牌 + 组件），构建期打进插件产物
plugins/            17 个出厂插件（视图层 esbuild 或 Vite + Vue，逻辑层是 Rust 可执行产物）→ plugins/README.md
tests/              fixtures/echo-plugin + unit / contract / smoke（harness 直接拉起真内核二进制）
scripts/            构建 / 测试 / 打包 / 自检 / 开发脚本（lib/ 为构建期工具）
docs/               需求、规范、架构、手册、ADR、第三方许可
```

模块级映射与实现细节见 [`docs/architecture.md`](docs/architecture.md) §2；更细的仓库指南（结构与命令、风格、提交规范）见 [`AGENTS.md`](AGENTS.md)。

## 文档

**用 / 装**：[`permissions.md`](docs/permissions.md)（签名与系统权限）｜ [`kernel-hot-update.md`](docs/kernel-hot-update.md)（内核更新）

**写插件**：[`plugin-spec.md`](docs/plugin-spec.md)（对外契约）｜ [`plugin-dev-guide.md`](docs/plugin-dev-guide.md) ｜ [`plugins/README.md`](plugins/README.md)

**改底座**：

| 文档 | 内容 |
|---|---|
| [`docs/launcher-requirements.md`](docs/launcher-requirements.md) | **唯一需求源**：产品定义、行为规格、里程碑（计划口径） |
| [`docs/architecture.md`](docs/architecture.md) | 内核实现细节 + 与需求的差异清单 + 已知边界 + 测试与验收 |
| [`docs/win-hot-update-research.md`](docs/win-hot-update-research.md) | Windows 三层热更新调研（未开工）：可行性预判、文件锁实验清单、风险与决策点 |
| [`AGENTS.md`](AGENTS.md) | 仓库指南（给 AI 与新贡献者）：结构、命令、风格、提交规范 |

**历史与合规**：[`docs/decisions/`](docs/decisions)（ADR-0001~0006）｜ [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) ｜ [`LICENSE`](LICENSE)

## 当前状态

macOS 上自用可用：热键唤出、搜索、应用启动、文件搜索、网址直达、翻译、TOTP / hosts / 文本比对 / JSON 工具、备忘快贴 / 计算稿纸 / Markdown 笔记 / ToDo 待办 / 录屏助手 / 进程管理器、插件管理与安装都已在实机跑通。壳、内核与全部逻辑层插件均为 Rust，打包产物不含 Node。

| 能力 | 状态 |
|---|---|
| macOS 自用版（`pnpm app:local` → `dist-app/Chassis.app`） | ✅ 实机在用 |
| Rust 内核 + Rust 逻辑层插件（apiVersion 2，免 Node） | ✅ |
| 视图层插件（Vue + iframe，独立 origin） | ✅ |
| 插件 / 内核远程更新（`plugins-latest` / `kernel-latest`） | ✅ 通道已发布 |
| Windows 10/11（`pnpm app:win` → 绿色版 zip；CI 原生构建） | 🚧 代码就位，待实机验收（缺口见下） |

质量门（仓库内全绿）：`cargo test --workspace && pnpm typecheck && pnpm test && pnpm build && pnpm spec-check`，另加真内核冒烟 `pnpm smoke:real`。

## 路线图与已知问题

**路线图**

| 项 | 说明 |
|---|---|
| Windows 10/11 收尾 | 实机验收（托盘 / 透明窗口观感 / 通知 / 拖动缩放）、UWP 应用扫描、NSIS 安装包 |
| 分发链路 | 代码签名 / 公证、Windows 自动更新（安装器）、dmg 打包 |
| 更新收尾 | Windows 实机更新正在使用的插件（rename 重试）、更新页自动检查与商店页 |
| 测试补齐 | Playwright E2E、zip 安装的自动化用例、万条历史性能基准 |

**已知问题**

- **逻辑层命令无沙箱**：`no-view` / `script` 产物是独立子进程，拥有当前用户的完整权限（该形态的固有代价）；真正的隔离需要 WASM 或平台沙箱。详见 [`docs/architecture.md`](docs/architecture.md) §9。
- **签名与 TCC 授权**：授权记录绑定代码签名身份，ad-hoc 签名（无证书时的回落）会被每次重新打包当成「第一次」重弹。排障与固定证书方案见 [`docs/permissions.md`](docs/permissions.md)。
- **未公证**：从网络下载的 `.app` 会带 quarantine，需「右键 → 打开」或 `xattr -dr com.apple.quarantine Chassis.app`（同见 [`docs/permissions.md`](docs/permissions.md)）。
- **Windows 待实机验收**：UWP 应用（Microsoft Store 装的）搜不到；文件搜索优先复用 Everything、未装则用内置索引。进度见 [`docs/launcher-requirements.md`](docs/launcher-requirements.md) M6。
- **`host-manager` 的旧版备份**不会自动迁移（历史版本把备份放在安装目录的 `data/backups`），留待单独处理。

## 贡献指南

```bash
pnpm install
pnpm dev          # 内核 + UI（浏览器里调试）
pnpm shell:dev    # 跑真壳（需要 Rust 工具链）
```

提交前必须通过质量门（命令见「当前状态」）；四条关键约定：

1. **底座零能力**：提交前自查 `apps/kernel` 的 diff 里有没有出现能力词（应用、文件、网址…）。出现即说明有东西该做成插件。
2. **规范先行**：需求 / 规范没写的行为，先改 `docs/`（或提 ADR）再写代码；槽位、字段、章节有变动必须同步文档。
3. **跨进程的同一件事只有一个裁决者**：窗口显隐只由壳决定、内核只广播状态；两边都做 = 一次热键 toggle 两遍。
4. **改完必跑**：质量门命令 + 起**打包产物**手动点一遍 —— 生产资源路径与 dev server 不同，只测 dev 会漏白屏。

更细的开发流程、风格与提交规范见 [`AGENTS.md`](AGENTS.md)；提交信息用 Conventional Commits + 中文主题（如 `feat: 启动台结果改为图标网格`）；PR 里写明跑过的命令，UI 改动附截图。

## 许可证

[MIT](LICENSE)。本仓库包含的第三方组件（图标数据、部分系统集成逻辑）及其许可证原文见 [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)。
