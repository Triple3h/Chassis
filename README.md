# Chassis

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS 11+ / Windows 10+](https://img.shields.io/badge/platform-macOS%2011%2B%20%7C%20Windows%2010%2B-lightgrey.svg)
![Rust: stable](https://img.shields.io/badge/rust-stable-dea584.svg)
![Plugin API: v2](https://img.shields.io/badge/plugin%20api-v2-7c3aed.svg)

**一个插件化的跨平台启动台**：全局热键唤出，输入即搜，结果以图标网格呈现，支持「最近使用」与「已固定」。macOS 11+ 与 Windows 10+ 均可原生构建与运行。

底座采用**零能力内核**设计：内核只提供插件运行时、搜索调度与协议，**不包含任何具体能力** —— 扫描应用、读写文件、打开网址、算验证码，全部由插件实现。**出厂插件与第三方插件走完全相同的清单与能力机制**，可禁用、可卸载（仅 `internal-*` 管理面例外）。壳、内核与逻辑层插件全部用 Rust 编写，应用运行时**不依赖 Node**。

| # | 设计约束 | 含义 |
|---|---|---|
| 1 | **底座零能力** | 内核里不出现任何具体能力（应用 / 文件 / 网址 / 网络…）；一旦出现，就说明有东西该做成插件 |
| 2 | **出厂自带 ≠ 内核内嵌** | 官方插件走同一套插件机制，可禁用、可卸载（仅 `internal-*` 管理面例外） |
| 3 | **能力即权限** | 未在清单声明的 capability，装配期就不挂载；插件侧表现为「方法不存在」，而非运行时被拒绝 |

完整原则（含「注册即可逆」「一切跨进程调用可审计」「数据与代码分离」）见 [`docs/launcher-requirements.md`](docs/launcher-requirements.md) §1.2。

## 核心特性

- **唤出** —— macOS 默认 `⌥Space`、Windows 默认 `Ctrl+Shift+Space`（被占用自动回退并提示实际生效的键）；托盘左键唤出 / 隐藏；单实例；失焦或 `Esc` 退出后隐藏；唤出时自动带入前台选中的文本。
- **搜索** —— 拼音（全拼 / 首字母 / 多音字变体）、前缀与模糊匹配；多插件结果合并后按「匹配 + 最近使用 + 频率」打分；已固定与最近使用参与搜索；输入算式（如 `10+22`）会直接给出结果，回车打开计算稿纸接着算。
- **图标网格** —— 分区（已固定 / 最佳匹配 / 最近使用）可折叠，列数按窗口宽度计算；键盘全网格导航、动作菜单、二级面板、固定项拖拽重排；超过 200 条自动虚拟滚动。
- **开箱可用** —— 17 个出厂插件：应用启动、文件搜索、网址直达、聚合翻译、TOTP 验证码、Hosts 管家、进程管理器、文本比对、JSON 工具箱、备忘快贴、计算稿纸、Markdown 笔记、ToDo 待办、录屏助手、剪贴板历史（Windows）、插件更新、设置与插件管理。清单与工具链见 [`plugins/README.md`](plugins/README.md)。
- **可扩展** —— 插件 = 一个目录：`package.json` 清单 + 可选 iframe 页面（`view`）+ 可选逻辑层可执行产物（`no-view` / `script`）；支持目录 / zip 安装（zip 也可直接拖进窗口），用到的能力必须在清单里声明。
- **可审计** —— 未声明的 capability 在装配期就不挂载；插件 → 宿主的每次调用都过统一入口并落本地审计日志。
- **轻量且离线** —— Rust 内核常驻约 14 MB；运行时不需要本机装 Node 或 Rust；数据全部保存在本机（底座自身不联网）。

## 架构

```
┌ 壳（Rust / Tauri 2）   窗口 · 热键 · 托盘 · 单实例 · 通知 · 剪贴板 · 打开   ← 只有系统原语
├ 内核（Rust）           插件运行时 · 服务总线 · 注册表 · 搜索 · 历史 · 审计
├ 启动台 UI（Vue 3）     搜索框 · 图标网格 · 键盘导航 · 动作菜单
└ 插件                   view = iframe 页面（每插件独立端口 ⇒ 独立 origin）；no-view / script = 独立子进程
```

四条通信链路、三种命令形态（`view` / `no-view` / `script`）与模块落位见 [`docs/architecture.md`](docs/architecture.md)；动效令牌与窗口编排见 [`docs/motion.md`](docs/motion.md)。

## 安装与构建

### 环境要求

| | 版本 | 说明 |
|---|---|---|
| 系统 | macOS 11+ / Windows 10+ | 两端都在各自平台上原生构建 |
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
Windows：解压 zip 后双击 `Chassis.exe`（首次运行有 SmartScreen 提示，点「更多信息 → 仍要运行」；产物静态链接 MSVC 运行时，不需要另装 VC++ 运行库）。

> **系统授权、签名与解除 quarantine**（host-manager 免授权写入 / TCC 排障 / 未公证包的打开方式）见 [`docs/permissions.md`](docs/permissions.md)。

> **Windows 文件搜索**：已安装 [Everything](https://www.voidtools.com/) 时直接复用其全盘索引（无需配置；只读取，不改动、也不随包分发其二进制）；否则使用内置索引，首次运行在后台建库。

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
| `↑` `↓` `←` `→` / `Tab` | 网格导航（跨分区连续，`Shift+Tab` 反向） |
| `Enter` / `Shift+Enter`（`⌘Enter` 同） | 执行默认动作 / 第二动作 |
| `⌘K` | 动作菜单：固定、复制标题、移出最近使用、打开插件目录、禁用或卸载插件 |
| `⌘I` | 展开 / 收起二级面板 |
| `⌘,` | 打开设置 |
| `Esc` / `⌘W` | 插件页返回启动台 |
| `Esc` | 分步退出：收起二级面板 → 清空输入 → 隐藏窗口 |

数据目录：macOS `~/Library/Application Support/Chassis/`、Windows `%APPDATA%\Chassis\`（`LAUNCHER_DATA_ROOT` 可覆盖；macOS 上会从旧目录 `Launcher/` 自动接手一次）。排障先看 `logs/shell.log`（壳日志 + 内核 stderr 转发）与 `logs/kernel.log`；完整的目录布局（插件数据 / 审计 / 日志导出 / 内核外置副本）见 [`docs/architecture.md`](docs/architecture.md) §7。

### 更新

搜「更新」（或设置 → 插件）打开更新页：**插件**、**内核**与**应用**各自独立检查、下载、更新，sha256 逐字节校验，失败自动回滚，也可手动「恢复出厂版本」。

- **来源** —— 三条通道分别对应固定 tag `plugins-latest` / `kernel-latest` / `app-latest`；同时发布到 npm，客户端优先读取 npmmirror 上的**签名索引**，失败回落 tag 直链，不接受自定义源。
- **插件** —— 除 3 个底座基础能力（`app-launcher` / `file-search` / `internal-settings`）外的出厂插件都可被覆盖更新。契约见 [`docs/plugin-spec.md`](docs/plugin-spec.md) §6.4。
- **内核** —— 内核 + UI 同包更新、优雅重启；打包版内核以数据目录外置副本运行，不触碰 App 的代码签名。见 [`docs/kernel-hot-update.md`](docs/kernel-hot-update.md)。
- **应用（壳）** —— 整包替换：托盘常驻「检查更新…」与「关于」页更新卡片，由你决定何时更新；候选包先跑 `--hot-probe` 自检，连续两次启动未就绪自动回滚。macOS 与 Windows 都由独立 helper 在进程完全退出后替换（装到只读位置时标记「手动更新」）。见 [`docs/shell-hot-update.md`](docs/shell-hot-update.md)。

版本、tag 约定、CI 与发布方式见 [`docs/release-channels.md`](docs/release-channels.md)。

## 写插件

一个 `view` 插件就是一个静态目录加一份清单（没有编译步骤）；需要读写文件、调系统命令的用 `no-view` / `script`（Rust 可执行产物，走 [`packages/plugin-sdk-rs`](packages/plugin-sdk-rs)）。

- 动手：`pnpm create:plugin <id> [--mode view|script|full]` 生成工程骨架（清单 / Vite / Cargo / bin 一次到位，含逻辑层自动登记 Cargo members；见 [`packages/plugin-cli`](packages/plugin-cli)）
- 最小示例（附录 A 是可运行的最小插件）、清单字段、宿主 API、能力表与错误语义：[`docs/plugin-spec.md`](docs/plugin-spec.md)
- 工程搭建、构建、Rust 逻辑层与踩坑复盘：[`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md)
- 出厂插件（也是最好的范例）：[`plugins/README.md`](plugins/README.md)

在设置页安装（支持 zip 与目录路径，zip 也可直接拖进启动台窗口），或把目录放进 `<dataRoot>/extensions/hello/`；输入命令名即可搜到。

## 仓库结构

```
apps/
  shell/            Rust / Tauri 2 壳：窗口、热键、托盘、单实例、通知、剪贴板、open（仅系统原语）
  kernel/           Rust 内核（bin: launcher-kernel）：插件运行时 · 服务总线 · 注册表 · 搜索 · 历史 · 审计
  launcher-ui/      Vue 3 启动台 UI：搜索框、图标网格（分区折叠 / 虚拟滚动）、键盘导航、动作菜单
packages/
  plugin-manifest/  清单类型 + 校验 + 契约类型（内核 / UI / SDK 共用）
  plugin-api/       @launcher/api —— 插件页 SDK
  plugin-sdk-rs/    launcher-plugin-sdk —— 逻辑层 Rust SDK
  plugin-cli/       pnpm create:plugin 脚手架（清单 / Vite / Cargo / bin 一次生成）
  ui/               @launcher/ui —— 插件 UI 套件（设计令牌 + 组件），构建期打进插件产物
plugins/            17 个出厂插件（视图层 esbuild 或 Vite + Vue，逻辑层是 Rust 可执行产物）→ plugins/README.md
tests/              fixtures/echo-plugin + unit / contract / smoke（harness 直接拉起真内核二进制）
scripts/            构建 / 测试 / 打包 / 发布 / 自检 / 开发脚本（lib/ 为构建期工具）
docs/               需求、规范、架构、手册、动效、发布通道、第三方许可
```

模块级映射与实现细节见 [`docs/architecture.md`](docs/architecture.md) §2；更细的仓库指南见 [`AGENTS.md`](AGENTS.md)。

## 文档

**用 / 装 / 发布**：[`permissions.md`](docs/permissions.md)（签名与系统权限）｜ [`shell-hot-update.md`](docs/shell-hot-update.md) ｜ [`kernel-hot-update.md`](docs/kernel-hot-update.md) ｜ [`release-channels.md`](docs/release-channels.md)（四条发布通道、版本与发版）

**写插件**：[`plugin-spec.md`](docs/plugin-spec.md)（对外契约）｜ [`plugin-dev-guide.md`](docs/plugin-dev-guide.md) ｜ [`motion.md`](docs/motion.md)（动效令牌）｜ [`plugins/README.md`](plugins/README.md)

**改底座**：

| 文档 | 内容 |
|---|---|
| [`docs/launcher-requirements.md`](docs/launcher-requirements.md) | **唯一需求源**：产品定义、行为规格、里程碑 |
| [`docs/architecture.md`](docs/architecture.md) | 内核实现细节 + 与需求的差异清单 + 已知边界 + 测试与验收 + Windows 热更新的边界与不变量（§11） |
| [`AGENTS.md`](AGENTS.md) | 仓库指南：结构、命令、风格、提交规范 |

**合规**：[`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) ｜ [`LICENSE`](LICENSE)

## 开发

```bash
pnpm install
pnpm dev          # 内核 + UI（浏览器里调试）
pnpm shell:dev    # 跑真壳（需要 Rust 工具链）
```

提交前跑完：

```bash
cargo test --workspace && pnpm typecheck && pnpm test && pnpm build && pnpm spec-check
```

并在**打包产物**上手动点一遍（生产资源路径与 dev server 不同）。底座零能力、规范先行、跨进程单一裁决者等约定见 [`AGENTS.md`](AGENTS.md)；提交信息用 Conventional Commits + 中文主题，PR 里写明跑过的命令，UI 改动附截图。

## 许可证

[MIT](LICENSE)。本仓库包含的第三方组件（图标数据、部分系统集成逻辑）及其许可证原文见 [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)。
