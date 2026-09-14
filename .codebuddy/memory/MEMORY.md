# Chassis / Launcher 长期记忆

## 项目定位

**ZTools 形态的启动台底座**：全局热键唤出、输入即搜、结果支持最近使用 + 已固定。

- 技术栈：**Tauri 2（Rust 壳，只提供系统原语）+ Node 22 sidecar（TS 内核）+ Vue 3 + Vite + Tailwind v4（启动台 UI）**
- 包管理：pnpm workspace（`apps/*`、`packages/*`、`plugins/*`、`tests/fixtures/*`）
- 需求源：`docs/launcher-requirements.md`（唯一）；对外契约：`docs/plugin-spec.md`

**三铁律**：
1. **底座零能力** —— 内核里不出现任何具体能力（扫描应用/读文件/连网），全部以插件集成（含"启动应用"本身）
2. **出厂自带 ≠ 内核内嵌** —— 官方插件走同一套插件机制，可禁用可卸载（仅管理面除外）
3. **能力即权限** —— 未声明的 capability 在装配期就不挂载，插件侧表现为"方法不存在"

## 架构要点

- **ADR-0001**：内核托管 UI 静态资源（`http://127.0.0.1:<uiPort>`），UI ↔ 内核走 HTTP `/api/*` + SSE `/api/events`；壳不代理 UI 流量
- **ADR-0002**：贡献型搜索两种载体 —— `script` 命令走**常驻搜索 worker**（懒启动、空闲 5min 回收、激活后延迟 800ms 预热），`view` 命令走活跃会话 postMessage
- **ADR-0003**：`ctx.settings`（管理面特权）只注入 id 以 `internal-` 开头的插件
- 壳 ↔ 内核：stdio + newline JSON-RPC 2.0；**协议只走 stdout/stdin，内核日志一律 stderr**
- 每插件一个 HTTP listener（`listen(0,'127.0.0.1')` 读回端口）⇒ 独立 origin ⇒ localStorage/IndexedDB 天然隔离
- 桥的三重校验：`event.source === iframe.contentWindow` + `origin`（在 UI 侧）+ `sid/token`（在内核侧）
- 执行管线：`invoke → resolve → pre-execute → execute → post-execute → ActionResult`，中间件由插件注册
- 搜索打分：`0.55*match + 0.30*recency + 0.15*frequency`；插件自评 `0.6*pluginScore + 0.4*kernelScore`

## 目录约定

| 路径 | 说明 |
|---|---|
| `apps/shell/` | Rust 壳：`lib.rs`（装配/窗口/事件）、`ipc.rs`、`sidecar.rs`、`primitives/*` |
| `apps/kernel/src/` | `kernel.ts`（装配）、`api.ts`（HTTP 路由）、`plugin.ts`（生命周期）、`search.ts`… |
| `apps/launcher-ui/src/` | `App.vue` 是主控（键盘/分组/执行），`components/*`，`stores/{data,ui}.ts` |
| `packages/plugin-manifest` | 清单类型 + 校验 + **契约类型**（内核/UI/SDK 共用） |
| `packages/plugin-api` / `plugin-api-node` | 插件页 SDK / 脚本 SDK |
| `plugins/*` | 出厂插件：app-launcher、file-search、web-open、internal-settings（internal） |
| `tests/{unit,contract,smoke}` | 单元 / 契约（echo-plugin）/ 验收（§1.3 口径） |
| `presets/` | 预置插件：sofast-{totp,hosts,text-diff,json-tools} + 共用适配层 `shared/` + 独立脚手架 `scripts/`（pnpm workspace 成员，工具链是 Vite + Vue） |

## 关键规则（改代码必看）

