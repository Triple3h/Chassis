# Vue 插件开发手册

> 面向本仓库 `plugins/{totp,hosts,text-diff,json-tools}` 四个 Vite + Vue 插件：宿主调用直连
> `@launcher/api`（view 侧）/ `@launcher/api-node`（script 侧）。
> **平台模型（命令形态、产物契约、脚本协议、踩坑）适用于任何底座插件。**
> 最后更新：2026-09-16
> 快速上手看 [`../.codebuddy/skills/chassis-plugin-dev/SKILL.md`](../.codebuddy/skills/chassis-plugin-dev/SKILL.md)，硬约束看 [`../.codebuddy/rules/chassis-plugin/RULE.mdc`](../.codebuddy/rules/chassis-plugin/RULE.mdc)

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
| 运行环境 | 宿主本地 HTTP 托管的静态页 | **Node Worker** | **Node Worker** |
| 出现在命令面板 | ✅ | ✅ | ❌（只能被 `Backend.run` 调用） |
| 入口 | 插件根目录 `index.html`（固定，无需声明） | `dist/<name>.mjs` | 同左 |
| 典型用途 | UI 交互 | 用户主动触发的后台任务 | 「View 的后端函数」，读写文件、调 SDK |
| 依赖包 | `@sofastapp/api` | `@sofastapp/api/node` | 同左 |

宿主查找 Node 入口的顺序：`<pluginRoot>/<command>.mjs` → `<command>.js` → `workers/<command>.mjs` → `workers/<command>.js`。
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
  "apiVersion": "1",            // 必填：当前只接受 "1"
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
| `apiVersion` | 必填；当前只接受 `"1"`，缺省或未知值一律拒绝加载 |
| `capabilities` | 必填（可空数组）；权限清单，用户可拒绝 → 对应服务不挂载 |
| `commands[].name` | 命令标识；No-View/Script 用它对应产物文件名 |
| `commands[].title` | 命令面板里显示的名字 |
| `commands[].mode` | `view` / `no-view` / `script`（官方说明 `background` 未来支持） |
| `commands[].searchable` | 是否参与全局搜索（只对 view / no-view 有意义） |
| `commands[].placeholder` | `searchable: true` 时搜索框里的提示文案 |

发布时 `dist/package.json` 会被宿主直接读取，**只保留上面这些字段就够**（本仓库的构建会自动剔除 `scripts` / `devDependencies` 等）。

### 1.3 运行时环境

- **iframe 会话**：宿主按命令起一个会话，加载 `index.html?sid=<sessionId>&cmd=<command>`。
  需要时读 `new URLSearchParams(location.search)`。
- **主题**：宿主可能透传 `?theme=` 或在文档上设 `data-theme`；否则跟随 `prefers-color-scheme`。建议三级探测（见 `shared/lib/theme.ts`）。
- **本地存储**：插件私有的键值存储，落盘在 `<dataRoot>/plugins/<id>/storage.json`（P7：数据与代码分离），**明文 JSON**，只支持可序列化值。
- **网络**：插件是本地静态页，可以联网，但把密钥类数据发出去等于自曝——本项目三个插件都刻意不联网。

---

## 2. API 速查（`@launcher/api`）

> 权威定义在 `packages/plugin-api/src/index.ts`（UI 侧）/ `packages/plugin-api-node/src/index.ts`（脚本侧），
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

### 2.2 Node 侧（`import { ctx, done, fail, log, onError, onQuery, progress, storage } from '@launcher/api-node'`）

```ts
onError()                                   // 先注册，兜住未处理异常
const { command, args, pluginPath, dataPath, pluginId, mode } = ctx()
log(message, data?, level?)                 // level: info|debug|warn|error
progress(p: 0~1, data?)
done(result)                                // 正常结束并把 result 交给调用方
fail(error)
await storage.get/set/remove/all/clear      // 与 UI 侧同一份数据（<dataRoot>/plugins/<id>/storage.json）
onQuery(fn)                                 // 贡献型搜索：清单里 contributes: true 时宿主常驻该 worker
```

`args` 来自调用方（`exec.run({ command, args })`）；**`dataPath` 是唯一可写目录**，`pluginPath` 只读。

### 2.3 IPC 实测协议（官方文档没写）

用 `worker_threads` 直接拉起产物即可观察，本仓库对 `dist/read-image.mjs` 做过完整验证：

