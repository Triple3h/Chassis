# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

「如快 Sofast」插件集合，现在作为**预置插件**住在底座仓库的 `presets/` 下：四个互相独立、可单独发布的 Vite 工程（Vue 3 + TS + Tailwind v4），共用同目录的 `shared/`（构建期被打进产物）与 `scripts/`。目标宿主有两套：底座（`@launcher/api`）与如快 **v0.9.0+**（顶层 `commands` 清单 + Node Worker API），运行期自动判定。四个插件全部本地计算、**不联网**。

| 插件 | 命令 | 说明 |
|---|---|---|
| `sofast-totp` | `totp` + `read-image`（script） | TOTP/HOTP 验证码；靠 script 命令读本地图片来扫 Google Authenticator 迁移二维码 |
| `sofast-text-diff` | `diff` | Myers 行级 + 字符级差分，Worker 内计算 |
| `sofast-json-tools` | `json` | 无损 JSON 格式化 / 压缩 / 校验 + 扁平树视图 |
| `sofast-hosts` | `hosts` + `hosts-read` / `hosts-write`（script） | 查看与修改系统 hosts；script 命令负责读盘、备份、提权写入与回读校验 |

本目录是底座仓库的 pnpm workspace 成员：依赖由仓库根的 `pnpm install` 统一安装（不再有逐插件的 `node_modules` / `package-lock.json`）。定位与边界见同目录 `README.md`。

## 常用命令

```bash
# —— 在仓库根执行 ——
pnpm build:presets                          # 构建全部预置插件
node presets/scripts/spec-check.mjs         # 规范自检（清单 / N1 / N2 / N3 / 产物 / 远程资源）
node presets/scripts/build-all.mjs --pack   # 构建并打 zip 到 presets/release/（如快安装用）
node scripts/smoke-first-batch.mjs          # 在真底座上端到端跑一遍

# —— 进插件目录执行 ——
pnpm --filter sofast-totp run build         # vue-tsc 类型检查 → UI 构建 → worker 构建
pnpm --filter sofast-totp run typecheck
pnpm --filter sofast-totp run test          # 自建 harness，无测试框架
pnpm --filter sofast-totp run dev           # 浏览器调试：无宿主时自动降级为 localStorage

# 跑单个测试文件（无过滤参数，需整文件跑）
cd presets/sofast-totp && node ../../scripts/run-ts.mjs test/core.test.ts

# 生产产物实机验证（生产资源路径与 dev server 不同，必须单独点一遍）
cd presets/sofast-totp && python3 -m http.server 5233 --directory dist
```

## 架构

### 命令形态决定工程形态

宿主侧支持三种 `mode`，这是所有设计的起点：

- `view` —— 渲染在 **iframe** 里的静态页，入口固定为插件根的 `index.html`（无需声明）。一个插件可以有多个 view 命令，它们**共用同一个 index.html**，靠 URL 上的 `?sid=&cmd=` 区分会话与命令（`shared/lib/platform.ts` 的 `readSession()`）。
- `no-view` / `script` —— 跑在 **Node Worker** 里的 `.mjs`，入口是 `dist/<name>.mjs`，**`commands[].name` 必须与产物文件名逐字相同**。区别只在 `script` 不出现在命令面板、只能被 `Backend.run('<name>', args)` 调用。宿主查找顺序：`<pluginRoot>/<name>.mjs` → `.js` → `workers/<name>.mjs` → `.js`。
- 关键推论：**iframe 受浏览器沙箱限制，读不了本地文件路径**。凡是「按路径读写磁盘」的需求，一律落到 `script` 命令上（`sofast-totp` 的 `read-image` 就是为此存在），并配好 UI 侧的手工兜底路径。

### 构建管线（三个脚本串起来才看得懂）

每个插件的 `build` 是**严格有序**的三段：

1. `vue-tsc --noEmit` 类型检查；
2. `vite build`（UI，`emptyOutDir: true`）；
3. 有 script 命令的插件再跑 `vite build --config vite.worker.config.ts`（**`emptyOutDir: false`**，否则会把第 2 步的 UI 产物连同 index.html 一起删掉；`external: ['worker_threads', /^node:.*/]`，`entryFileNames: '[name].mjs'`，入口由 `src/no-view/*.ts` 自动发现）。

