# 出厂插件（plugins/）

出厂**预装**的 8 个插件。内核一视同仁：同一份「出厂 bundle」、可禁用、可卸载
（只有 `internal-*` 属管理面不可卸载），产物形态与 `docs/plugin-spec.md` 完全一致。

| 插件 | 命令 | 工具链 |
|---|---|---|
| `app-launcher` | `search`（script，贡献型） + `refresh`（no-view） | esbuild |
| `file-search` | `search`（script，贡献型） | esbuild |
| `web-open` | `web`（script，贡献型） | esbuild |
| `internal-settings` | `settings` + `manage`（view） | esbuild |
| `totp` | `totp`（view） + `read-image`（script） | Vite + Vue |
| `host-manager` | `hosts`（view） + `hosts-read` / `hosts-write`（script） | Vite + Vue |
| `text-diff` | `diff`（view） | Vite + Vue |
| `json-tools` | `json`（view） | Vite + Vue |

## 两套工具链

| | 内置（esbuild 工具链） | Vue 插件 |
|---|---|---|
| 工具链 | `scripts/build-plugin.mjs`（esbuild，无框架） | 各自的 Vite + Vue 3 + Tailwind v4 工程 |
| 清单 | 手写 `package.json` 精简字段 | 构建期由 `scripts/lib/manifest-plugin.mjs` 裁剪写入 `dist/package.json` |
| 宿主调用 | 直连 `@launcher/api` / `@launcher/api-node` | 同左 |
| 共享代码 | 无（各自独立） | `@launcher/ui`（工作区包，`packages/ui/`）：UI 积木 + 前端工具（构建期打进各自产物） |
| 构建驱动 | 根 `scripts/build-all.mjs` 按 `package.json` 的 `build:view` / `build:scripts` 驱动 | 同左 |

> 4 个 Vue 插件 2026-09-16 搬进本目录：与内置插件同出厂流程，
> 但保留自己的 Vite + Vue 工具链，并直连底座 SDK（`@launcher/api` / `@launcher/api-node`）。
> 插件 id 简化为 `totp` / `text-diff` / `json-tools`；hosts 后来改名为 `host-manager`。
> 旧数据目录与历史 / 固定项由内核首次加载时接手，**改名链**（`sofast-hosts` → `hosts` → `host-manager`）
> 见 `apps/kernel/src/legacy.ts` 的 `RENAME_CHAINS`。

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

- 产物 `dist/` 就是插件目录：`index.html` + `assets/` + `package.json`（+ script 命令的 `<name>.mjs`）。
  打包进 `.app` 时由 `scripts/lib/resources.mjs` 拷进 `Resources/builtin-plugins/`（每个插件一份）。
- **可变数据只写 `ctx().dataPath`**（N2）：即 `<dataRoot>/plugins/<id>/`。
  `pluginPath` 是只读安装目录，写它会被 `spec-check` 拦下。
- 插件改过 id 时，底座首次加载会把旧数据目录整体复制到新 id 下（只复制不删除）。

## Vue 插件的开发要点

### 命令形态决定工程形态

- `view` —— 渲染在 **iframe** 里的静态页，入口固定为插件根的 `index.html`。一个插件可以有多个 view 命令，
  它们**共用同一个 index.html**，靠 URL 上的 `?sid=&cmd=&theme=` 区分会话与命令。
- `no-view` / `script` —— 跑在 **Node Worker** 里的 `.mjs`，入口是 `dist/<name>.mjs`，
  **`commands[].name` 必须与产物文件名逐字相同**（N1）。区别只在 `script` 不出现在命令面板、只能被 `exec.run` 调用。
- 关键推论：**iframe 受浏览器沙箱限制，读不了本地文件路径**。凡是「按路径读写磁盘」的需求一律落到 `script`
  命令上（`totp` 的 `read-image` 就是为此存在），并配好 UI 侧的手工兜底路径。

### 构建管线（三段，顺序不能反）

1. `vue-tsc --noEmit` 类型检查；
2. `vite build`（UI，`emptyOutDir: true`）；
3. 有 script 命令的插件再跑 worker 构建（**`emptyOutDir: false`**，否则会把第 2 步的产物连 `index.html` 一起删掉；
   `external: ['worker_threads', /^node:.*/]`，`entryFileNames: '[name].mjs'`）。

`scripts/lib/manifest-plugin.mjs` 挂在 `writeBundle`，把 `package.json` 裁剪成宿主需要的字段写进
`dist/package.json` —— 于是 **`dist/` 本身就是一个可直接安装的插件目录**。

### 宿主调用：直连 SDK

```ts
import { exec, host, hostUi, screenshot, storage } from '@launcher/api'        // view 侧
import { ctx, done, fail, log, onError, progress } from '@launcher/api-node'   // script 侧
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
- 清单**必须**带 `apiVersion: "1"` 与 `capabilities`（只声明真正用到的）。
- `commands[].name` 对 `no-view`/`script` 必须等于 `dist/<name>.mjs`。
- 有**多个** script 入口时**逐入口各构建一次**（`host-manager/scripts/build-no-view.mjs`）：Rollup 多入口会把
  共用模块拆成 `dist/assets/*.mjs`，入口里只剩一条相对 import，宿主只认 `dist/<name>.mjs`。
  构建后 `grep -h '^import' dist/*.mjs` 应只见 `node:*` 与 `worker_threads`。
- `vite.config.ts` 必须 `base: './'`，**不要开 `manualChunks`**。
- `@launcher/ui` 是工作区包，走标准解析 —— **不需要**再配 Vite alias / TS paths。`vite.config.ts` 里
  `pluginAliases(root)` 只为 `vue` 去重（保证 SFC 与插件代码共用一个运行时），`devFsAllow(root)` 让 dev server 能读 `packages/ui`。
- Tailwind v4 不会跨界扫描：每个插件的 `src/styles/app.css` 要用 `@source` 显式声明插件 `src` 与 `../../packages/ui` 两个范围。
- 可能超 200 行的列表用虚拟滚动（`@launcher/ui/virtual`）；敏感数据（密钥、验证码）默认不落明文。
- 危险操作（写系统文件 / 提权）**不接受调用方传入的目标路径**（参考 `host-manager/src/no-view/_hosts-file.ts`）。

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