| 调用 | 实际发出的消息 |
|---|---|
| `log(msg, data)` | `{ type: 'log', level, message, data }` |
| `done(x)` | `{ type: 'result', data: x }`，随后还有一条 `{ type: 'done' }` |

`Backend.run()` 返回的就是 `data` 本身。想脱离宿主自测脚本，用：

```js
new Worker('/abs/path/dist/xxx.mjs', { workerData: { command: 'xxx', args: {...}, pluginPath: '/tmp/plugin' } })
```

### 2.4 降级策略（必须做）

宿主不在时（浏览器里 `pnpm dev`），SDK 的请求会 **postMessage 出去但永远没人应答**，Promise 永久 pending。表现就是：插件白屏、卡在加载态。

**先用 `host.isLauncher()` 同步分流，再让每次调用都显式兜失败**：
- 不在宿主里：直接用本地实现（`localStorage` / 文件选择器），不发起宿主调用；
- 在宿主里：SDK 自带超时（`CallOptions.timeoutMs`），需要「失败即空值」就在调用点接 `.catch(() => null)`；
- `storage` 只在宿主里用，本地降级写 `localStorage`，避免两份数据互相覆盖。

### 2.5 Script 命令能做的事（能力边界）

- ✅ 读写任意本地文件、遍历目录、调用 Node 生态、访问网络
- ✅ 通过 `ctx().dataPath` 读写自己的数据目录（`pluginPath` 是只读安装目录）
- ❌ 不能弹 UI、不能长期驻留（一次性执行，`done()` 后结束）
- ⚠️ 能力越强越要自己收紧：本项目 `read-image` 只做「扫描白名单目录 + 扩展名白名单 + 文件头魔数校验 + 单文件 20MB 上限」
- ⚠️ 需要改系统文件（如 hosts）时：**目标路径绝不能来自调用方入参**，只认平台默认路径 —— 否则「能提权写文件」的脚本就成了任意文件写入的跳板；提权一律走系统自带对话框（macOS `osascript … with administrator privileges`、Windows `-Verb RunAs`、Linux `pkexec`），并且**写前备份、写后回读逐字节校验**，提权不可用时回落到「把待生效内容落盘 + 给用户一条可复制的命令」。完整范例见 `plugins/hosts/src/no-view/_hosts-file.ts`

---

## 3. 构建与发布

### 3.1 产物要求

```
dist/
├── index.html            # view 命令入口（固定名）
├── assets/*              # 静态资源
├── <command>.mjs         # no-view / script 入口，名字必须与 commands[].name 一致
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
- **构建后把 `package.json` 写进 dist**（本仓库 `scripts/manifest-plugin.mjs` 会自动剔除无关字段）。
- 「一个命令一个 JS 入口」的 lib 模式是**旧模板**的玩法，新 API 不需要。

### 3.3 No-View / Script 的构建

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

> 实测：`@sofastapp/api/node` 会被**完整内联**进 `.mjs`（它内部 import 的 `worker_threads` 才是 external 的），所以产物 ~9KB，不依赖宿主提供 node_modules。

### 3.4 安装与调试

- 安装：`dist/` → `<dataRoot>/extensions/<插件名>`（或设置页「插件管理」安装），内核启动时扫描该目录。
- 开发：`pnpm dev` 起 Vite 服务器，浏览器直接访问即可调 UI；宿主相关能力走降级分支。
- 多插件共存：每个插件是独立目录，互不共享 `node_modules`（本仓库的设计选择，避免工作区提升带来的解析问题）。

---

## 4. 本仓库脚手架约定

### 4.1 结构

```
<底座仓库>/plugins/
├── shared/       设计令牌 + lib + ui（构建期被打进各插件产物，发布时不需要带）
│   ├── build/    vite-shared.mjs（构建别名）+ manifest-plugin.mjs（清单裁剪）
│   └── tests/    公共库单测
├── <name>/       各自独立 Vite 工程（package.json / vite.config / tsconfig / index.html / src / test）
└── README.md     目录约定与发布流程

