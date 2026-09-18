# 插件开发手册（view 层 Vue / 逻辑层 Rust）

> 面向本仓库 `plugins/` 下的出厂插件（view 层是 Vite + Vue；**v2 起逻辑层是 Rust**，见下方迁移说明）。
> **平台模型（命令形态、产物契约、脚本协议、踩坑）适用于任何底座插件。**
> 状态：现行（与 `plugins/` 下的插件同步维护）｜ 最后更新：2026-09-17
> 快速上手看 [`../.codebuddy/skills/chassis-plugin-dev/SKILL.md`](../.codebuddy/skills/chassis-plugin-dev/SKILL.md)，硬约束看 [`../.codebuddy/rules/chassis-plugin/RULE.mdc`](../.codebuddy/rules/chassis-plugin/RULE.mdc)

> **⚠️ M5（v2）已完成迁移：逻辑层全部 Rust 化（2026-09-17）**
>
> 本手册下半部分描述的**平台模型没有变**（命令形态、产物契约、脚本协议、安全边界、数据目录 N2）；
> 变的是**逻辑层的语言与产物形态**：
>
> | | v1（本手册中的旧示例） | v2（现行） |
> |---|---|---|
> | 逻辑层 | TypeScript `src/no-view/*.ts` → esbuild → `dist/<name>.mjs` | **Rust** crate（`Cargo.toml` 在插件目录根，源码直接放同目录 `src/`）→ `dist/<name>`（可执行文件） |
> | 清单 | `apiVersion: "1"` | **`apiVersion: "2"`** |
> | 宿主通信 | Node worker（`worker_threads` / `parentPort`） | **子进程 + NDJSON**（`launcher-plugin-sdk`） |
> | 构建 | `node scripts/build-plugin.mjs <id>` | `cargo build --release -p launcher-plugin-<id> && node scripts/build-plugin.mjs <id> --copy-scripts` |
> | view 层 | Vue + Vite | **同左（不变）** |
>
> - 读代码从简到繁：`plugins/web-open/src/`（最小）→ `file-search`（两个入口 + 外部命令）→
>   `host-manager`（提权写系统文件）→ `totp`（读图转 base64）→ `app-launcher`（并发扫描 + 本地化 + 图标缓存）。
> - 带 view 的插件：`build:view` 走 vite、`build:scripts` 走 cargo + `--copy-scripts --keep-dist`（合并进同一 `dist/`）。
> - 权威规格：`plugin-spec.md` §2.2 / §4.2–4.4 / §11；迁移背景：`decisions/ADR-0005-kernel-language.md`。
> - 收益：**机器上不再需要 Node**（内核与插件都是原生产物）。

---

## 0. TL;DR

```bash
pnpm install                    # 仓库根：插件是 pnpm workspace 成员，不单独 install
pnpm --filter <name> dev        # 本地开发（浏览器可直接访问，宿主 API 走降级分支）
pnpm build:plugins              # 构建全部插件；产物在各插件 dist/，那就是插件目录
pnpm spec-check                 # 发布前自检（清单 / 产物 / 能力 / 数据目录 / 远程资源）
pnpm pack:plugins               # 打 zip 到 plugins/release/
```

安装：把 `dist/` 放进 `<dataRoot>/extensions/<插件名>`（设置页「插件管理」也能装），搜 `commands[].title`。

---

## 1. 平台模型

### 1.1 三种命令形态

| | `view` | `no-view` | `script` |
|---|---|---|---|
| 界面 | 有，渲染在 **iframe** | 无 | 无 |
| 运行环境 | 宿主本地 HTTP 托管的静态页 | **Rust 子进程**（`spawn` + NDJSON） | **Rust 子进程**（同左） |
| 出现在命令面板 | ✅ | ✅ | ❌（只能被 `exec.run` 调用） |
| 入口 | 插件根目录 `index.html`（固定，无需声明） | `dist/<name>`（可执行产物；Windows `<name>.exe`） | 同左 |
| 典型用途 | UI 交互 | 用户主动触发的后台任务 | 「View 的后端函数」，读写文件、调系统命令 |
| 依赖包 | `@launcher/api` | `launcher-plugin-sdk`（Rust，crate `launcher_plugin_sdk`） | 同左 |

宿主查找逻辑层产物的顺序：`<pluginRoot>/dist/<name>(.exe)` → `<pluginRoot>/dist/workers/<name>(.exe)`（ADR-0005：`.mjs` 不再支持）。
**`commands[].name` 必须与产物文件名一致。**

一个插件可以有多个 `view` 命令，它们**共用同一个 `index.html`**，靠 URL 上的 `?cmd=` 区分。

### 1.2 清单（`package.json`）