顺序不能反。`presets/scripts/manifest-plugin.mjs` 作为 Vite 插件挂在 `writeBundle`，把 `package.json` 裁剪成宿主需要的字段写进 `dist/package.json`——于是 **`dist/` 本身就是一个可直接放进 `<如快安装目录>/extensions/`（或底座的 `extensions/`）的插件目录**（本仓库刻意不带根级清单）。`presets/scripts/build-all.mjs` 遍历 `presets/` 逐个执行上述流程，`--pack` 用 `zip -rq` 打 `presets/release/<name>.zip`。

`scripts/run-ts.mjs`（底座仓库的 runner）与构建无关：它用 esbuild 把 TS 测试脚本打成单文件交给 node，因此源码里可以继续写无扩展名的 bundler 风格 import。

### `shared/` 的跨工程解析（三处必须同时配）

`shared/` 在插件目录之外（`presets/shared/`），裸模块解析到不了它、也到不了 `vue`。所以每个插件都要三处齐配，缺一处就报模块找不到：

- **Vite** `resolve.alias` —— `presets/scripts/vite-shared.mjs` 的 `sharedAliases(pluginRoot)`（`@shared` 指向 `presets/shared`，同时把 `vue` / `@sofastapp/api` / `@launcher/api` 显式指到插件自己的 `node_modules` 做去重）；
- **TS** `tsconfig.paths` —— 同样的映射，插件 tsconfig 继承 `presets/shared/tsconfig.base.json`；
- **dev server** `server.fs.allow` —— 放开到 `presets/`，否则读取 `shared/` 被拦。

### 宿主接入层：`shared/lib/platform.ts` 是唯一出口

**双宿主**：如快 Sofast（`@sofastapp/api`）与启动台（`@launcher/api`）。组件里**禁止**裸调任何宿主 SDK，一律经适配层：

| 文件 | 职责 |
|---|---|
| `shared/lib/platform.ts` | 宿主探测 + 对外导出（函数名与返回值语义与宿主无关） |
| `shared/lib/host-adapter.ts` | 「谁来接这个调用」：两套 SDK → 一个 `HostBridge`（纯函数，可单测） |
| `shared/lib/host-calls.ts` | 「怎么调」：超时 / 哨兵值 / localStorage 兜底（两个宿主逐字相同） |
| `shared/lib/host-node.ts` | 脚本侧：直接说 Node Worker 协议，不依赖任何 SDK |

要点：

1. **两个 SDK 都动态 `import()`** —— `npm run dev` 时没有宿主，顶层静态导入会把调试环境炸掉；
2. **探测必须探活，不能只看参数** —— 如快的 `inSofastIframe()`（`window.top !== window`）与底座的
   `isLauncher()`（iframe + `?sid=`）在**对方宿主里同样为真**。所以 platform.ts 对两个宿主各发一次只读探针
   （`host.info` / `Context.getSearchContent`），谁先应答就是谁，300ms 内都没人应 → 当无宿主处理；
3. **超时 + 哨兵值** —— 宿主不在时 SDK 的 promise 永远没人应答，不加超时会白屏卡在加载态
   （`context: 400ms` / `storage: 600ms` / `action: 1200ms`，与改造前一致）；
4. **存储回落** —— 宿主不可用时退回 `localStorage`（前缀 `sof:`），宿主可用则绝不双写。

底座 SDK（`@launcher/api`，未发布）在本仓库里就是**工作区包** `packages/plugin-api`：
四个插件的 `dependencies` 里写着 `"@launcher/api": "workspace:*"`，`pnpm install` 直接链进各自 `node_modules`，
构建期由 `vite-shared.mjs` 的别名指向它 —— 不再需要「先发布 / 再找路径 / 找不到退 stub」那套机制。

新增宿主能力时，先在 `host-adapter.ts` 两边各接一条、在 `host-calls.ts` 定好超时语义，再在 UI 使用。

### 计算调度：Worker + 主线程降级

「大输入不卡界面」在 `sofast-text-diff` 与 `sofast-json-tools` 里是同一套形状，改动性能相关代码时照这个范式：