<底座仓库>/scripts/   build-all.mjs / spec-check.mjs / pack-plugins.mjs（跨插件工具）
```

出厂插件都是底座仓库的 pnpm workspace 成员，依赖由仓库根的 `pnpm install` 统一装。

### 4.2 `shared/` 的依赖解析（关键坑）

`shared/` 在插件的 `node_modules` 之外，Node 解析裸模块会一路向上找不到 `vue`。解决：

- **Vite**：`resolve.alias` 显式指向插件自己的 `node_modules`（`shared/build/vite-shared.mjs` 的 `sharedAliases()`）
- **TS**：`tsconfig.paths` 同步映射 `vue` / `@shared` / `@launcher/api`
- **dev server**：`server.fs.allow` 放开到 `plugins/`，否则读取 `shared/` 会被拦

### 4.3 Tailwind v4 不会跨界扫描

用 `@source` 显式声明扫描范围，否则 `shared/` 里的 class 不会生成：

```css
@import "tailwindcss";
@import "../../../shared/styles/theme.css";
@source "../";
@source "../../../shared";
```

### 4.4 主题与设计令牌

`shared/styles/theme.css`：`:root` / `[data-theme="dark"]` 两套 CSS 变量 → `@theme inline` 桥接成 Tailwind 工具类（`bg-panel` / `text-muted` / `border-line` …）。
视觉基调对齐宿主：8px 圆角、低饱和描边、`padding: 10px` 的行高、14px 正文。

### 4.5 复用件

| 文件 | 作用 |
|---|---|
| `shared/lib/virtual.ts` | 定高虚拟滚动（diff 行 / JSON 树 / 账户列表共用） |
| `shared/lib/clipboard.ts` | 复制三级兜底、剪贴板读图、文件选择、拖拽取文件、下载 |
| `shared/lib/keys.ts` | `Mod` 跨平台判断、`isTypingTarget` |
| `shared/lib/theme.ts` | 主题三级探测 + 切换 |
| `shared/lib/toast.ts` | 轻提示（L1 反馈） |
| `shared/ui/UiIcon.vue` | 自绘图标集（零依赖，避免为 20 个图标引入整个图标库） |
| `shared/ui/UiDialog.vue` | 弹窗骨架（Esc 关闭、尺寸档位） |
| `shared/ui/AppShell.vue` | 页面骨架 + 轻提示 + 主题应用 |

宿主调用不在这张表里：**直连 `@launcher/api` / `@launcher/api-node`**，没有中间适配层。

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
- **对策**：用 `mode: "script"` 的 Node Worker 读盘，转 base64 回传（本仓库 `plugins/totp/src/no-view/read-image.ts`）。

### 5.4 Script 产物不生成 / 命令面板搜不到

- **原因**：① 命令名与产物文件名不一致；② worker 构建 `emptyOutDir` 默认 true，把 UI 产物连同 `.mjs` 一起删了；③ 构建顺序反了（worker 先于 UI）。
- **对策**：`entryFileNames: '[name].mjs'` + `emptyOutDir: false` + 先 UI 后 worker。

### 5.5 从 `shared/`（或任何 node_modules 之外的目录）import 报模块找不到

- **对策**：alias（Vite）+ paths（TS）+ `server.fs.allow`（dev），三处都要配。

### 5.6 Tailwind 类名不生效

- **原因**：class 写在 Tailwind 扫描范围之外（`shared/`）。
- **对策**：`@source` 显式声明。

### 5.7 产物 404 / 白屏

- **原因**：`base` 默认 `/`，宿主托管路径对不上。
- **对策**：`base: './'`，并且不要开 `manualChunks`。

### 5.8 大文件把界面卡死

- **原因**：解析 / 差分在主线程跑。
- **对策**：全部丢进 Web Worker（`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`），并准备主线程降级路径（CSP 或老 WebView 下 Worker 可能创建失败）。

### 5.9 长列表滚动掉帧

- **对策**：定高虚拟滚动。行高统一时不需要测量，`scrollTop / rowHeight` 反推区间即可（见 `shared/lib/virtual.ts`）。

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

### 5.13 WASM 依赖默认走 CDN

- **现象**：非联网环境 / 离线打包后 wasm 加载失败。
- **对策**：`import wasmUrl from 'pkg/xxx.wasm?url'` 让构建把 wasm 打进 dist，再以 `wasmBinary` 形式喂给 Emscripten（顺带绕开 `instantiateStreaming` 的 MIME 检查）。

### 5.14 主题跟随宿主失败

- **原因**：iframe 与宿主可能跨源，宿主改不了 iframe 的 DOM。
- **对策**：`?theme=` → `document.documentElement.dataset.theme` → `prefers-color-scheme` 三级探测，用户手动切换后存本地。

### 5.15 用户在宿主搜索框里粘的内容读不到 / 用不上

- **技巧**：命令声明 `searchable: true`，插件启动时 `hostUi.getSearchContent()` 读一次，用完 `hostUi.clearSearchContent()`；再用 `hostUi.watchSearchContent()` 监听后续输入。这样「粘一条链接/密钥 → 回车 → 插件直接处理」的体验才成立。

### 5.16 清单字段拼写

- `categories` 这个字段容易被写成 `categroies`。不影响命令注册，但别拼错。

### 5.17 多个 script 入口被拆成多个文件，产物不再自包含

- **现象**：插件里有 `hosts-read.ts` 和 `hosts-write.ts` 两个入口，构建后 `dist/` 里除两个 `.mjs` 之外还多出 `dist/assets/_hosts-file-xxx.mjs`，入口文件里只剩一条 `import './assets/…'`。
- **原因**：Rollup 在多入口模式下，**被两个入口共用的模块必须提取成共享 chunk**（否则就得把同一份代码复制两份，Rollup 不做这件事）。`output.manualChunks: undefined` 也拦不住，它不是用户配置能改的默认行为。
- **风险**：宿主只把 `dist/<name>.mjs` 当 Worker 入口拉起。这条跨文件相对 import 一旦因为「用户只拷了单个 `.mjs`」「打包时漏了 `assets/`」「宿主换了加载方式」而断掉，命令直接失效——而且报错发生在宿主侧，插件里根本看不见。单入口插件（只一个 script 命令）不会触发，所以很容易到第二个入口才踩到。
- **对策**：**逐入口各跑一次构建**，每个产物自包含。本仓库做法（`plugins/hosts`）：
  - `vite.worker.config.ts` 用 `build.lib.entry` 指向**单个**入口，输出名由 `fileName` 固定，入口由环境变量 `PLUGIN_WORKER_ENTRY` 选择；
  - `scripts/build-no-view.mjs` 扫一遍 `src/no-view/*.ts`，逐个 `execFileSync(vite, ['build', '--config', 'vite.worker.config.ts'])`，每次带上不同的环境变量；
  - `package.json` 的 `build` 末段改成 `node scripts/build-no-view.mjs`。
- **顺带**：Vite 的 `defineConfig` **不接受配置数组**，CLI 会直接报 `config must export or return an object`，所以「多配置」只能自己在脚本里循环调用。

---

## 6. 新增一个插件的检查清单

```
[ ] plugins/<name>/package.json：apiVersion + capabilities 必填，commands 齐全、mode 正确
[ ] package.json 提供 build:view / build:scripts（根 scripts/build-all.mjs 按这两条驱动）
[ ] vite.config.ts：base './'，outDir dist，构建后写清单
[ ] 有 no-view/script 命令时：vite.worker.config.ts（emptyOutDir:false）+ 文件名对齐；**有 2 个以上入口时逐入口构建**（§5.17），构建后 `grep -h '^import' dist/*.mjs` 应只见 node 内置模块
[ ] tsconfig.json：extends shared/tsconfig.base.json + paths（vue / @shared / @launcher/api）
[ ] src/styles/app.css：@import tailwindcss + theme.css，@source 覆盖 src 与 shared
[ ] 宿主调用直接 `@launcher/api` / `@launcher/api-node`，先用 `host.isLauncher()` 分流、调用点兜失败
[ ] 大计算进 Worker、长列表虚拟滚动
[ ] pnpm build:plugins && pnpm spec-check 全绿：dist 里 index.html + assets + package.json(+ .mjs)
[ ] 起静态服务器实机点一遍（不只是 dev server，prod 的资源路径不同）
[ ] 敏感数据：默认不落明文，或提供口令加密
```

---

## 7. 参考

- 规范与架构：`docs/plugin-spec.md`（对外契约）、`docs/architecture.md`（内核实现）、`plugins/README.md`（目录与构建）
- API 权威定义：`packages/plugin-api/src/index.ts`（UI 侧）、`packages/plugin-api-node/src/index.ts`（脚本侧）
- 现有范例：
  - `plugins/totp` —— view + script + 对话框 + 口令加密（`src/core/vault.ts`）
  - `plugins/hosts` —— 提权写系统文件、写前备份 + 写后回读校验
  - `plugins/text-diff` —— Web Worker 计算 + 主线程降级 + 虚拟滚动
  - `plugins/json-tools` —— 手写词法扫描（不丢数字精度）+ 树视图
- 本仓库四个真实插件：`plugins/totp`（含 script 命令）、`plugins/text-diff`（Worker + 虚拟滚动）、`plugins/json-tools`（无损解析 + 树视图）、`plugins/hosts`（读盘 + 提权写入 + 无损回写）