```jsonc
{
  "name": "my-plugin",          // 插件标识
  "title": "我的插件",           // 展示名
  "author": "...",
  "version": "0.1.0",
  "type": "module",             // 必须，ESM
  "description": "...",
  "categories": ["tool"],
  "apiVersion": "2",            // 必填：有 no-view/script 命令必须 "2"（可执行产物）
  "capabilities": ["storage"],  // 必填：可以是空数组；用户可逐项拒绝
  "commands": [
    { "name": "hello", "title": "打个招呼", "mode": "view", "searchable": true, "placeholder": "输入内容后回车" },
    { "name": "hello-job", "title": "后台任务", "mode": "no-view" },
    { "name": "read-file", "title": "读取文件（脚本）", "mode": "script" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `apiVersion` | 必填；内核接受 `"1"` / `"2"`，**有 no-view/script 命令必须 `"2"`**（v1 逻辑层 `.mjs` 已不支持），缺省或未知值一律拒绝加载 |
| `capabilities` | 必填（可空数组）；权限清单，用户可拒绝 → 对应服务不挂载 |
| `commands[].name` | 命令标识；No-View/Script 用它对应产物文件名（`dist/<name>`，Windows `.exe`） |
| `commands[].title` | 命令面板里显示的名字 |
| `commands[].mode` | `view` / `no-view` / `script`（官方说明 `background` 未来支持） |
| `commands[].searchable` | 是否参与全局搜索（只对 view / no-view 有意义） |
| `commands[].placeholder` | `searchable: true` 时搜索框里的提示文案 |
| `platforms` | 可选；支持的操作系统白名单 `["macos" \| "windows" \| "linux"]`，**省略 = 全平台** |
| `arch` | 可选；支持的 CPU 架构白名单 `["x64" \| "arm64"]`，**省略 = 不限制** |

**只在一个平台上能跑的插件请务必声明 `platforms`**：内核在扫描期就把它整包跳过（不注册命令、不进设置页），
用户不会看到"点开没反应"的插件；安装（拖目录 / zip）时也会直接报 `PLATFORM_MISMATCH`。
写法注意：这里的取值是 `macos` / `windows`（照 Rust `target_os` 写），**不是** `host.info().platform` 的 `darwin` / `win32`。
详见 plugin-spec §3.5。

发布时 `dist/package.json` 会被宿主直接读取，**只保留上面这些字段就够**（本仓库的构建会自动剔除 `scripts` / `devDependencies` 等）。

### 1.3 运行时环境

- **iframe 会话**：宿主按命令起一个会话，加载 `index.html?sid=<sessionId>&cmd=<command>`。
  需要时读 `new URLSearchParams(location.search)`。
- **主题**：宿主可能透传 `?theme=` 或在文档上设 `data-theme`；否则跟随 `prefers-color-scheme`。建议三级探测（见 `@launcher/ui/theme`）。
- **本地存储**：插件私有的键值存储，落盘在 `<dataRoot>/plugins/<id>/storage.json`（P7：数据与代码分离），**明文 JSON**，只支持可序列化值。
- **网络**：插件是本地静态页，可以联网，但把密钥类数据发出去等于自曝 —— 本仓库八个插件都不联网（totp 的扫码识别用随包 wasm，不请求 CDN）。

---

## 2. API 速查（`@launcher/api`）

> 权威定义在 `packages/plugin-api/src/index.ts`（view 侧）/ `packages/plugin-sdk-rs/src/`（逻辑层 Rust SDK），
> 能力与错误码见 `docs/plugin-spec.md` §8。

### 2.1 UI 侧（`import { clipboard, commands, exec, host, hostUi, screenshot, searchResult, storage } from '@launcher/api'`）

```ts
// 宿主探活与能力（isLauncher 是同步的）
host.isLauncher(): boolean
await host.info(): Promise<HostInfo>        // { apiVersion, capabilities, ... }；同时决定能力门控
host.capabilities(): string[]               // 当前会话实际被授予的能力

// 搜索框内容（入口型插件）
await hostUi.getSearchContent(): Promise<string>
await hostUi.setSearchContent(v: string): Promise<boolean>
await hostUi.clearSearchContent(): Promise<boolean>
hostUi.watchSearchContent(cb): () => void   // 返回取消函数
await hostUi.hide(): Promise<void>

// 底部操作栏（仅 UI 环境）
await hostUi.setFooter(buttons: FooterButton[]): Promise<boolean>
//   { type:'button', id?, label, icon, keys?, onClick? }
//   { type:'action-panel', id?, label, keys?, title?, items:[{ id?, name, icon?, onSelect? }] }

// 插件私有存储（与脚本侧同一份数据）
await storage.get<T>(key): Promise<T | undefined>
await storage.set(key, value): Promise<void>
await storage.remove(key): Promise<void>
await storage.all<T>(): Promise<T>
await storage.clear(): Promise<void>

// 调用同插件的 script 命令：返回值 = 脚本里 done(x) 的 x
await exec.run<T>({ command, args }, { timeoutMs }): Promise<T>

// 截图（只返回是否触发成功，拿不到图片数据）/ 快捷链接 / 剪贴板
await screenshot.start(): Promise<boolean>
await quicklink.all() / add(info) / edit(id, info) / remove(id)
await clipboard.readText() / writeText(text)

// 贡献型搜索的增量写入
await searchResult.set(items, token) / append(items, token) / clear(token)

