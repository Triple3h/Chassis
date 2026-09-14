# 症状 → 定位 → 修复

原理和复盘见 `docs/sofast-plugin-dev-guide.md` §5，这里只给可执行动作。

## 打开就卡死 / 一直转圈

1. 看 Network 与 Console 有没有报错——通常**没有报错**，这才是特征。
2. 在浏览器里打开 `npm run dev` 的地址，若同样卡住，基本可确认是宿主调用没超时。
3. 修：所有 `LocalStorage.*` / `Context.*` / `Backend.run` / `Screenshot.start` 调用必须经 `shared/lib/platform.ts`（内部有 `withTimeout`）。裸调 SDK 就会永久 pending。

## 命令面板搜不到命令

1. `cat dist/package.json` —— 有没有 `commands` 数组？字段名对不对（`title` 才是搜索关键词）？
2. 宿主是**启动时**扫描 `extensions/`，装完必须重启。
3. `searchable: true` 才会进全局搜索；`script` 命令本来就**不应该**出现在面板里，那是正常的。

## Script 命令不生效 / `Backend.run` 返回 null

1. `ls dist/*.mjs` —— 产物存在吗？名字和 `commands[].name` **逐字相同**吗（大小写、连字符）？
2. 产物是不是被 UI 构建清掉了：worker 配置必须 `emptyOutDir: false`，且构建顺序 UI → worker。
3. 宿主版本是否 ≥ v0.9.0（script 是新 Worker API 的一部分）。
4. 用 `references/scaffold-templates.md` 末尾的 `worker_threads` 脚本直接拉起产物，能跑通说明产物没问题，问题在宿主侧调用。

## 页面能打开但 JS/CSS 404

`base` 不是 `'./'`。宿主用本地 HTTP 托管，绝对路径 `/assets/...` 会对不上。

## 样式全丢 / 只有部分类生效

Tailwind v4 的扫描范围没覆盖到。检查 `src/styles/app.css` 是否同时 `@source` 了插件 `src` 与 `shared/`；新增目录（比如 `src/components/`）如果在 `src` 之下就不用改。

## `Cannot find module 'vue'`（或 `@sofastapp/api`）

报错文件在 `shared/` 下 → 三处都要配：

1. `vite.config.ts` 的 `resolve.alias = sharedAliases(root)`
2. `tsconfig.json` 的 `paths`
3. dev server 的 `server.fs.allow = devFsAllow(root)`

## Worker 里的功能没生效（没报错，只是很慢）

1. 大概率静默走了主线程降级分支。在 `runner.ts` 的降级处打日志确认。
2. 检查 `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` 的写法是否被改写成了字符串路径。
3. `vite.config.ts` 里 `worker: { format: 'es' }` 加上；某些 CSP 环境确实不允许 Worker，降级是必要的，但要**让用户知道**。

## wasm 加载失败（离线 / 404 / MIME 报错）

`instantiateStreaming` 依赖 `Content-Type: application/wasm`，宿主静态服务器不一定给对。做法：

```ts
import wasmUrl from '<pkg>/xxx.wasm?url'
const bin = await (await fetch(wasmUrl)).arrayBuffer()
await prepareZXingModule({ overrides: { wasmBinary: bin, locateFile: () => wasmUrl }, fireImmediately: true })
```

`assetsInlineLimit` 要小到不足以内联 wasm（默认 4096 即可）。

## 大文件/大文本操作时界面卡死

计算在主线程。挪进 Worker，并做三件事：① 序号防串包（旧结果不许覆盖新结果）；② 防抖；③ 主线程降级分支。

## 树 / 列表渲染错行、展开后内容不对

检查是不是假设了「子节点下标连续」。先序遍历下嵌套容器的子节点会插在中间，兄弟不连续。改用 `firstChild` + `nextSibling`（参考 `plugins/sofast-json-tools/src/core/tree.ts`）。

## JSON 格式化后数字变了

`JSON.parse` + `stringify` 往返导致的精度丢失（大整数、`1e999`）。改成手写词法扫描、数字只搬字节（参考 `plugins/sofast-json-tools/src/core/scanner.ts`）。

## 剪贴板读不出来

`navigator.clipboard.read()` 在部分 WebView 被拒。改用 `paste` 事件里的 `clipboardData`（用户按 ⌘V 触发，不需要权限），并在 UI 上保留「手动选择文件」入口。

## 主题跟宿主不一致

跨源 iframe 里宿主改不了你的 DOM。按 `?theme=` → `document.documentElement.dataset.theme` → `prefers-color-scheme` 三级探测（参考 `shared/lib/theme.ts`）。

## 构建报 `npm warn install-scripts ... blocked`

npm 11 默认拦截依赖的 postinstall（如 `esbuild`）。**通常不影响构建**（esbuild 的平台二进制是 optional dependency，运行时能找到）。
真出现 esbuild 启动失败时：`npm install-scripts approve esbuild` 后重装。

## macOS：终端里 `ls` 仓库目录报 `Operation not permitted`、`node` 报 `uv_cwd`

工作区在 `~/Documents` 下时，终端进程没有该目录的读取授权（TCC）。

- 用 IDE 的文件工具读写即可；
- 需要跑 npm/vite 时，**不要把 cwd 设成仓库根目录**，`cd` 进具体插件子目录再跑（子目录可以正常 `getcwd`）；
- 一键脚本（如 `scripts/build-all.mjs`）用 `cd /tmp && node <绝对路径>` 的方式启动，脚本内部按 `import.meta.url` 解析路径。

## 产物检查清单（交付前跑一遍）

```bash
cd plugins/<name>
npm run typecheck && npm run build && npm test
find dist -type f | sort          # index.html / assets/* / package.json(+ *.mjs)
python3 -m http.server 5233 --directory dist   # 再实机点一遍，别只信 dev server
```
