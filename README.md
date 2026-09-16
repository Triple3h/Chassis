# Launcher（启动台底座）

一个 **ZTools 形态的启动台**：全局热键唤出、输入即搜，结果以图标网格呈现，支持「最近使用」与「已固定」。

**底座零能力** —— 内核里不出现任何具体能力（扫描应用、读文件、连网…）。所有能力（包括"启动应用"本身）都以插件形式集成，**出厂插件与第三方插件走同一套机制**。

- 架构：Tauri 2（壳，只提供系统原语） + Node 22 sidecar（内核，TypeScript） + Vue 3（启动台 UI）
- 验收口径（贯穿全程）：

  > **清空所有插件目录后，应用仍能启动、能唤出、能搜索（结果为空）、能显示空的「最近使用／已固定」、能安装插件。**

---

## 当前状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 壳（窗口/热键/托盘）+ 启动台 UI + 历史落盘 | ✅ 完成，自用版实机在用（热键 / 托盘 / 多屏 / 权限弹窗都验过） |
| M1 | 内核 + 插件运行时（context/registry/pipeline/plugin/audit + 每插件 HTTP + 桥） | ✅ 完成，契约测试全绿（`echo-plugin` 覆盖 API 全表） |
| M2 | 脚本运行时（worker_threads）+ `app-launcher` | ✅ 完成（含 ZTools 扫描逻辑移植） |
| M3 | `file-search` / `web-open` / `internal-settings` + 拼音索引 | ✅ 完成 |
| M4 | 打包 / 签名 / 公证 / 自动更新 / CI | 🔸 **自用版已就绪**：`pnpm app:local` 产出可双击的 `Launcher.app`（cargo release + ad-hoc 签名，不需要 Apple Developer）；分发链路（公证 / updater / minisign / CI / dmg）**按需再补** |

测试现状：`typecheck` **15 个工作区包**通过；`pnpm test` **15 个测试文件全绿**（内核单元 / 契约 / 验收 + 各插件的 core·script 用例）；`pnpm spec-check` 8 个出厂插件无不合规。

---

## 快速开始

```bash
# 1) 依赖
pnpm install

# 2) 构建（内核 + UI + 出厂插件）
pnpm build

# 3) 开发：内核独立跑（不需要壳，浏览器里就能用）
pnpm dev:kernel          # 打印内核地址（http://127.0.0.1:<port>）
pnpm dev:ui              # 另开一个终端：vite dev server（3333）
#   浏览器打开 http://127.0.0.1:3333/?kernel=http://127.0.0.1:<内核端口>

# 4) 跑真壳（需要 Rust 工具链）
pnpm shell:dev                    # cargo run，终端里跑

# 5) 自己日常用：打成可双击的 .app（不公证、不依赖 tauri-cli）
pnpm app:local                    # → dist-app/Launcher.app，拖进 /Applications
```

### 为什么要 ad-hoc 签名

Apple Silicon 上**未签名的可执行文件会被内核直接杀掉**（`Killed: 9`），这不是"公证不公证"的问题。
`pnpm app:local` 会自动执行 `codesign --force --deep --sign -`（ad-hoc，免费、仅本机有效）。

自用场景下**不需要**：Apple Developer（$99/年）、公证（notarization）、自动更新（minisign）、CI 双架构、dmg 分发。
本地构建的 `.app` 不带 quarantine 属性，双击即可运行，不会触发"来自身份不明的开发者"拦截。

数据目录：`~/Library/Application Support/Launcher`（可用 `LAUNCHER_DATA_ROOT` 覆盖，测试就是这么做的）。

---

## 脚本命令

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | 全部工作区包 `tsc --noEmit`（含插件与测试） |
| `pnpm test` | 全部测试；也可 `test:unit` / `test:contract` / `smoke` |
| `pnpm build` | `build:kernel` + `build:ui` + `build:plugins` |
| `pnpm build:kernel` | esbuild 打包内核为自包含 `apps/kernel/dist/kernel.mjs` |
| `pnpm build:ui` | vite 构建启动台 UI |
| `pnpm build:plugins` | 逐个构建插件为 `dist/`（每个脚本入口单独打包，保证自包含） |
| `pnpm app:local` | **自用打包**：release 编译 + 组装 `.app` + ad-hoc 签名 → `dist-app/Launcher.app` |
| `pnpm smoke:real` | 真内核 + 出厂插件冒烟（不起壳） |
| `pnpm build:shell` | 完整分发链路（组装 resources 并 `tauri build`，需 tauri-cli；公证/updater 未接） |
| `pnpm dev:kernel` / `dev:ui` | 开发模式 |
| `pnpm shell:dev` | `cargo run`（tauri dev） |