// 命令与关闭
await commands.invoke({ command, args }) / commands.close()
```

所有调用在失败时以 `LauncherError` 拒绝（`NOT_FOUND` / `TIMEOUT` / `CAPABILITY_DENIED` / `INTERNAL`）。

### 2.2 逻辑层（`no-view` / `script`）

v2（M5 起，Rust SDK `launcher-plugin-sdk`；完整协议与 SDK 用法见 `plugin-spec` §4.4 与本手册 §7）：

```rust
fn main() {
    launcher_plugin_sdk::run(|ctx| {
        let args = ctx.args::<MyArgs>()?;          // 来自调用方 exec.run({ command, args })
        ctx.log("开始", json!({ "k": 1 }), Level::Info);
        ctx.progress(0.5, json!(null));
        ctx.done(json!({ "ok": true }))?;          // 正常结束并把 result 交给调用方
        Ok(())
    });
}
```

- `ctx.settings` 是**生效设置快照**（启动时冻结，改设置会重载插件）；`ctx.data_path` 是唯一可写目录，`ctx.plugin_path` 只读。
- `ctx.on_query(fn)` 用于贡献型搜索（`contributes: true`）；`ctx.storage.*` 走 RPC，与 UI 侧同一份数据（`<dataRoot>/plugins/<id>/storage.json`）。
- panic 由 SDK 转 `fail`（v1 的 `onError()` 需显式调用）。

v1（过渡期，`@launcher/api-node`）：

```ts
onError()                                   // 先注册，兜住未处理异常
const { command, args, pluginPath, dataPath, pluginId, mode } = ctx()
log(message, data?, level?)                 // level: info|debug|warn|error
progress(p: 0~1, data?)
done(result)                                // 正常结束并把 result 交给调用方
fail(error)
await storage.get/set/remove/all/clear      // 与 UI 侧同一份数据
onQuery(fn)                                 // 贡献型搜索：清单里 contributes: true 时宿主常驻该 worker
```

`args` 来自调用方（`exec.run({ command, args })`）；**`dataPath` 是唯一可写目录**，`pluginPath` 只读。

### 2.3 IPC 实测协议（官方文档没写）

v1 用 `worker_threads` 直接拉起产物即可观察（本仓库对 `dist/read-image.mjs` 做过完整验证）；v2 是子进程 + NDJSON，同一批消息语义照搬：

| 调用 | v1（worker 消息） | v2（stdout 一行 JSON） |
|---|---|---|
| `log(msg, data)` | `{ type: 'log', level, message, data }` | 同 |
| `done(x)` | `{ type: 'result', data: x }` + `{ type: 'done' }` | 同（两行） |
| RPC | `postMessage({ type: 'rpc', id, method, params })` | 同 |

`ctx.exec.run()` 返回的就是 `data` 本身。想脱离宿主自测逻辑层产物：

```bash
# v2：直接跑产物（stdin 喂协议行，stdout 读结果）
echo '{"type":"query","token":1,"query":"dee"}' | ./dist/xxx --mode search --launcher-context "$CTX_B64"
# v1：new Worker('/abs/path/dist/xxx.mjs', { workerData: { command: 'xxx', args: {...}, pluginPath: '/tmp/plugin' } })
```

### 2.4 降级策略（必须做）

宿主不在时（浏览器里 `pnpm dev`），SDK 的请求会 **postMessage 出去但永远没人应答**，Promise 永久 pending。表现就是：插件白屏、卡在加载态。

**先用 `host.isLauncher()` 同步分流，再让每次调用都显式兜失败**：
- 不在宿主里：直接用本地实现（`localStorage` / 文件选择器），不发起宿主调用；
- 在宿主里：SDK 自带超时（`CallOptions.timeoutMs`），需要「失败即空值」就在调用点接 `.catch(() => null)`；
- `storage` 只在宿主里用，本地降级写 `localStorage`，避免两份数据互相覆盖。

### 2.5 逻辑层命令能做的事（能力边界）

- ✅ 读写任意本地文件、遍历目录、调用系统命令、访问网络（v1 是 Node 生态，v2 是 Rust 生态）
- ✅ 通过 `ctx.data_path` / `ctx().dataPath` 读写自己的数据目录（`pluginPath` 是只读安装目录）
- ❌ 不能弹 UI、不能长期驻留（一次性执行，`ctx.done` / `done()` 后结束）
- ⚠️ 能力越强越要自己收紧：本项目 `read-image` 只做「扫描白名单目录 + 扩展名白名单 + 文件头魔数校验 + 单文件 20MB 上限」
- ⚠️ 需要改系统文件（如 hosts）时：**目标路径绝不能来自调用方入参**，只认平台默认路径 —— 否则「能提权写文件」的脚本就成了任意文件写入的跳板；提权一律走系统自带对话框（macOS `osascript … with administrator privileges`、Windows `-Verb RunAs`、Linux `pkexec`），并且**写前备份、写后回读逐字节校验**，提权不可用时回落到「把待生效内容落盘 + 给用户一条可复制的命令」。完整范例见 `plugins/host-manager/src/lib.rs`（v1 为 `src/no-view/_hosts-file.ts`；它更进一步：调用方给的是**托管区文本**，写的一刻才读盘、只换标记之间那一段，区外那些行一个字节都不动）

---

## 3. 构建与发布

### 3.1 产物要求

```
dist/
├── index.html            # view 命令入口（固定名）
├── assets/*              # 静态资源
├── <command>             # 逻辑层产物（可执行文件；Windows 加 .exe），名字必须与 commands[].name 一致
└── package.json          # 插件清单（宿主读它注册命令）
```

### 3.2 Vite 配置要点（UI）

```ts
export default defineConfig({
  base: './',                       // 宿主用本地 HTTP 托管，相对路径最稳
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [/* vue() 或 react(), 以及构建后写清单的插件 */],
})
```

- **`base: './'`**：绝对路径 `/assets/x.js` 在宿主托管下大概率 404。
- **不要开 `manualChunks`**：产物被切成多个 chunk 时，宿主托管路径容易对不上。
- **构建后把 `package.json` 写进 dist**（本仓库 `scripts/lib/manifest-plugin.mjs` 会自动剔除无关字段）。
- 「一个命令一个 JS 入口」的 lib 模式是**旧模板**的玩法，新 API 不需要。

### 3.3 No-View / Script 的构建（v1 / TS，过渡期）

> v2（M5 起）逻辑层是 Rust：见 §7。以下 v1 写法在过渡期仍然有效（现有插件的 TS 产物），新插件不要再用。

必须用**独立的 worker 配置**，关键三条：

```ts
// vite.worker.config.ts
build: {
  outDir: 'dist',
  emptyOutDir: false,                        // ★ 绝不能清掉 UI 产物
  rollupOptions: {
    external: ['worker_threads', /^node:.*/], // ★ Node 内置模块保持 external
    input: discoverInputs(),                  // src/no-view/*.ts → 入口名 = 文件名
    output: { entryFileNames: '[name].mjs' }, // ★ 必须 .mjs 且与命令名一致
  },
}
```

`package.json` 里串起来：

```json
"build": "vue-tsc --noEmit && vite build && vite build --config vite.worker.config.ts"
```

> **v1 历史**：那时 `@launcher/api-node` 会被完整内联进 `.mjs`（约 9KB）。v2 逻辑层是 Rust 可执行产物，这条不再适用 ——
> 构建见 §7 / `plugins/README.md`（`cargo build --release` + `scripts/build-plugin.mjs --copy-scripts`）。

### 3.4 安装与调试

- 安装：`dist/` → `<dataRoot>/extensions/<插件名>`（或设置页「插件管理」安装），内核启动时扫描该目录。
- 开发：`pnpm dev` 起 Vite 服务器，浏览器直接访问即可调 UI；宿主相关能力走降级分支。
- 多插件共存：每个插件是独立工程，彼此的 `node_modules` 不互相提升；**要复用的代码走工作区包**（`@launcher/api` / `@launcher/ui`，逻辑层用 `launcher-plugin-sdk`），别用相对路径跨插件 import。

---

## 4. 本仓库脚手架约定

### 4.1 结构

```
<底座仓库>/plugins/
├── <name>/       各自独立 Vite 工程（package.json / vite.config / tsconfig / index.html / src / test）
└── README.md     目录约定与发布流程