- `core/<算法>.ts` —— 纯函数，无副作用、可直接单测（`myers.ts` / `format.ts` / `tree.ts`）；
- `core/worker.ts` —— Worker 侧的薄壳，`onmessage` 分派到纯函数；
- `core/runner.ts` —— 主线程调度：懒创建 `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`、自增 `id` 防串包、`onerror`/构造失败时置 `broken` 标志，**降级为在主线程同步跑同一份纯函数**。

CSP 或老 WebView 下 Worker 可能创建失败，降级分支不是可选项。

### 各插件 core 分层

- **totp**：`base32`（RFC 4648，容错）与 `otpauth`（URI 解析/生成）、`migration`（Google Authenticator 迁移码，手写约 60 行最小 Protobuf 读取器，省掉 protobufjs 的 200KB）构成导入链路；`qr` 用 zxing-wasm（**wasm 用 `?url` 打进 dist，不走 CDN**，并以 `wasmBinary` 形式喂给 Emscripten）；`totp` 走 WebCrypto 原生 HMAC，按「密钥+算法」缓存 `CryptoKey`、按「账户+时间步」缓存验证码；`store` 负责持久化，未开口令时直接存 `accounts`，开口令后账户进 `vault` 密文、`accounts` 键被清掉；`vault` 是 PBKDF2-SHA256(250k) + AES-GCM-256，口令不落盘。`src/no-view/` 拆成两层：`find-image.ts` 纯逻辑（目录白名单 + 扩展名白名单 + 文件头魔数 + 20MB 上限，可测），`read-image.ts` 只做 `ctx/log/done` 胶水。
- **text-diff**：`myers.ts` 是**线性空间分治**版（找中间蛇 + 分治，空间 O(N+M)），带 `deadlineMs` 时间预算与 `maxD` 上限，超限退化为「整段替换」；`diff.ts` 是上层编排——两份文本共用一个 `行→整数 id` 映射把字符串比较降级为整数比较，先用 patience 式「唯一公共行」锚点粗切，段内交给 Myers，字符级内联只作用于配对成功的「改动行」（超长行直接整行标记）。
- **json-tools**：`scanner.ts` 是手写词法扫描，**数字只搬字节不解析**（`JSON.parse` + `stringify` 往返会把 `12345678901234567890` 改写成 `...000`、把 `1e999` 变成 `null`），并支持宽松修复（注释 / 尾逗号 / 单引号 / 裸键）与行列级错误定位；`format.ts` 在其上做格式化/压缩/键排序；`tree.ts` 用**「长子 + 兄弟链」（`firstChild` / `nextSibling`）**表达层级——先序遍历下兄弟节点不连续，`start/count` 区间模型是错的；`lineIndex.ts` / `highlight.ts` 供 UI 侧虚拟滚动与语法高亮使用。
- **hosts**：`core/hosts.ts` 是纯函数解析器，**每行的 `raw` 连同行尾换行符一起保留**，只有 `isDirty()` 的条目才重新生成，于是「没碰过的行逐字节原样回写」（手写注释、空格对齐、CRLF/LF 混用都不丢）；`diffLines()` 用「位置队列 + 顺序匹配」做 O(n) 行级差分供保存前预览，能正确处理重复行；`core/snapshots.ts` 管快照裁剪与持久化；`no-view/_hosts-file.ts` 是磁盘侧全部逻辑（路径解析、BOM/编码探测、备份、提权、回读校验），**写入目标路径不接受调用方传参**，只由平台规则决定——否则这个能提权的脚本就成了任意文件写入的跳板。

### UI 复用与主题

`shared/ui/` 提供 `AppShell`（页面骨架 + 轻提示 + 主题应用）、`SofIcon`（自绘图标集，避免为 20 个图标引入整个图标库）、`SofDialog`；`shared/lib/virtual.ts` 是定高虚拟滚动（行高统一时用 `scrollTop / rowHeight` 反推区间，无需测量），长列表一律用它。