---

## 目录结构

```
apps/
  shell/            Rust / Tauri 2：窗口、热键、托盘、单实例、通知、剪贴板、open
    src/{main,lib,ipc,sidecar}.rs + src/primitives/{window,hotkey,tray,notify,clipboard,opener}.rs
    ui-stub/        冷启动骨架页（内核就绪前显示，崩溃时变错误面板）
  kernel/           TypeScript 内核：插件运行时 + 服务总线 + 注册表 + 搜索 + 审计
    src/{main,kernel,api,config,context,registry,pipeline,plugin,audit,history,search,jsonrpc,session}.ts
    src/services/{storage,bridge,hostUi,shell,exec,quicklink,settings,kernel}.ts
    src/http/{server,pluginServers}.ts
  launcher-ui/      Vue 3 + Vite + Tailwind v4：搜索框、图标网格（分区折叠 / 虚拟滚动）、键盘导航、动作菜单、二级面板
packages/
  plugin-manifest/  清单类型 + 校验 + 契约类型（内核/UI/CLI 共用）
  plugin-api/       @launcher/api —— 插件页 SDK（postMessage 客户端）
  plugin-api-node/  @launcher/api-node —— 脚本 SDK（ctx/log/progress/done/fail/storage/onQuery）
  ui/               @launcher/ui —— 插件 UI 套件：设计令牌 + AppShell / UiIcon / UiDialog + virtual / clipboard / keys / theme / toast
plugins/            出厂插件（预装、机制与第三方完全相同；可禁用可卸载）
  app-launcher/     应用扫描 + 启动（macOS）｜ esbuild 工具链
  file-search/      Spotlight 文件搜索 + Finder 显示
  web-open/         网址直达 / 搜索引擎
  internal-settings/ 设置 + 插件管理（internal：不可卸载）
  totp/             双重验证器（TOTP/HOTP + 扫码导入）｜ Vite + Vue
  hosts/            Hosts 管家（读写系统 hosts，含提权）
  text-diff/        文本比对（Myers 差分，Worker 内计算）
  json-tools/       JSON 工具箱（无损格式化 / 树视图）
tests/
  fixtures/echo-plugin/  契约测试插件（覆盖宿主 API 全表）
  unit/ contract/ smoke/ 单元 / 契约 / 验收
scripts/            build-{all,plugin,shell} / pack-local-app / pack-plugins / spec-check / run-{ts,tests,tsc} / smoke-{real,first-batch} / dev / make-icon（+ lib/ 构建工具）
docs/               需求、规范、架构、手册、ADR、第三方许可
```

---

## 文档

**写插件**（对外契约）

| 文档 | 内容 |
|---|---|
| [`docs/plugin-spec.md`](docs/plugin-spec.md) | **插件接入规范 v1** —— 清单、命令形态、宿主 API、能力、检查清单（唯一必读） |
| [`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md) | Vue 插件开发手册：工程搭建、构建管线、脚本协议、踩坑复盘 |

**改底座**（内部设计）

| 文档 | 内容 |
|---|---|
| [`docs/launcher-requirements.md`](docs/launcher-requirements.md) | **唯一需求源**：产品定义、行为规格、里程碑（计划口径） |
| [`docs/architecture.md`](docs/architecture.md) | 内核实现细节 + **与需求的差异清单** + 已知边界 + 测试与验收 |
| [`plugins/README.md`](plugins/README.md) | 出厂插件：两套工具链、目录约定、构建 / 自检 / 发布 |

**历史与合规**

| 文档 | 内容 |
|---|---|
| [`docs/decisions/`](docs/decisions) | ADR-0001~0003：UI 托管方式 / 贡献型搜索载体 / 管理面特权边界 |
| [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) | 第三方代码与移植清单（含 ZTools MIT 原文） |
| [`LICENSE`](LICENSE) | MIT |

---

## 开发约定

1. **底座零能力**：提交前自查 `apps/kernel` 的 diff 里有没有出现能力词（应用、文件、网址…）。出现即说明有东西该做成插件。
2. **规范先行**：遇到需求/规范没写的行为，先改 `docs/`（或提 ADR）再写代码。
3. **注册即可逆**：任何注册都要能回滚，插件停用后不留残渣（`tests/contract` 有覆盖）。
4. **每个里程碑收尾**：`pnpm typecheck && pnpm test && pnpm build`，然后起真实 `.app` 手动点一遍（生产资源路径与 dev 不同，只测 dev 会漏白屏）。
5. 新增槽位/字段/章节必须同步更新本文档与 `docs/plugin-spec.md`。

## 许可证

MIT（见 [`LICENSE`](LICENSE)；第三方代码与许可见 [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)）。
