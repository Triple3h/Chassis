# Chassis

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS 11+](https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey.svg)
![Rust: stable](https://img.shields.io/badge/rust-stable-dea584.svg)
![Plugin API: v2](https://img.shields.io/badge/plugin%20api-v2-7c3aed.svg)

**一个插件化的 macOS 启动台**：全局热键唤出，输入即搜，结果以图标网格呈现，支持「最近使用」与「已固定」。

底座采用**零能力内核**设计：内核只提供插件运行时、搜索调度与协议，**不包含任何具体能力** —— 扫描应用、读写文件、打开网址、算验证码，全部由插件实现。**出厂插件与第三方插件走完全相同的机制**，可禁用、可卸载。壳、内核与逻辑层插件全部用 Rust 编写，应用运行时**不依赖 Node**。

## 项目简介

Chassis 想解决的问题是：启动台类工具一旦把「应用扫描」「文件搜索」这类能力直接做进内核，就无法再回头 —— 加一个能力就要改一次内核，官方能力天然比第三方特权，安全边界只能靠运行时判断。

Chassis 的选择是把边界一条条钉死：

| # | 原则 | 含义 |
|---|---|---|
| P1 | **底座零能力** | 内核里不出现任何具体能力（应用 / 文件 / 网址 / 网络…）。一旦出现，就说明有东西该做成插件 |
| P2 | **出厂自带 ≠ 内核内嵌** | 官方插件走同一套插件机制，可禁用、可卸载（仅 `internal-*` 管理面例外） |
| P3 | **能力即权限** | 未在清单声明的 capability，装配期就不挂载；插件侧表现为「方法不存在」，而非运行时被拒绝 |
| P4 | **注册即可逆** | 任何注册都返回 disposer，插件停用 / 重载 / 卸载按注册逆序回滚，不留残渣 |
| P5 | **一切跨进程调用可审计** | 插件 → 宿主的每次调用走统一入口并落本地审计日志（滚动 7 天） |
| P6 | **数据与代码分离** | 插件目录只读；插件唯一可写处是注入的 `dataPath`，升级插件不丢用户数据 |

验收口径（贯穿整个项目）：

> **清空所有插件目录后，应用仍能启动、能唤出、能搜索（结果为空）、能显示空的「最近使用／已固定」、能安装插件。**

## 核心特性

- **唤出** —— 默认热键 `⌥Space`（被占用自动回退并提示实际生效的键）；托盘左键唤出 / 隐藏；单实例；失焦或 `Esc` 隐藏；唤出时自动带入前台选中的文本。
- **搜索** —— 拼音（全拼 / 首字母 / 多音字变体）、前缀与模糊匹配；多插件结果合并后按「匹配 + 最近使用 + 频率」打分；已固定与最近使用参与搜索；输入算式（如 `10+22`）会直接给出结果，回车打开计算稿纸接着算。
- **图标网格** —— 分区（已固定 / 最近使用 / 最佳匹配）可折叠，列数按窗口宽度计算；键盘全网格导航、动作菜单、二级面板、固定项拖拽重排；超过 200 条自动虚拟滚动。
- **开箱可用** —— 14 个出厂插件：应用启动、文件搜索、网址直达、聚合翻译、TOTP 验证码、Hosts 块管家、文本比对、JSON 工具箱、备忘快贴、计算稿纸、Markdown 笔记、ToDo 待办、录屏助手、设置与插件管理。
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

四条通信链路：

| 链路 | 协议 |
|---|---|
| 壳 ↔ 内核 | `stdio` + newline JSON-RPC 2.0（协议只走 stdout/stdin，日志一律 stderr） |
| 内核 ↔ 启动台 UI | HTTP `/api/*` + SSE `/api/events` |
| 内核 ↔ 视图层插件 | 每插件独立 HTTP listener（`listen(0, 127.0.0.1)`）⇒ 独立 origin，postMessage 桥三重校验（source / origin / sid+token） |
| 内核 ↔ 逻辑层插件 | `spawn` 可执行产物 + NDJSON over stdio（apiVersion 2） |

插件的三种命令形态：

| 形态 | 运行方式 | 适合 |
|---|---|---|
| `view` | iframe 里的静态页面，URL 带 `?sid=&cmd=&theme=` 区分会话 | 有界面交互的功能（TOTP、JSON 工具…） |
| `no-view` | 独立子进程，一次性执行 | 无界面的命令（刷新索引、读写配置…） |
| `script` | 独立子进程，可被 `exec.run` 调用；贡献型搜索可常驻 | 后台逻辑、搜索数据源 |

设计细节、与需求的差异清单与已知边界见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/decisions/`](docs/decisions)（ADR-0001~0005）。

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
pnpm build        # 内核 + 启动台 UI + 14 个出厂插件
pnpm app:local    # macOS：release 编译 + 组装 + 代码签名 → dist-app/Chassis.app
pnpm app:win      # Windows：release 编译 + 组装绿色版 → dist-app/Chassis-<version>-win-x64.zip
```

macOS：把 `dist-app/Chassis.app` 拖进 `/Applications` 双击即可。

Windows：解压 zip 后双击 `Chassis.exe`。首次运行会有 SmartScreen 提示（未签名）——
点「更多信息 → 仍要运行」；系统缺 WebView2 时会提示安装（Win11 已自带）。

> **Windows 的文件搜索**：如果你装了 [Everything](https://www.voidtools.com/)，启动台会**直接复用它**
> 已经建好的全盘索引（无需任何配置；只读取，不改动、也不随包分发它的任何二进制）；
> 没装则用内置索引（首次运行在后台建库，建好之前只返回空结果）。

> **为什么要签名**：Apple Silicon 上未签名的可执行文件会被内核直接杀掉（`Killed: 9`）。
> 打包脚本优先用**本机自签名的代码签名证书**（`node scripts/make-signing-cert.mjs` 一次性创建，免费、仅本机有效；找不到证书时回落 `codesign --sign -` 的 ad-hoc 签名）。
> 用固定证书而不是 ad-hoc 的原因：macOS 的 TCC 授权（辅助功能 / 屏幕录制 / 自动化 / 通知）按**代码签名身份**记账，ad-hoc 的身份就是二进制哈希 —— 每次重新打包都变，已给的授权会失配重弹；固定证书的身份跨重新打包稳定，一次授权长期有效。
> 自用不需要 Apple Developer、公证或自动更新；本地构建的 `.app` 不带 quarantine 属性，双击即可运行。

### 会弹哪些系统权限（各自对应什么功能）

| 系统设置里的名字 | 谁在用 | 不给会怎样 |
|---|---|---|
| **辅助功能** | 壳 `primitives/selection.rs`：唤出时读前台选中的文本 | 唤出不带选区，其余照常（可随时在系统设置里补授权） |
| **屏幕录制** | 内核 `services/primitives.rs` 调 `screencapture`：`screenshot` 能力（TOTP 扫码的前置） | 截图只有壁纸、扫不出码 |
| **自动化 / Apple 事件**（弹窗文案：「想控制此 Mac 并访问你的数据」） | `host-manager` 的提权写入：`osascript -e 'do shell script … with administrator privileges'` 把托管区写进 hosts | **只有**「写入托管区」这一个动作失败；读、预览与其它插件都不受影响 |
| 通知 | `notify` 能力（操作完成提示） | 少提示，不影响功能 |
| 文件与文件夹（桌面 / 图片等） | TOTP 扫截图目录、文件搜索命中受保护目录 | 对应范围搜不到 |

> **前置说明**：**打开应用 / 文件 / 网址走的是 `/usr/bin/open`（LaunchServices），不需要任何权限** —— 所以「自动化」那条只在真的动 hosts 时才弹，不是启动就弹。
> **Windows 上这些授权一个都不需要**：读选中文本走 UI Automation（系统 API，无需授权；只对实现了 TextPattern 的控件有效，其余静默跳过）；hosts 写入走 UAC 授权框（"是否允许此应用对你的设备进行更改？"，与 macOS 的提权框对应）；区域截图唤起系统截图（等同 Win+Shift+S）。
> **host-manager 可以不开这条**：顶栏点「需授权」→「开启免授权写入」，会把 `/etc/hosts` 的写权限**一次性**授给当前账户（POSIX ACL `chmod +a`，与 uTools / SwitchHosts 引导你手动做的是同一件事），此后保存直接写入、不再弹「自动化」框；随时可在同一面板撤销，恢复系统默认。
> TCC 授权是**绑代码签名身份**的：用固定证书签名（默认路径）时重新打包不影响授权；回落 ad-hoc 时每次重新打包都会被系统当成「第一次」重弹一次。
> 弹窗里只有「拒绝 / 打开系统设置」（没有「允许」）时，说明之前拒绝过或签名已变，去 系统设置 → 隐私与安全性 → 自动化 手动勾上即可。

### 开发模式（不起壳，浏览器里就能用）

```bash
pnpm install
pnpm dev          # 内核（standalone）+ UI（vite dev，HMR）
```

终端会打印入口地址（形如 `http://127.0.0.1:3333/?kernel=http://127.0.0.1:<内核端口>`）。也可以只起一半：

```bash
pnpm dev:kernel   # 只起内核（API 在打印出的 /api，UI 托管构建产物）
pnpm dev:ui       # 只起 UI（vite dev server，3333）
pnpm shell:dev    # 跑真壳（需要 Rust 工具链；cargo run）
```

开发态数据落在仓库根的 `.dev-data/`，不碰真实用户数据。

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

| 数据位置 | 说明 |
|---|---|
| `~/Library/Application Support/Chassis/`（macOS）／`%APPDATA%\Chassis\`（Windows） | 数据目录（`LAUNCHER_DATA_ROOT` 可覆盖；macOS 上会从旧目录 `Launcher/` 自动接手一次） |
| `.../logs/shell.log` | 壳与内核日志（内核日志走 stderr，由壳转发落盘），排障先看这里 |
| `.../extensions/<id>/` | 已安装的插件 |
| `.../plugins/<id>/` | 插件数据目录（插件的唯一可写处；`file-search` 的文件索引也在这里） |
| `.../logs/audit-*.jsonl` | 插件调用审计日志（滚动 7 天） |

## 示例

### 写一个最小插件

一个 `view` 插件就是一个静态目录加一份清单，没有编译步骤：

```jsonc
// dist/package.json —— 插件清单（构建产物即插件目录）
{
  "name": "hello",              // = 插件 id（^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$）
  "title": "Hello",
  "version": "1.0.0",
  "type": "module",
  "apiVersion": "2",
  "capabilities": ["hostUi", "storage"],
  "commands": [{ "name": "hello", "title": "打个招呼", "mode": "view", "searchable": true }]
}
```

```html
<!-- dist/index.html —— 插件页面，用 view 侧 SDK 调宿主 -->
<script type="module">
  import { hostUi, storage } from '@launcher/api'

  // SDK 调用失败会以 LauncherError 拒绝；需要「失败即空值」就在调用点兜底
  const count = (await storage.get<number>('count').catch(() => undefined)) ?? 0
  await storage.set('count', count + 1).catch(() => {})
  await hostUi.setSearchContent(`第 ${count + 1} 次打开`).catch(() => {})
</script>
```

在设置页安装（支持 zip 与目录路径，zip 也可以直接拖进启动台窗口），或把目录放进 `<dataRoot>/extensions/hello/`；输入「hello」即可搜到。

### 写一个逻辑层命令（Rust）

需要读写文件、调系统命令的逻辑层命令，用 Rust SDK（`packages/plugin-sdk-rs`）：

```rust
use launcher_plugin_sdk::{json, Level, Mode};

fn main() {
    // panic 由 SDK 转为 fail；run 模式结束后进程退出
    launcher_plugin_sdk::run(|ctx| match ctx.mode() {
        Mode::Run => {
            let args = ctx.args::<MyArgs>()?;                    // 入参（JSON → 结构体）
            ctx.log("开始执行", Some(&json!({ "args": args })), Level::Info)?;
            ctx.done(json!({ "ok": true }))                      // 写 result + done
        }
        Mode::Search => ctx.on_query(|query, _token| Ok(vec![json!({ "id": query, "title": query })])),
    });
}
```

构建产物须为可执行文件（`dist/<命令名>`，Windows 为 `.exe`），与 `commands[].name` 逐字相同；Rust SDK 提供 `ctx.args / settings / data_path / log / progress / done / on_query`。

完整的清单字段、宿主 API、能力表与错误语义见 [`docs/plugin-spec.md`](docs/plugin-spec.md)；工程搭建与踩坑见 [`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md)。

## 目录结构

```
apps/
  shell/            Rust / Tauri 2：窗口、热键、托盘、单实例、通知、剪贴板、open
    src/{main,lib,ipc,sidecar,logging}.rs + src/primitives/{window,hotkey,tray,notify,clipboard,opener}.rs
    ui-stub/        冷启动骨架页（内核就绪前显示，崩溃时变错误面板）
  launcher-ui/      Vue 3 + Vite + Tailwind v4：搜索框、图标网格（分区折叠 / 虚拟滚动）、
                    键盘导航、动作菜单、二级面板
  kernel/           Rust 内核（bin: launcher-kernel）：插件运行时 + 服务总线 + 注册表 + 搜索 +
                    历史 + 审计 + HTTP/SSE + 壳协议（src/{kernel,api,link,search,history,audit,config,
                    session,exec,plugin/*,services/*,http/*}.rs）
packages/
  plugin-manifest/  清单类型 + 校验 + 契约类型（内核 / UI / SDK 共用）
  plugin-api/       @launcher/api —— 插件页 SDK
  plugin-sdk-rs/    launcher-plugin-sdk —— 逻辑层 Rust SDK（ctx / done / fail / log / progress / on_query）
  ui/               @launcher/ui —— 插件 UI 套件（设计令牌 + AppShell / UiIcon / UiDialog
                    + virtual / clipboard / keys / theme / toast），构建期打进插件产物
plugins/            14 个出厂插件（见下表；view 是 Vite + Vue，逻辑层是 Rust 可执行产物）
tests/
  fixtures/echo-plugin/  契约测试插件（逻辑层 = SDK 的 echo 示例二进制）
  unit/ contract/ smoke/ 单元 / 契约 / 验收（harness 直接拉起真内核二进制）
scripts/            构建 / 测试 / 打包 / 自检 / 开发脚本（lib/ 为构建期工具）
docs/               需求、规范、架构、手册、ADR、第三方许可
```

出厂插件（预装、可禁用、可卸载；产物形态与第三方插件完全一致）：

| 插件 | 命令 | 工具链（视图层 / 逻辑层） |
|---|---|---|
| `app-launcher` | `search`（script，贡献型）+ `refresh`（no-view） | esbuild / Rust |
| `file-search` | `search`（script，贡献型） | esbuild / Rust |
| `web-open` | `web`（script，贡献型） | esbuild / Rust |
| `translate` | `panel`（view）+ `translate`（script，贡献型） | Vite + Vue / Rust |
| `internal-settings` | `settings` + `manage`（view） | esbuild / — |
| `totp` | `totp`（view）+ `read-image`（script） | Vite + Vue / Rust |
| `host-manager` | `hosts`（view）+ `hosts-read` / `hosts-write` / `hosts-permission`（script） | Vite + Vue / Rust |
| `text-diff` | `diff`（view） | Vite + Vue / — |
| `json-tools` | `json`（view） | Vite + Vue / — |
| `snips` | `snips`（view） | Vite + Vue / — |
| `calc-pad` | `calc-pad`（view）+ `calc-eval`（script，贡献型） | Vite + Vue / Rust |
| `markdown-notes` | `notes`（view） | Vite + Vue / — |
| `todo` | `todo`（view） | Vite + Vue / — |
| `screen-recorder`（macOS 专属，清单声明 `platforms`） | `recorder`（view）+ `rec-start` / `rec-stop` / `rec-status` / `rec-shot` / `rec-permission` / `rec-list`（script） | Vite + Vue / Rust |

## 文档

**写插件**（对外契约）：[`plugin-spec.md`](docs/plugin-spec.md) ｜ [`plugin-dev-guide.md`](docs/plugin-dev-guide.md) ｜ [`plugins/README.md`](plugins/README.md)

**改底座**（内部设计）：

| 文档 | 内容 |
|---|---|
| [`docs/launcher-requirements.md`](docs/launcher-requirements.md) | **唯一需求源**：产品定义、行为规格、里程碑（计划口径） |
| [`docs/architecture.md`](docs/architecture.md) | 内核实现细节 + 与需求的差异清单 + 已知边界 + 测试与验收 |
| [`AGENTS.md`](AGENTS.md) | 仓库指南（给 AI 与新贡献者）：结构、命令、风格、提交规范 |

**历史与合规**：[`docs/decisions/`](docs/decisions)（ADR-0001~0005）｜ [`docs/m5-rust-and-windows.md`](docs/m5-rust-and-windows.md)（全 Rust 化与 Windows 计划）｜ [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) ｜ [`LICENSE`](LICENSE)

## 当前状态

macOS 上自用可用：热键唤出、搜索、应用启动、文件搜索、网址直达、TOTP / hosts / 文本比对 / JSON 工具、备忘快贴 / 计算稿纸 / Markdown 笔记 / ToDo 待办 / 录屏助手、插件管理与安装都已在实机跑通。壳、内核与全部逻辑层插件均为 Rust，打包产物不含 Node。

| 能力 | 状态 |
|---|---|
| macOS 自用版（`pnpm app:local` → `dist-app/Chassis.app`） | ✅ 实机在用 |
| Rust 内核 + Rust 逻辑层插件（apiVersion 2，免 Node） | ✅ |
| 视图层插件（Vue + iframe，独立 origin） | ✅ |
| Windows 10/11（`pnpm app:win` → 绿色版 zip；CI 原生构建） | 🚧 代码就位，待实机验收（见 [`docs/m5-rust-and-windows.md`](docs/m5-rust-and-windows.md) §B0 / §B5） |

质量门（仓库内全绿）：

```bash
cargo test --workspace   # Rust：内核 / SDK / 各插件逻辑层
pnpm typecheck           # 全部工作区包（Vue 工程走各自的 vue-tsc）
pnpm test                # 单元 / 契约 / 验收 + 各插件的 core 用例
pnpm build               # kernel + ui + 全部出厂插件
pnpm spec-check          # 出厂插件规范自检（清单 / 能力 / 产物 / 远程资源）
pnpm smoke:real          # 真内核 + 14 个出厂插件冒烟
```

## 路线图与已知问题

**路线图**

| 项 | 说明 |
|---|---|
| Windows 10/11 收尾 | 实机验收（托盘 / 透明窗口观感 / 通知 / 拖动缩放）、UWP 应用扫描、Everything 加速件、NSIS 安装包、`release.yml` + GitHub Releases 分发 |
| 分发链路 | 代码签名 / 公证、自动更新、dmg 打包 |
| 插件脚手架 CLI | 一条命令生成插件工程骨架 |
| 测试补齐 | Playwright E2E、zip 安装的自动化用例、万条历史性能基准 |

**已知问题**

- **逻辑层命令无沙箱**：`no-view` / `script` 产物是独立子进程，拥有当前用户的完整权限（这是该形态的固有代价）。安装时会展示 `exec.spawn` 等高风险能力，但无法阻止脚本自行起进程；真正的隔离需要 WASM 或平台沙箱。
- **签名与 TCC 授权**：授权记录绑定代码签名身份 —— 默认的**固定证书**签名跨重新打包稳定；没有证书回落 **ad-hoc** 时，每次重新打包 macOS 都会把授权当成「第一次」重弹。弹窗里若只有「拒绝 / 打开系统设置」，去 系统设置 → 隐私与安全性 的对应分类**删掉旧条目再重新授权**（旧条目对应旧身份，留着也不生效）。
- **未公证**：从网络下载的 `.app` 会带 quarantine，需要「右键 → 打开」或 `xattr -dr com.apple.quarantine Chassis.app`。
- **平台限制**：macOS 实机在用；Windows 代码就位、**待实机验收** —— 已知缺口是 UWP 应用（从 Microsoft Store 装的）搜不到；
  文件搜索优先复用你已装的 Everything（装了就直接可用、毫秒级；只读它的索引，不随包分发它的任何二进制），
  没装才用内置索引（首次运行要等后台建库）；未签名会触发 SmartScreen 提示。
- **`host-manager` 的旧版备份**不会自动迁移（历史版本把备份放在安装目录的 `data/backups`，迁移涉及提权写路径，留待单独处理）。

## 贡献指南

开发流程：

```bash
pnpm install
pnpm dev                      # 内核 + UI（浏览器里调试）
pnpm shell:dev                # 跑真壳（需要 Rust 工具链）
```

提交前必须通过质量门：

| 命令 | 作用 |
|---|---|
| `cargo test --workspace` | Rust 测试（内核 / SDK / 插件逻辑层） |
| `pnpm typecheck` | 全部工作区包类型检查（Vue 插件自动改用各自的 `vue-tsc`） |
| `pnpm test` | 全部测试；也可 `test:unit` / `test:contract` / `smoke` |
| `pnpm build` | `build:kernel` + `build:ui` + `build:plugins`（也可单独跑） |
| `pnpm spec-check` | 出厂插件规范自检（改动插件时必跑） |
| `pnpm smoke:real` | 真内核 + 出厂插件冒烟（不起壳） |
| `pnpm smoke:first-batch` | 四个 Vue 插件的端到端（HTTP 驱动，不起壳） |

约定：

1. **底座零能力**：提交前自查 `apps/kernel` 的 diff 里有没有出现能力词（应用、文件、网址…）。出现即说明有东西该做成插件。
2. **规范先行**：需求 / 规范没写的行为，先改 `docs/`（或提 ADR）再写代码；槽位、字段、章节有变动必须同步文档。
3. **注册即可逆**：任何注册都要能回滚，插件停用 / 重载 / 卸载后不留残渣（`tests/contract` 有覆盖）。
4. **跨进程的同一件事只有一个裁决者**：例：窗口显隐只由壳决定，内核只广播状态；两边都做 = 一次热键 toggle 两遍。
5. **改完必跑**：质量门命令 + 起**打包产物**手动点一遍 —— 生产资源路径与 dev server 不同，只测 dev 会漏白屏。

提交信息用 Conventional Commits + 中文主题，例如 `feat: 启动台结果改为图标网格`；PR 里写明跑过的命令，UI 改动附截图。改动前先读 [`AGENTS.md`](AGENTS.md) 与 [`docs/architecture.md`](docs/architecture.md) 里的硬约束。

## 许可证

[MIT](LICENSE)。本仓库包含的第三方组件（图标数据、部分系统集成逻辑）及其许可证原文见 [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)。
