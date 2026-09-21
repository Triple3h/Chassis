# 出厂插件（plugins/）

出厂**预装**的 17 个插件。内核一视同仁：同一份「出厂 bundle」、可禁用、可卸载
（只有 `internal-*` 属管理面不可卸载），产物形态与 `docs/plugin-spec.md` 完全一致。

| 插件 | 命令 | 视图层 | 逻辑层 |
|---|---|---|---|
| `app-launcher` | `search`（script，贡献型） + `refresh`（no-view） | esbuild | Rust |
| `file-search` | `search`（script，贡献型） | esbuild | Rust |
| `web-open` | `web`（script，贡献型） | esbuild | Rust |
| `internal-store` | `updates`（view） + `update`（script） | Vite + Vue | Rust |
| `clipboard-history`（Windows 专属） | `history`（view） + `search` / `record` / `clip-io`（script） | Vite + Vue | Rust |
| `translate` | `panel`（view） + `translate`（script，贡献型） | Vite + Vue | Rust |
| `internal-settings` | `settings` + `manage`（view） | esbuild | — |
| `totp` | `totp`（view） + `read-image`（script） | Vite + Vue | Rust |
| `host-manager` | `hosts`（view） + `hosts-read` / `hosts-write` / `hosts-permission`（script） | Vite + Vue | Rust |
| `text-diff` | `diff`（view） | Vite + Vue | — |
| `json-tools` | `json`（view） | Vite + Vue | — |
| `snips` | `snips`（view） | Vite + Vue | — |
| `calc-pad` | `calc-pad`（view）+ `calc-eval`（script，贡献型） | Vite + Vue | Rust |
| `markdown-notes` | `notes`（view） | Vite + Vue | — |
| `todo` | `todo`（view） | Vite + Vue | — |
| `screen-recorder`（macOS / Windows） | `recorder`（view） + `rec-start` / `rec-stop` / `rec-status` / `rec-shot` / `rec-permission` / `rec-list`（script） | Vite + Vue | Rust |
| `process-manager`（macOS / Windows） | `panel`（view） + `port-list` / `proc-list` / `proc-detail` / `proc-kill`（script） | Vite + Vue | Rust |

## 工程形态：视图层两套工具链，逻辑层统一 Rust

| | 内置（esbuild 工程） | Vue 插件 |
|---|---|---|
| 视图层 | `scripts/build-plugin.mjs`（esbuild，无框架） | 各自的 Vite + Vue 3 + Tailwind v4 工程 |
| 逻辑层 | Rust crate（源码在插件目录的 `src/`，产物 `dist/<命令名>`，apiVersion 2） | 同左（统一用 Rust SDK `launcher-plugin-sdk`） |
| 清单 | 手写 `package.json` 精简字段 | 构建期由 `scripts/lib/manifest-plugin.mjs` 裁剪写入 `dist/package.json` |
| 宿主调用 | view 直连 `@launcher/api`；逻辑层用 Rust SDK `launcher-plugin-sdk` | 同左 |
| 共享代码 | 无（各自独立） | `@launcher/ui`（工作区包，`packages/ui/`）：UI 积木 + 前端工具（构建期打进各自产物） |
| 构建驱动 | 根 `scripts/build-all.mjs` 按 `package.json` 的 `build:view` / `build:scripts` 驱动 | 同左 |

> Vue 插件（`totp` / `host-manager` / `text-diff` / `json-tools` / `snips` / `calc-pad` /
> `markdown-notes` / `todo` / `screen-recorder` / `translate`）与内置插件同出厂流程，
> 但保留自己的 Vite + Vue 工具链，view 侧直连 `@launcher/api`，逻辑层走 Rust SDK `launcher-plugin-sdk`。
> 插件 id 简化为 `totp` / `text-diff` / `json-tools`；hosts 后来改名为 `host-manager`。
> 旧数据目录与历史 / 固定项由内核首次加载时接手，**改名链**（`sofast-hosts` → `hosts` → `host-manager`）
> 见 `apps/kernel/src/legacy.rs` 的改名链（`LEGACY_PLUGIN_IDS` / `LEGACY_ID_TO_CURRENT`）。

## 目录

```
plugins/
├── <name>/                   每个插件一个独立工程（package.json / vite.config / tsconfig / src / test）
└── release/                  打包产物（pnpm pack:plugins）
```