<底座仓库>/packages/ui/          @launcher/ui：设计令牌 + AppShell / UiIcon / UiDialog + lib 工具
<底座仓库>/scripts/              build-all.mjs / spec-check.mjs / pack-plugins.mjs（跨插件工具）
<底座仓库>/scripts/lib/          vite-plugin-vue.mjs（vue 去重别名）/ manifest-plugin.mjs（清单裁剪）
<底座仓库>/tsconfig.vue-plugin.json   Vue 插件工程的 tsconfig 基座
```

出厂插件都是底座仓库的 pnpm workspace 成员，依赖由仓库根的 `pnpm install` 统一装。

### 4.2 `@launcher/ui` 的解析

`@launcher/ui` 是工作区包（`packages/ui`），插件按 `"@launcher/ui": "workspace:*"` 依赖它 ——
Vite / TS 都走标准 node_modules 解析，**不需要 alias 或 paths**。两点仍要注意：

- **vue 去重**：包内 SFC 的 `import 'vue'` 必须解析到插件自己的 `node_modules/vue`（否则两份运行时）。
  `vite.config.ts` 里 `pluginAliases(root)` 就是干这个的，别删。
- **dev server**：`devFsAllow(root)` 把 `server.fs.allow` 放开到仓库根，dev 下才能读 `packages/ui`。

### 4.3 Tailwind v4 不会跨界扫描

用 `@source` 显式声明扫描范围，否则 `packages/ui` 里的 class 不会生成：

```css
@import "tailwindcss";
@import "../../../../packages/ui/styles/theme.css";
@source "../";
@source "../../../../packages/ui";
```

### 4.4 主题与设计令牌

`packages/ui/styles/theme.css`：`:root` / `[data-theme="dark"]` 两套 CSS 变量 → `@theme inline` 桥接成 Tailwind 工具类（`bg-panel` / `text-muted` / `border-line` …）。
视觉基调对齐宿主：8px 圆角、低饱和描边、`padding: 10px` 的行高、14px 正文。

动效同样有令牌，**不要自己写死时长和缓动**（与宿主 `apps/launcher-ui/src/styles/app.css` 同值同档，见 ADR-0004）：

| 令牌 | 用途 |
|---|---|
| `--launcher-motion-instant` / `-fast` / `-base` / `-slow` | 90 / 140 / 200 / 320ms 四档 |
| `--launcher-ease-enter` | 进场（强减速） |
| `--launcher-ease-exit` | 离场（加速，**一律比进场短**） |
| `--launcher-ease-move` | 位移与颜色 |
| `--launcher-ease-spring` | 只给"弹出"用（轻微过冲） |
| `--launcher-scroll-thumb` / `-hover` / `-active` | 滚动条滑块三态（几何写死在 `theme.css` 末尾的 `::-webkit-scrollbar` 块：10px 轨道、6px 滑块） |

`prefers-reduced-motion` 已在这套令牌里统一降级，插件侧不需要再写媒体查询。
现成可用的过渡类：`launcher-fade`（纯淡入淡出）、`launcher-toast`（上浮）、`launcher-mask` + `.launcher-dialog-pop`（模态遮罩与面板）。

### 4.5 复用件

| 引用 | 作用 |
|---|---|
| `@launcher/ui/virtual` | 定高虚拟滚动（diff 行 / JSON 树 / 账户列表共用） |
| `@launcher/ui/clipboard` | 复制三级兜底、剪贴板读图、文件选择、拖拽取文件、下载 |
| `@launcher/ui/keys` | `Mod` 跨平台判断、`isTypingTarget` |
| `@launcher/ui/theme` | 主题三级探测 + 切换 |
| `@launcher/ui/toast` | 轻提示（L1 反馈） |
| `@launcher/ui/UiIcon.vue` | 自绘图标集（零依赖，避免为 20 个图标引入整个图标库） |
| `@launcher/ui/UiDialog.vue` | 弹窗骨架（Esc 关闭、尺寸档位） |
| `@launcher/ui/AppShell.vue` | 页面骨架 + 轻提示 + 主题应用 |

宿主调用不在这张表里：**view 直连 `@launcher/api`、逻辑层直连 `launcher-plugin-sdk`**，没有中间适配层。

---

## 5. 踩坑清单

> 每条都是实际撞过的，按「现象 → 原因 → 对策」记录。

### 5.1 启动即卡死 / 一直转圈

- **现象**：插件在浏览器里打开永远停在加载态，`loading` 不置 false。
- **原因**：`storage.get()` 等宿主调用在无宿主环境下 Promise 永不 resolve。
- **对策**：先用 `host.isLauncher()` 分流；在宿主里用 SDK 自带超时 + `.catch(() => null)`，不在宿主里走本地实现。

### 5.2 `Screenshot.start()` 拿不到图片

- **现象**：想直接拿到截图数据解码，结果只返回 `boolean`。
- **原因**：API 只负责「触发宿主截图流程」，截图结果通常进系统剪贴板。
- **对策**：触发后延时读剪贴板 → 失败则提示用户 `⌘V` 粘贴；另备「选择图片 / 拖拽 / 本地路径」多条路。

### 5.3 View 插件读不了本地路径

- **现象**：给个 `/Users/x/Desktop/a.png` 没反应。
- **原因**：iframe 受浏览器沙箱限制，没有文件系统访问权。
- **对策**：用 `mode: "script"` 的逻辑层命令（Rust 子进程）读盘，转 base64 回传（本仓库 `plugins/totp/src/bin/read_image.rs`）。

### 5.4 逻辑层命令产物不生成 / 命令面板搜不到

- **原因（v2，现行）**：① 命令名与产物文件名不一致（大小写、连字符）；② `dist/<name>` 还是旧二进制（改了 Rust 没重跑 `npm run build:scripts`）；③ 根 `Cargo.toml` members 漏登记 `plugins/<id>`（`cargo build -p` 找不到包）；④ 清单 `apiVersion` 不是 `"2"`。
- **对策**：产物名 = 命令名；`npm run build:scripts`（或根 `pnpm build`）后跑 `pnpm spec-check`（会校验可执行位 + 二进制魔数）。
- **v1 历史**：worker 构建 `emptyOutDir` 误删 UI 产物 / 构建顺序反了 —— 见 §3.3 与 §5.17（仅历史参考）。

### 5.5 从 `packages/ui` import 报模块找不到

- **常见原因**：插件 `package.json` 忘了声明 `"@launcher/ui": "workspace:*"`（改完依赖要跑根目录 `pnpm install`）。
- **对策**：`@launcher/ui` 走标准解析，**不要**用 alias / paths 绕；dev 下读不到则是 `server.fs.allow` 没放开到仓库根。

### 5.6 Tailwind 类名不生效

- **原因**：class 写在 Tailwind 扫描范围之外（`packages/ui`）。
- **对策**：`@source` 显式声明。

### 5.7 产物 404 / 白屏

- **原因**：`base` 默认 `/`，宿主托管路径对不上。
- **对策**：`base: './'`，并且不要开 `manualChunks`。

### 5.8 大文件把界面卡死

- **原因**：解析 / 差分在主线程跑。
- **对策**：全部丢进 Web Worker（`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`），并准备主线程降级路径（CSP 或老 WebView 下 Worker 可能创建失败）。

### 5.9 长列表滚动掉帧

- **对策**：定高虚拟滚动。行高统一时不需要测量，`scrollTop / rowHeight` 反推区间即可（见 `packages/ui/lib/virtual.ts`）。

### 5.10 `JSON.parse` + `stringify` 丢精度

- **现象**：`12345678901234567890` 变成 `12345678901234567000`，`1e999` 变成 `null`。
- **对策**：手写词法扫描，数字只搬字节不解析；只有需要求值时才 parse。

### 5.11 树形结构的「连续区间」假设不成立

- **现象**：想用 `start/count` 表示子节点区间，展开后拿到错误的兄弟节点。
- **原因**：先序遍历下，嵌套容器的子节点会插在中间，**兄弟节点并不连续**。
- **对策**：改用「长子 + 兄弟链」（`firstChild` / `nextSibling`），或显式存 children 索引数组。

### 5.12 剪贴板 API 被拒

- **现象**：`navigator.clipboard.read()` 抛异常或返回空。
- **原因**：部分宿主 WebView 未授予 clipboard-read 权限。
- **对策**：① 读文本优先用 `paste` 事件里的 `clipboardData`（用户手势触发，不需要权限）；② 写用 `writeText` → `execCommand('copy')` 三级兜底；③ UI 上永远保留手工路径。

### 5.13 WASM 依赖

- **现象 ①**：非联网环境 / 离线打包后 wasm 加载失败。
  **对策**：`import wasmUrl from 'pkg/xxx.wasm?url'` 让构建把 wasm 打进 dist，再以 `wasmBinary` 形式喂给 Emscripten（顺带绕开 `instantiateStreaming` 的 MIME 检查）。
- **现象 ②**：`Aborted(CompileError: Refused to create a WebAssembly object because ... 'wasm-unsafe-eval' is not an allowed source of script ...)`。
  **原因**：宿主给插件页的 CSP `script-src` 没放行 wasm 编译。**对策**：内核已加 `'wasm-unsafe-eval'`（见 `apps/kernel/src/http/pluginServers.ts`）；换宿主 / 自建静态服务器时要带上它。

### 5.14 主题跟随宿主失败

- **原因**：iframe 与宿主可能跨源，宿主改不了 iframe 的 DOM。
- **对策**：`?theme=` → `document.documentElement.dataset.theme` → `prefers-color-scheme` 三级探测，用户手动切换后存本地。

### 5.15 用户在宿主搜索框里粘的内容读不到 / 用不上

- **技巧**：命令声明 `searchable: true`，插件启动时 `hostUi.getSearchContent()` 读一次，用完 `hostUi.clearSearchContent()`；再用 `hostUi.watchSearchContent()` 监听后续输入。这样「粘一条链接/密钥 → 回车 → 插件直接处理」的体验才成立。

### 5.16 清单字段拼写

- `categories` 这个字段容易被写成 `categroies`。不影响命令注册，但别拼错。

### 5.17 多个 script 入口被拆成多个文件，产物不再自包含

> **v1 历史**（`vite.worker.config.ts` + `.mjs` 时代）：v2 逻辑层是 Rust 可执行产物（一个 bin 天然自包含），本节问题已不存在，仅作历史参考。

- **现象**：插件里有 `hosts-read.ts` 和 `hosts-write.ts` 两个入口，构建后 `dist/` 里除两个 `.mjs` 之外还多出 `dist/assets/_hosts-file-xxx.mjs`，入口文件里只剩一条 `import './assets/…'`。
- **原因**：Rollup 在多入口模式下，**被两个入口共用的模块必须提取成共享 chunk**（否则就得把同一份代码复制两份，Rollup 不做这件事）。`output.manualChunks: undefined` 也拦不住，它不是用户配置能改的默认行为。
- **风险**：宿主只把 `dist/<name>.mjs` 当 Worker 入口拉起。这条跨文件相对 import 一旦因为「用户只拷了单个 `.mjs`」「打包时漏了 `assets/`」「宿主换了加载方式」而断掉，命令直接失效——而且报错发生在宿主侧，插件里根本看不见。单入口插件（只一个 script 命令）不会触发，所以很容易到第二个入口才踩到。
- **对策**：**逐入口各跑一次构建**，每个产物自包含。本仓库做法（`plugins/host-manager`）：
  - `vite.worker.config.ts` 用 `build.lib.entry` 指向**单个**入口，输出名由 `fileName` 固定，入口由环境变量 `PLUGIN_WORKER_ENTRY` 选择；
  - `plugins/host-manager/scripts/build-no-view.mjs` 扫一遍 `src/no-view/*.ts`，逐个 `execFileSync(vite, ['build', '--config', 'vite.worker.config.ts'])`，每次带上不同的环境变量；
  - `package.json` 的 `build` 末段改成 `node scripts/build-no-view.mjs`。
- **顺带**：Vite 的 `defineConfig` **不接受配置数组**，CLI 会直接报 `config must export or return an object`，所以「多配置」只能自己在脚本里循环调用。

### 5.18 调用宿主"点了没反应"（保存 / 删除按钮像挂了）

- **现象**：点按钮后界面毫无变化，也没有任何报错；宿主审计日志里**完全没有这次调用**（连失败记录都没有）。
- **原因**：参数里带了 Vue 的 `reactive` / `ref` 代理（Proxy）。`window.parent.postMessage` 按结构化克隆传输，**含 Proxy 的 payload 会抛 `DataCloneError`**，
  消息根本发不出去 —— SDK 侧只表现为"调用超时"。
- **对策**：SDK 已内置兜底（首发失败时 JSON 往返展平后重发一次，见 `packages/plugin-api` 的 `post()`）；
  插件侧仍建议在写库 / 提交前展开一层（`list.map((x) => ({ ...x }))`）或 `toRaw()`，并给写操作补 `try/catch + toast.err`，别让失败被静默吞掉。

### 5.19 插件页里按 `Esc` 没反应（或者该留的退了）

- **现象**：焦点在插件页里时按 `Esc`，宿主像没收到（退回不了启动台）；或插件自己画的弹层关了、页面也跟着退了一层。
- **原因**：iframe 是独立文档，宿主挂在顶层 window 上的键盘监听**收不到**插件页里的按键。`@launcher/api` 因此兜底：**没人消费**的 `Esc` 自动交还宿主（等价 `commands.close()`，见 plugin-spec §10.2）。
- **对策**：插件消费 `Esc`（关自己画的弹层 / 清空搜索框）时必须 `preventDefault()`（`stopPropagation()` 同样有效）——`UiDialog` / `UiSelect` 已经这么做了，自己叠面板时要照做。

### 5.20 倒计时环一轮转了两圈（CSS 动画的双时钟）

- **现象**：环的进度比真实时间快一倍 —— 30s 的 TOTP 周期，环走完两整圈；页面停留越久偏差越大。
- **原因**：动画自身的时钟也在走，而 `animation-delay` 表达的是「本时间步已过秒数」；每秒把 delay 往前推 1 秒 = 把同一秒算了**两遍**（动画位置 = 动画存活时长 + `|delay|`）。`CDP` 单点读 `delay`/`dashoffset` 会看着"自洽"，只有连续采样才能发现速度是 2 倍。
- **对策**：**一个时间源**。JS 每秒（对齐整秒）算目标 `stroke-dashoffset`，平滑交给 `transition: stroke-dashoffset 1s linear`；跨时间步那一帧要临时关掉过渡，否则「空 → 满」会被补间演成**倒转一整圈**（`plugins/totp/src/App.vue` 的 `ringOffset()` / `markStepReset()`）。

### 5.21 `shallowRef` 里的大文档原地改，界面「改了但没反应」

- **现象**：host-manager 里点「新建块」后左栏不出现新块；「收进块」弹窗的下拉里也选不到刚建的块（用户实测截图）。
- **原因**：文档是 `shallowRef`（几万行不能深度代理）+ **原地改**（`blocks.splice/push`），改动后只补了一个 `triggerRef(doc)`。
  但派生数据全是 `computed`，而 **computed 只在「它读到的那个引用变了」时才通知下游**：`blocks` 每次返回的还是同一个数组对象、
  `props.block` 还是同一个对象 ⇒ 「块列表 / 下拉选项 / 卡片里的条目列表」永远停在第一次求值的结果上。
  用 vue 响应式内核最小复现（`shallowRef` + `computed` + `push` + `triggerRef`）：下游始终收到 `[]`；换成新引用立刻收到新值。
- **对策**：**改动出口统一换新引用**。host-manager 把「原地改 + triggerRef」改成 `doc.value = { ...doc, blocks: doc.blocks.map((b) => ({ ...b })) }`
  （浅拷贝足够：行对象与行数组共享，不复制内容）。同文件的 `props.version` 只用来推子组件重渲染，**不能**替代引用变化。

---

## 6. 新增一个插件的检查清单

```
[ ] plugins/<name>/package.json：apiVersion + capabilities 必填，commands 齐全、mode 正确
[ ] package.json 提供 build:view / build:scripts（根 scripts/build-all.mjs 按这两条驱动）
[ ] vite.config.ts：base './'，outDir dist，构建后写清单
[ ] 有 no-view/script 命令时（v2）：插件根 `Cargo.toml` + 同目录 `src/*.rs` + 根 `Cargo.toml` members 登记；`apiVersion: "2"`；`build:scripts`（cargo build + `--copy-scripts`）与 `test:scripts`（cargo test），产物名 = 命令名（§7）
[ ] tsconfig.json：extends `../../tsconfig.vue-plugin.json`（走工作区包标准解析，不需要额外 paths）
[ ] src/styles/app.css：@import tailwindcss + theme.css，@source 覆盖 src 与 `../../packages/ui`
[ ] 宿主调用直接走 SDK：view 用 `@launcher/api`，逻辑层用 `launcher-plugin-sdk`（Rust）；view 侧先用 `host.isLauncher()` 分流、调用点兜失败
[ ] 大计算进 Worker、长列表虚拟滚动
[ ] pnpm build:plugins && pnpm spec-check 全绿：dist 里 index.html + assets + package.json + 可执行产物
[ ] 起静态服务器实机点一遍（不只是 dev server，prod 的资源路径不同）
[ ] 敏感数据：默认不落明文，或提供口令加密
```

---

## 7. Rust 逻辑层插件（v2）

> 适用：`no-view` / `script` 命令（M5 起）。协议权威定义见 `plugin-spec` §4.4；SDK 源码 `packages/plugin-sdk-rs`；决策背景见 `docs/decisions/ADR-0005-kernel-language.md`。

### 7.1 工程结构

```
plugins/<id>/
├── package.json
├── Cargo.toml              # 逻辑层 crate（crate 根 = 插件目录；[[bin]] name = <命令名>，一个命令一个 bin）
└── src/                    # 插件源码：Rust 逻辑层（main.rs / lib.rs / bin/*.rs）+ Vue 视图（有 view 命令时）
    ├── main.rs             # 入口：launcher_plugin_sdk::run
    ├── bin/<name>.rs       # 多命令时：一个命令一个 bin（[[bin]] path 指向这里）
    └── ...                 # 业务模块（与视图层共享的逻辑在这里写第二份时要用 fixture 向量守护，见 §7.4）
```

- crate 由**仓库根** `Cargo.toml` 的 workspace `members` 逐个列出（`plugins/<id>`）—— 新增逻辑层插件时加一行；产物统一落在仓库根 `target/`。
- 产物名 = `[[bin]].name` = `commands[].name`；`build:scripts` 把仓库根 `target/release/<bin>` 拷成 `dist/<name>`（0755）。

### 7.2 SDK 用法

```rust
use launcher_plugin_sdk::{json, Level, Mode};

#[derive(serde::Deserialize)]
struct Args { name: Option<String> }

fn main() {
    launcher_plugin_sdk::run(|ctx| {
        match ctx.mode {
            Mode::Run => {
                let args = ctx.args::<Args>()?;
                ctx.log("开始", json!({ "name": args.name }), Level::Info);
                ctx.progress(0.5, json!(null));
                ctx.done(json!({ "hello": args.name.unwrap_or_else(|| "world".into()) }))?;
            }
            Mode::Search => ctx.on_query(|query| {
                // 返回 ResultItem 数组（id 必须稳定，见 plugin-spec §9.3）
                Ok(vec![json!({ "id": format!("demo:{query}"), "title": query })])
            }),
        }
        Ok(())
    });
}
```

要点：

- `ctx.args::<T>()` 反序列化 `--launcher-context` 的 `args`；`ctx.settings_str("k")` 取生效设置。
- 结束必须 `ctx.done(x)` / `ctx.fail(e)`；`run` 是唯一入口，闭包返回 `Result<(), E>`。
- `ctx.storage.*` 走 RPC（`storage.get/set/remove/all/clear`）；`ctx.data_path()` 是唯一可写目录。
- panic 由 SDK 转 `fail`；但**别依赖 panic**做业务错误，用 `ctx.fail(e)` 并写清日志。

### 7.3 构建与打包

```json
"build:scripts": "cargo build --release -p <crate> && node ../../scripts/build-plugin.mjs <id> --copy-scripts"
```

- `scripts/build-plugin.mjs <id> --copy-scripts`：把仓库根 `target/release/<bin>` 复制为 `dist/<name>`（0755），并写入裁剪后的清单。
- 本机自测：`cargo test -p <crate>`；协议一致性用 `tests/fixtures/echo-plugin` 的双宿主对拍（`pnpm test`）。
- 跨平台产物必须在各自平台编译（CI 双 job）；`.exe` 只出现在 Windows 包内。

### 7.4 v1 → v2 迁移对照

| v1（TS / worker） | v2（Rust / 子进程） |
|---|---|
| `src/no-view/*.ts` → `dist/<name>.mjs` | `src/main.rs`（crate 根 = 插件目录）→ `dist/<name>`（可执行） |
| `import … from '@launcher/api-node'` | `use launcher_plugin_sdk::…` |
| `ctx()` | `ctx`（`ctx.args` / `ctx.settings` / `ctx.data_path()`） |
| `done(x)` / `fail(e)` / `log` / `progress` / `onQuery` / `storage` | `ctx.done(x)` / `ctx.fail(e)` / `ctx.log` / `ctx.progress` / `ctx.on_query` / `ctx.storage` |

## 8. 参考

- 规范与架构：`docs/plugin-spec.md`（对外契约）、`docs/architecture.md`（内核实现）、`plugins/README.md`（目录与构建）
- API 权威定义：`packages/plugin-api/src/index.ts`（UI 侧）、`packages/plugin-sdk-rs/src/`（逻辑层 v2；v1 的 `packages/plugin-api-node` 已删除）
- 现有范例：
  - `plugins/totp` —— view + script + 对话框 + 口令加密（`src/core/vault.ts`）
  - `plugins/host-manager` —— 提权写系统文件、只换自己的托管区、写前备份 + 写后回读校验
  - `plugins/text-diff` —— Web Worker 计算 + 主线程降级 + 虚拟滚动
  - `plugins/json-tools` —— 手写词法扫描（不丢数字精度）+ 树视图
- 本仓库四个真实插件：`plugins/totp`（含 script 命令）、`plugins/text-diff`（Worker + 虚拟滚动）、`plugins/json-tools`（无损解析 + 树视图）、`plugins/host-manager`（读盘 + 提权写入 + 托管区无损回写）