设计令牌在 `shared/styles/theme.css`：`:root` / `[data-theme="dark"]` 两套 CSS 变量，经 `@theme inline` 桥接成 Tailwind 工具类（`bg-panel` / `text-muted` / `border-line`）。**Tailwind v4 不会跨界扫描**，每个插件的 `src/styles/app.css` 必须用 `@source` 显式声明插件 `src` 与 `shared` 两个范围，否则共享组件里的类名不生成。主题三级探测：`?theme=` → `document.documentElement.dataset.theme` → `prefers-color-scheme`，用户手动切换后存本地。

### 硬约束（违反必出问题）

- 宿主 API 只经 `shared/lib/platform.ts`（脚本侧走 `shared/lib/host-node.ts`）；任何直连 SDK 的调用都要先补超时与降级。
- **可变数据只写 `ctx().dataPath`**（N2）：`pluginPath` 是只读安装目录，升级/重装会覆盖它。
  如快下 `dataPath` 兜底成 `<插件目录>/data`（= 历史位置，所以那边行为不变）；
  启动台下是 `<dataRoot>/plugins/<id>/`。`pluginPath` 只许读，写操作 spec-check 会拦。
- 清单**必须**带 `apiVersion: "1"` 与 `capabilities`（只声明真正用到的），且 `manifest-plugin.mjs`
  的 `MANIFEST_KEYS` 要能把它带进 `dist/package.json` —— 少一个启动台就拒绝加载。
- `commands[].name` 对 `no-view`/`script` 必须等于 `dist/<name>.mjs`。
- worker 构建 `emptyOutDir: false`，且先 UI 后 worker。
- `vite.config.ts` 必须 `base: './'`，**不要开 `manualChunks`**（产物被切块后宿主托管路径会对不上）。
- 有**多个** `no-view`/`script` 入口时**逐入口各构建一次**（`presets/sofast-hosts/scripts/build-no-view.mjs`）：Rollup 多入口会把共用模块拆成 `dist/assets/*.mjs`，入口里只剩一条相对 import，宿主只认 `dist/<name>.mjs`，这条依赖一断命令就废。构建后 `grep -h '^import' dist/*.mjs` 应只见 `node:*` 与 `worker_threads`。
- 解析/差分/格式化等可能超 50ms 的计算进 Worker 并保留主线程降级；可能超 200 行的列表用虚拟滚动。
- 剪贴板读取优先用 `paste` 事件的 `clipboardData`（用户手势，无需权限），写入用 `writeText` → `execCommand` 三级兜底，UI 永远保留手工路径。
- 敏感数据（密钥、验证码）默认不落明文；要持久化就提供口令加密（参考 `presets/sofast-totp/src/core/vault.ts`）。
- 新增 `src/no-view/` 脚本时，同步更新 `package.json` 的 `commands` 与 `build` 脚本。

### 知识资产分工（新增插件或踩新坑时三处同步）

| 位置 | 装什么 | 何时被读到 |
|---|---|---|
| `docs/sofast-plugin-dev-guide.md` | 平台模型、API 速查、IPC 实测协议、踩坑复盘（现象→原因→对策 §5） | 需要背景知识时 |
| `.codebuddy/rules/sofast-plugin/RULE.mdc` | 不遵守就一定出错的硬约束 | `alwaysApply`，每会话自动进上下文 |
| `.codebuddy/skills/sofast-plugin-dev/` | 新建/改造插件的操作流程 + 配置模板 + 排障速查 | 提到「写 sofast 插件」时按需加载 |

新增插件时以 skill 的 5 步流程为准（确定命令形态 → 搭工程 → 写代码 → 验证 → 发布）；踩到新坑要在手册加复盘、规则加铁律、skill 加流程/模板。`.codebuddy/` 随代码一同版本化，不要忽略或清理。

### 交付前的固定检查

`npm run typecheck && npm run build && npm test`，然后确认 `dist/` 内有 `index.html` + `assets/` + `package.json`（有 script 命令时还有 `<name>.mjs`），并**起静态服务器打开 `dist/` 实机点一遍**——dev server 与生产构建的资源路径不同，只测 dev 会漏掉白屏。有 Worker 的功能要确认真的走了 Worker 而非降级分支；有 script 命令的用 `worker_threads` 直接拉起产物做一次端到端（`Backend.run` 的返回值就是脚本里 `done(x)` 的 `x`）。