Vue 插件共用的东西**不在本目录**，而是工作区包与根脚本：

| 位置 | 内容 |
|---|---|
| `packages/ui`（`@launcher/ui`） | 设计令牌 + `AppShell` / `UiIcon` / `UiDialog` + `virtual` / `clipboard` / `keys` / `theme` / `toast`；插件按 `"@launcher/ui": "workspace:*"` 依赖，构建期打进各自产物 |
| `scripts/lib/` | 构建期工具：`vite-plugin-vue.mjs`（vue 去重别名 + dev fs.allow）/ `manifest-plugin.mjs`（清单裁剪） |
| `tsconfig.vue-plugin.json` | Vue 插件工程的 tsconfig 基座（各插件与 `packages/ui` 继承它） |

## 常用命令（都在仓库根执行）

```bash
pnpm build            # kernel + ui + 全部插件（= node scripts/build-all.mjs）
pnpm build:plugins    # 只构建插件
pnpm spec-check       # 规范自检（清单 / N1 / N2 / N3 / 产物 / 远程资源）
pnpm pack:plugins     # 打 zip 到 plugins/release/
pnpm typecheck        # 全部工作区包（Vue 工程自动改用各自的 vue-tsc）
pnpm test             # 单元 / 契约 / 验收 + 各插件的 core/script 用例

node scripts/smoke-real.mjs          # 真内核 + 出厂插件冒烟
node scripts/smoke-first-batch.mjs   # 四个 Vue 插件端到端（HTTP 驱动，不起壳）
```

单个插件（进目录）：

```bash
pnpm --filter totp run build      # 构建（= build:view + build:scripts）
pnpm --filter totp run typecheck
pnpm --filter totp run test       # 用例在 test/ 下，走 ../../scripts/run-ts.mjs
pnpm --filter totp run dev        # 浏览器里调试 UI（宿主 API 会以「不在启动台中」失败）
```

## 运行时形态与数据落点

- 产物 `dist/` 就是插件目录：`index.html` + `assets/` + `package.json`（+ `no-view`/`script` 命令各自的可执行产物 `dist/<name>`，Windows 为 `<name>.exe`）。
  打包进 `.app` 时由 `scripts/lib/resources.mjs` 拷进 `Resources/builtin-plugins/`（每个插件一份）。
- **可变数据只写 `ctx().dataPath`**（N2）：即 `<dataRoot>/plugins/<id>/`。
  `pluginPath` 是只读安装目录，写它会被 `spec-check` 拦下。
- 插件改过 id 时，底座首次加载会把旧数据目录整体复制到新 id 下（只复制不删除）。

## Vue 插件的开发要点

### 命令形态决定工程形态

- `view` —— 渲染在 **iframe** 里的静态页，入口固定为插件根的 `index.html`。一个插件可以有多个 view 命令，
  它们**共用同一个 index.html**，靠 URL 上的 `?sid=&cmd=&theme=` 区分会话与命令。
- `no-view` / `script` —— **独立子进程**（apiVersion 2），产物是 `dist/<name>` 可执行文件（由 `cargo build --release` 产出后拷入），
  **`commands[].name` 必须与产物文件名逐字相同**（N1）。区别只在 `script` 不出现在命令面板、只能被 `exec.run` 调用；
  v1 的 `.mjs`（Node worker）**不再支持**（运行时直接报「需升级为可执行产物」）。
- 关键推论：**iframe 受浏览器沙箱限制，读不了本地文件路径**。凡是「按路径读写磁盘」的需求一律落到 `script`
  命令上（`totp` 的 `read-image` 就是为此存在），并配好 UI 侧的手工兜底路径。

### 构建管线（三段，顺序不能反）

1. `vue-tsc --noEmit` 类型检查；
2. `vite build`（UI，`emptyOutDir: true`）；
3. 有逻辑层命令的插件编译 Rust（`cargo build --release -p <crate>`），再由 `scripts/build-plugin.mjs <id> --copy-scripts`
   把 `target/release/<bin>` 拷成 `dist/<name>`（0755）。带 view 的插件用 `--copy-scripts --keep-dist`（不删上一步的 vite 产物）。

`scripts/lib/manifest-plugin.mjs` 挂在 `writeBundle`，把 `package.json` 裁剪成宿主需要的字段写进
`dist/package.json` —— 于是 **`dist/` 本身就是一个可直接安装的插件目录**。