1. **插件根识别**：`<dir>/dist/package.json` 存在 ⇒ 插件根 = `<dir>/dist`；否则 `<dir>`。`scan()` 与 `installFromDirectory()` 必须一致。
2. **脚本产物必须自包含**：`build-plugin.mjs` 会校验产物只出现 `node:*` 的 import/require。任何内部用运行时 `require` 的依赖（如 `simple-plist`）都不能进插件。
3. **契约测试跑法**：`scripts/run-ts.mjs` 用 esbuild **bundle**（不能 `packages:'external'`）到 `.dev/`，workspace 包才会被解析。
4. **冒烟要用新构建的产物**：`node scripts/build-all.mjs && node scripts/smoke-real.mjs`。
5. 数据布局：`<dataRoot>/config.json`、`history.json`、`pinned.json`、`extensions/<id>/`、`plugins/<id>/`（插件唯一可写处）、`logs/audit-YYYY-MM-DD.jsonl`（滚动 7 天）。`dataRoot = ~/Library/Application Support/Launcher`，可用 `LAUNCHER_DATA_ROOT` 覆盖。
6. **图标只改 SVG 源**：`apps/shell/icons/{icon,tray}.svg` 是唯一真相，位图由 `npm run icon` 重新生成（超椭圆圆角 + 蓝→靛→紫渐变）。
   - **两个字形刻意不同**：应用图标 = 「输入框」（胶囊外框 + 光标 + 上箭头）；菜单栏 = **黑色放大镜**（18pt 下输入框内里会糊，用户明确要求放大镜）。
   - 菜单栏图标必须是**单色模板图**（`tray.png` + `icon_as_template(true)`），塞彩色应用图标是错的。
   - `tray-icon` 把整图高度钳到 18pt、宽度按比例算 ⇒ 画布长宽比决定占多宽。放大镜是方形，正好 18×18pt。
   - `tray.png` 走 `include_bytes!` 编译进二进制，换图标后**必须重编壳**（`npm run app:local` 会带上）。
   - 输入框的光标/箭头要按**描边中线框**定位，不能按外框宽度 —— 否则胶囊变窄时会贴到边框上糊成一体。
7. 改了 `.icns` 必须重跑 `npm run app:local` 并让 `lsregister -f` 刷新缓存，否则 Dock 一直显示旧图标。
8. **窗口显隐的裁决者只有壳一处**。壳完成显示/隐藏后通知内核 `window/toggled {visible}`，内核只 `emit('shell/visibility')` 广播，**绝不自己再 toggle**。两边都做一遍 = 一次热键被 toggle 两遍（壳显示、内核立刻隐藏），表现是"按热键窗口闪一下就消失、托盘却正常"。改这块前先看 `tests/contract/shell-link.test.ts`。
9. **跨进程的同一件事必须有唯一裁决者**，对端只收结果。用"延迟/防抖"补丁掩盖重复执行只会浪费时间。
10. **插件侧判断"我在哪个宿主里"必须探活，不能只看参数**：如快的 `inSofastIframe()`（`window.top !== window`）与底座的 `isLauncher()`（iframe + `?sid=`）在对方宿主里同样为真。适配层的做法是两个只读探针并发（`host.info` / `Context.getSearchContent`），300ms 内谁先应答就是谁，都没应答按"没有宿主"降级。
11. **桥的平铺旧信封是重复投递**：`@launcher/api` 每次调用同时发原生（`__launcher:1`）与平铺两条；平铺那条内核不认（`NOT_FOUND`）却会记一条失败审计。UI 侧按同一 id 丢弃副本，原生信封是唯一裁决者（`apps/launcher-ui/src/lib/bridge-calls.ts`）。
12. **v1 底座在 view 会话打开时没有搜索框**（插件页占满窗口）⇒ `hostUi.watchSearchContent` 不会触发；入口型插件只能用 `hostUi.getSearchContent()` 取初始输入。footer 的 `keys` 也只展示、不派发。
13. **出厂插件有两个来源目录**：`plugins/`（内置，esbuild 工具链）+ `presets/`（预置，Vite+Vue 工具链）。运行期是同一份出厂 bundle：内核 `--builtin-plugins` 接受**逗号分隔的多目录**（默认 `plugins/` + `presets/`），壳的开发态回退也拼两个路径，`scripts/lib/resources.mjs` 打包时合并进 `Resources/builtin-plugins/`。改「出厂插件」相关逻辑时别只想到 `plugins/`。
14. **预置插件的依赖走工作区**：`@launcher/api` 是 `packages/plugin-api`（`workspace:*`），`shared/lib/platform.ts` 在插件目录之外，所以 `vue` / `@sofastapp/api` / `@launcher/api` 都要在 `presets/scripts/vite-shared.mjs` 里做别名、在插件 `tsconfig.paths` 里做映射 ——**两处必须同时改**。`pnpm typecheck` 对含 `.vue` 的包自动改用该包自己的 `vue-tsc`。