### 宿主调用：直连 SDK

```ts
import { exec, host, hostUi, screenshot, storage } from '@launcher/api'        // view 侧
```

逻辑层（`no-view` / `script`，Rust）：

```rust
use launcher_plugin_sdk::{json, Mode};

fn main() {
    // panic 由 SDK 转 fail；run 模式结束后进程退出
    launcher_plugin_sdk::run(|ctx| match ctx.mode() {
        Mode::Run => {
            let args = ctx.args::<MyArgs>()?;   // ctx.args / settings / data_path / log / progress / on_query
            ctx.done(json!({ "ok": true }))
        }
        Mode::Search => ctx.on_query(|query, _token| Ok(vec![json!({ "id": query, "title": query })])),
    });
}
```

几条要点：

- **先判断在不在宿主里**：`host.isLauncher()`（同步）—— 浏览器里 `pnpm dev` 时为 `false`，
  此时所有调用会立刻以 `NOT_FOUND` 拒绝，别让它冒泡成未捕获异常。
- SDK 调用**永不抛原生异常**，失败是 `LauncherError { code }`；需要「失败即空值」语义就在调用点接 `.catch(() => null)`。
- `exec.run` 就是「拉起本插件的 script 命令」，参数 `{ command, args?, timeoutMs? }`；
  脚本侧 `done(x)` 的 `x` 即它的返回值。

### 计算调度：Worker + 主线程降级

解析/差分/格式化等可能超 50ms 的计算：`core/<算法>.ts` 纯函数 → `core/worker.ts` 薄壳 →
`core/runner.ts` 主线程调度（懒创建、自增 id 防串包、`onerror`/构造失败降级为主线程同步跑同一份纯函数）。
CSP 或老 WebView 下 Worker 可能创建失败，降级分支不是可选项。

### 硬约束（违反必出问题）

- **可变数据只写 `ctx().dataPath`**（N2）；`pluginPath` 只许读。
- 清单**必须**带 `apiVersion`（新插件写 `"2"`；底座仍接受 `"1"` 的视图层插件）与 `capabilities`（只声明真正用到的）。
- `commands[].name` 对 `no-view`/`script` 必须等于产物文件名 `dist/<name>`。
- 逻辑层 crate 的 `[[bin]]` 名 = 命令名（单一 bin 天然自包含，不存在 v1 那种「多入口被 Rollup 拆 chunk」的问题）。
- `vite.config.ts` 必须 `base: './'`，**不要开 `manualChunks`**。
- `@launcher/ui` 是工作区包，走标准解析 —— **不需要**再配 Vite alias / TS paths。`vite.config.ts` 里
  `pluginAliases(root)` 只为 `vue` 去重（保证 SFC 与插件代码共用一个运行时），`devFsAllow(root)` 让 dev server 能读 `packages/ui`。
- Tailwind v4 不会跨界扫描：每个插件的 `src/styles/app.css` 要用 `@source` 显式声明插件 `src` 与 `../../packages/ui` 两个范围。
- 可能超 200 行的列表用虚拟滚动（`@launcher/ui/virtual`）；敏感数据（密钥、验证码）默认不落明文。
- 危险操作（写系统文件 / 提权）**不接受调用方传入的目标路径**（参考 `host-manager/src/lib.rs`）。

## 知识资产

| 位置 | 装什么 |
|---|---|
| `docs/plugin-dev-guide.md` | 平台模型、命令形态、产物契约、脚本协议、踩坑复盘 |
| `.codebuddy/rules/chassis-plugin/RULE.mdc` | 不遵守就一定出错的硬约束（alwaysApply，本地不入库） |
| `.codebuddy/skills/chassis-plugin-dev/` | 新建/改造 Vue 插件的操作流程 + 模板 + 排障 |

## 边界

- 这里的「预置」指**出厂预装**，用户仍可在设置里禁用/卸载；只有 `internal-*` 不可卸载。
- 插件不享受底座内部特权：`ctx.settings` 只注入 `internal-*` 插件。
- 规范真源在仓库根的 `docs/plugin-spec.md`；`spec-check` 是它 §13 检查清单的可执行化。
- **host-manager 旧备份未迁移**：历史版本把备份放在安装目录的 `data/backups`；只有「手工把旧插件目录拷进底座」才会两者共存 —— 旧备份仍留在磁盘、不再列出。迁移涉及可提权写路径，留待单独处理。