## 可复用代码来源

- **ZTools（MIT，Copyright (c) 2025 lzx8589561）**：macOS 扫描/本地化名称解析移植进 `plugins/app-launcher/src/core/scanner.ts`；`pLimit` → `apps/kernel/src/util/limit.ts`；`assertSafePathPart` → `apps/kernel/src/util/fsx.ts`。详见 `docs/THIRD-PARTY.md`。
- 依赖选型对齐 ZTools：`pinyin-pro`、`chokidar`、`adm-zip`。
- 参考未引入（仅设计对照）：rubick、rustcast、magpie（均 MIT）。

## 常用命令

```bash
node scripts/run-tsc.mjs     # 14 个包类型检查（vue 工程自动用各自 vue-tsc）
node scripts/run-tests.mjs   # 19 个测试文件（unit/contract/smoke + presets）
node scripts/build-all.mjs   # kernel + ui + plugins + presets
node scripts/smoke-real.mjs  # 真内核 + 出厂 8 个插件冒烟
npm run smoke:first-batch    # 预置插件端到端（HTTP 驱动，不起壳）
node presets/scripts/spec-check.mjs  # 预置插件规范自检
node scripts/make-icon.mjs   # 生成图标（需 rsvg-convert：brew install librsvg）
npm run app:local            # 打包自用版 .app
cd apps/shell && cargo check # 壳
node scripts/build-shell.mjs # 打包 .app/.dmg（M4）
```

## 当前状态（2026-09-14）

M0–M3 代码完成且验证通过。**用户定位：自用**（不分发）。

- **M4 只保留自用版**：`npm run app:local` → `dist-app/Launcher.app`（cargo release + 手工组装 + ad-hoc 签名）。**不做**公证 / updater / CI / dmg。
- 自用必知：Apple Silicon 上未签名可执行文件会被内核杀掉 ⇒ **必须 ad-hoc 签名**；本地构建的 .app 无 quarantine，不需要 Apple Developer 证书。
- `.app` 不内嵌 Node（5.9MB），依赖系统 Node；`sidecar.rs::node_binary()` 搜索 homebrew/usr-local/nvm/fnm/volta/asdf，可用 `LAUNCHER_NODE` 覆盖。
**首批插件（2026-09-14 完成，见 `docs/first-batch-plugins.md` §9）**：4 个 sofast 插件改造为双宿主（适配层 `presets/shared/lib/{platform,host-adapter,host-calls,host-node}.ts`），底座侧补了旧数据迁移接线（`plugin.ts`）与桥双信封去重（`launcher-ui/src/lib/bridge-calls.ts`）。同日把插件**搬进本仓库** `presets/` 作为预置插件（`presets/README.md` 有定位与命令）；`npm run smoke:first-batch` 端到端 20 项全绿。

### 预置插件（presets/）常用入口

```bash
pnpm build:presets                  # 构建四个预置插件（= node scripts/build-all.mjs presets）
pnpm presets:check                  # spec-check：清单/N1/N2/N3/产物/远程资源
pnpm presets:pack                   # 构建并打 zip 到 presets/release/（如快安装用）
node scripts/smoke-first-batch.mjs  # 预置插件在真底座上端到端
```

- 预置插件是 pnpm workspace 成员（`presets/sofast-*`），依赖由根 `pnpm install` 统一装；**不再有**「找不到底座 SDK 就退 stub」的机制（`launcher-sdk.mjs` / `launcher-api-stub.ts` / 手写类型声明都已删除）。
- 原独立仓库 `~/Documents/Coding/SofastPlugins` **已搬空、未删除**（历史副本，可自行清理）；它的 CODEBUDDY.md / 开发手册 / 规则 / 技能已随插件搬进 `presets/`。

- 明确的缺口：`packages/plugin-cli`（脚手架/pack/spec-check）未做、如快 Sofast 的 **method 名映射**（`Context.*` → `ctx.hostUi.*`）未做（改用适配层包装 SDK，规范 §11 的双协议只到信封层）、Playwright E2E 未做、zip 安装零测试、1 万条历史性能未测、提权确认中间件未实现、hosts 旧备份目录迁移未做。
