# 内核实现细节与差异记录

> 读者：实现者、评审者 ｜ 需求源：`docs/launcher-requirements.md`（本文件不复制需求，只写"怎么实现"与"哪里不一样"）
> 最后更新：2026-09-16
> 约定：**遇到需求没写的行为，先补本文件再写代码。**

---

## 1. 进程拓扑

```
┌──────────── 壳（Rust / Tauri 2，apps/shell）────────────┐
│ main.rs → lib.rs：窗口 · 单实例 · 托盘 · 热键 · 失焦通知   │
│ ipc.rs：stdio + newline JSON-RPC 2.0                    │
│ sidecar.rs：拉起/监督/重启/回收 Node 内核                 │
│ primitives/{window,hotkey,tray,notify,clipboard,opener} │
└───────▲────────────────────────────────────┬────────────┘
        │ JSON-RPC（内核→壳：原语；壳→内核：通知）  │ spawn node kernel.mjs
        │                                        ▼
┌──────────── 内核（TS / Node 22+，apps/kernel）───────────┐
│ kernel.ts 装配 → api.ts 路由 → http/server.ts(UiServer)  │
│ registry · pipeline · plugin · search · history · audit  │
│ services/{storage,bridge,hostUi,shell,exec,quicklink,    │
│           settings} + http/pluginServers.ts              │
└───▲────────────────▲───────────────────────┬────────────┘
    │ HTTP + SSE      │ postMessage（经 UI 转发）│ worker_threads
    │                 │                        ▼
┌───┴──────────┐  ┌───┴──────────────┐  ┌─────────────────┐
│ 启动台 UI     │  │ 插件 view 页      │  │ 插件 script 命令 │
│ (uiPort)     │  │ (每插件一端口)      │  │ dist/<name>.mjs │
└──────────────┘  └──────────────────┘  └─────────────────┘
```

- **壳 ↔ 内核**：`stdio + newline-delimited JSON-RPC 2.0`。第 1 条约定：**协议只走 stdout/stdin，内核所有日志走 stderr**（`apps/kernel/src/main.ts` 开头就把 `console.*` 重定向到 stderr）。
- **内核 ↔ UI**：HTTP `/api/*` + SSE `/api/events`（见 ADR-0001）。
- **内核 ↔ 插件页**：每插件一个 `http.createServer().listen(0, '127.0.0.1')`，端口由系统分配后读回 ⇒ origin 天然隔离。
- **内核 ↔ 插件脚本**：`worker_threads`，`workerData = { command, args, pluginPath, pluginId, dataPath, dataRoot, mode }`。

## 2. 目录 → 模块映射

| 需求（§5/§7） | 实现 | 备注 |
|---|---|---|
| `main.ts` | `apps/kernel/src/main.ts` | 参数解析、`console → stderr`、信号处理 |
| `config.ts` | `apps/kernel/src/config.ts` | `Config` 类型在 `@launcher/plugin-manifest`（UI 也要用），本文件有默认值 + 迁移 + 净化 |
| `context.ts` | 同 | 装配期裁剪 + `effect/inject/on` |
| `registry.ts` | 同 | `CommandRegistry` + `SearchResultHub`（token 新鲜度） |
| `pipeline.ts` | 同 | 洋葱模型，中间件可来自插件 |
| `plugin.ts` | 同 | 扫描/加载/停用/热重载/崩溃/降级/安装/卸载 + chokidar 监听 |
| `audit.ts` | 同 | 环形缓冲 500 + jsonl 滚动 7 天 + 敏感字段打码 |
| `history.ts` | 同 | 历史 + 固定，debounce 500ms + 原子写 |
| `search.ts` | 同 | 广播 / 合并 / 去重 / 稳定排序 |
| `services/*` | 同（合并了 `hostUi`/`shell`/`clipboard`/`notify`） | `notify`/`screenshot` 在 `primitives.ts` 与 `shell.ts` 里 |
| `http/server.ts` | `http/server.ts` + `http/pluginServers.ts` | UI 宿主服务与插件 listener 池分开 |
| `jsonrpc.ts` | 同 | `ShellLink` |

> 需求 §5 的 `services/` 是功能清单，本实现按文件合并落位：`bridge` / `hostUi` / `shell` / `clipboard` / `exec` / `storage` / `quicklink` / `settings` 各一个文件；
> `notify` 与 `screenshot` 合入 `shell.ts`（底层走 `primitives.ts` 与壳原语）；另有 `audited.ts`（审计包装）与 `kernel.ts`（内核服务）。

---

## 3. 服务总线与装配期裁剪（P5）

`createPluginContext()` 只挂载「插件声明 **且** 被授予」的服务：

| 服务 | 需要的能力 | 无授权时 |
|---|---|---|
| `storage` / `commands` / `searchResult` / `audit` / `host` / `pipeline` | 无 | 恒在 |
| `hostUi` | `hostUi` | 属性不存在 |
| `shell` | `shell.open` | 属性不存在 |
| `exec` | `exec.spawn` | 属性不存在 |
| `notify` | `notify.show` | 属性不存在 |
| `screenshot` | `screenshot` | 属性不存在 |
| `quicklink` | `quicklink` | 属性不存在 |
| `clipboard` | `clipboard.read` / `clipboard.write` | 两者都无 → 属性不存在；只有其一 → 另一方法抛 `CAPABILITY_DENIED` |
| `settings` | 仅 `internal-*` 插件（ADR-0003） | 属性不存在 |

裁剪同时写一条审计（`context.mount`, `ok:false`, `CAPABILITY_DENIED`），所以"拒绝授权"是可追溯的。

**注册即可逆（P4）**：`ctx.effect(fn, label)` 返回的 disposer 由内核按**注册逆序**回滚（`disposeContext`）；插件停用/热重载/卸载走同一条路径。

---

## 4. 搜索调度（含与需求 §7.6 的差异）

时序（一次输入）：

```
UI 输入 → debounce 80ms → POST /api/search
  → token = ++counter；hub.open(token)
  → ① 本地结果：searchable 命令（match 打分）+ pinned 命中 + history 命中（可被 config 关掉）
  → ② 广播 search/query
       · contributes + script → 常驻搜索 worker（200ms 预算，见 ADR-0002）
       · contributes + view   → 活跃会话 postMessage
  → ③ 等待（预算 200ms + 30ms 宽限）
  → ④ 合并：按 `${pluginId}:${item.id}` 去重（保留高分）→ 排序
  → ⑤ 稳定排序：集合不变则保持上次顺序（避免列表抖动）
  → 返回 { token, groups:{pinned,best,recent}, pending }
```

打分（`apps/kernel/src/pinyin.ts`）：

- `match`：标题前缀 1.0 / 包含 0.7 / 拼音全拼 0.6 / 首字母 0.5 / 副标题与 keywords 0.4（拼音索引只在查询串以 ASCII 为主时启用，避免中文误命中）
- `recency = exp(-Δh/72)`、`frequency = min(1, log2(count+1)/5)`
- 有历史：`score = 0.55*match + 0.30*recency + 0.15*frequency`；无历史：`score = 0.9*match`
- 插件自评：`final = 0.6*pluginScore + 0.4*kernelScore`
- 固定项恒在最前（按 `order`），不参与 `best` 排序

**性能红线**（§3.2 / §10）的落点：

- UI 侧立即用本地快照渲染（不闪空白），插件结果到达后替换 → `POST /api/search` 只做一次往返
- 同一 query 的并发请求合并（`SearchEngine.inFlight`）
- 结果网格 > 200 条启用虚拟滚动（`apps/launcher-ui/src/lib/virtual.ts`，按「一排格子」为单位定高）

---

## 5. 插件生命周期

```
discovered → validating → loading → active
                          ↘ disabled（用户禁用）
                          ↘ error（清单/产物/端口的错误）
active ⇄ disabled（用户启停）
active → crashed（view 页崩溃，UI 上报 /api/session/crashed）
active → degraded（脚本连续失败 3 次）
```

- **插件根识别**：若 `<dir>/dist/package.json` 存在，则 `<dir>/dist` 即插件根（源码工程形态）；否则 `<dir>` 本身（zip 安装后的形态）。`scan()` 与 `installFromDirectory()` 用同一条规则。
- **清单校验**：`@launcher/plugin-manifest` 的纯函数 `validateManifest()`（错误码：`MANIFEST_INVALID` / `API_VERSION_UNSUPPORTED` / `CAPABILITY_UNKNOWN`），产物校验用 `checkEntries()`（`ENTRY_MISSING`）。
- **目录变化**：chokidar 监听 `<dataRoot>/extensions/`，400ms 去抖后按插件粒度热重载；重载**不动** history/pinned/storage。
- **安装**：`installFromDirectory` / `installFromZip`（拒绝绝对路径、`..`、单文件 > 50MB、解压后 > 200MB；允许一层包裹目录）。
- **卸载**：禁用 → 删目录 → 清记录；出厂插件（`builtin: true`）拒绝卸载、允许禁用。

---

## 6. HTTP 拓扑

### 6.1 UI 宿主服务（`uiPort`，随机）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | 配置 / 插件 / 命令快照 / 固定 / 最近 |
| POST | `/api/search` | `{ query }` → `{ token, groups, pending }` |
| POST | `/api/exec` | 执行结果项 / 指定命令 / ActionDecl |
| POST | `/api/invoke` | 按全局命令 id 执行（托盘、测试用） |
| GET | `/api/events` | SSE：`registry/changed`、`config/changed`、`plugin/state`、`plugin/reloaded`、`session/closed`、`history/changed`、`search/query`、`ui/*`、`shell/visibility`… |
| POST | `/api/bridge` | 插件页调用转发（token 校验 + 审计） |
| POST | `/api/session/close`、`/api/session/crashed` | 会话回收 / 崩溃上报 |
| POST | `/api/pinned/toggle`、`/api/pinned/reorder`、`/api/history/*` | 固定与历史 |
| POST | `/api/config`、`/api/ui/theme` | 配置与主题（配置写成功后广播 `config/changed`，UI 据此即时重设主题 / 主题色 / 密度） |
| POST | `/api/plugins/action` | 插件管理（与托盘、设置面板共用 `Kernel.pluginAction`） |
| POST | `/api/dev/register` | 开发模式把 devUrl 挂到内核 |
| POST | `/api/window/*`、`/api/app/*`、`/api/data/openDir` | 转发壳原语 |

`/api/*` 之外是 UI 静态资源（`--ui-dist`；`--ui-dev` 时 302 到 vite），SPA 兜底回 `index.html`。

### 6.2 插件 listener（每插件一个端口）

- 只 `listen(0, '127.0.0.1')`（不绑 `0.0.0.0`，避免 macOS 防火墙弹窗）
- 只暴露插件目录（`resolveWithinRoot` 防穿越），响应头带 CSP：
  `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https:; frame-src 'none'; object-src 'none'; base-uri 'none'`
  （`'wasm-unsafe-eval'` 只放行随包 wasm 的编译，JS 的 `eval` / `new Function` 仍被禁止）
- 会话 URL：`http://127.0.0.1:<port>/index.html?sid=&cmd=&theme=&token=[&args=]`

### 6.3 桥的三重校验

| 校验 | 在哪 |
|---|---|
| `event.source === iframe.contentWindow` | 启动台 UI（`PluginView.vue`，内核看不到 window 对象） |
| `event.origin === 该插件端口 origin` | 启动台 UI |
| `sid + token` 匹配、能力是否授予 | 内核（`BridgeDispatcher`） |

任一不符：丢弃 + 审计（`SESSION_INVALID` / `CAPABILITY_DENIED`）。

---

## 7. 数据布局（`dataRoot`）

```
~/Library/Application Support/Chassis/
├── config.json                  # 配置（版本化，可迁移）
├── history.json  pinned.json    # 最近使用 / 已固定（debounce + 原子写）
├── quicklinks.json
├── extensions/<pluginId>/       # 用户安装的插件（可写、可卸载）
├── plugins/<pluginId>/          # 插件数据目录（N2：插件唯一可写处）
│   ├── storage.json
│   └── icons/                   # app-launcher 的图标缓存
├── .staging/                    # zip 安装的临时目录（装完即删）
└── logs/audit-YYYY-MM-DD.jsonl  # 审计（滚动 7 天）
```

出厂插件在 `<appRoot>/builtin-plugins/`（打包后是 `Contents/Resources/builtin-plugins`），只读、可禁用不可卸载。
源码全部住在 `plugins/`，只是一个目录里有两套工具链：

| 插件 | 工具链 | 说明 |
|---|---|---|
| 内置（app-launcher / file-search / web-open / internal-settings） | esbuild，无框架 | 与底座同一套发布节奏 |
| Vue 插件（totp / host-manager / text-diff / json-tools） | Vite + Vue + Tailwind，共用工作区包 `@launcher/ui`（`packages/ui`：UI 积木 + 前端工具） | 2026-09-16 起与内置插件同目录维护、直连底座 SDK；见 `plugins/README.md` |

开发态从仓库根加载：内核 `--builtin-plugins` 接受**逗号分隔的多个目录**（默认 `plugins/`），
壳的开发态回退指向同一处；打包时 `scripts/lib/resources.mjs` 把各插件的 `dist/` 拷进 `builtin-plugins/`。

---

## 8. 与 requirements 的差异清单

> 原则：实现偏离需求时，**先补这一段再写代码**（需求 §0 的使用说明）。

| # | 需求条目 | 实现 | 原因 |
|---|---|---|---|
| D1 | §4.1 UI 托管二选一 | 选方案 B（内核托管） | ADR-0001 |
| D2 | §9.2 贡献型搜索只有 `search.onQuery`（UI 侧） | 增加「script 常驻搜索 worker」载体，Node 侧 SDK 增加 `onQuery` | ADR-0002（否则索引型插件无法工作） |
| D3 | §3.4 设置面板是 internal 插件，但 §8.6 API 表无配置读写 | 新增 `ctx.settings`，仅 `internal-*` 注入 | ADR-0003 |
| D4 | §5 写「`plugin-manifest` 用 zod 校验」 | 手写校验器（无运行时依赖） | 错误码要精确映射到 `MANIFEST_INVALID` / `CAPABILITY_UNKNOWN` / `API_VERSION_UNSUPPORTED`，且要产出人话消息；手写比 zod + 映射更直接，也少一个依赖 |
| D5 | §8.1 目录树是「安装后形态」（`<name>.mjs` 在插件根） | 增加「`<dir>/dist` 即插件根」的识别规则 | 源码工程与产物必须分离；否则出厂插件要么污染源码目录、要么无法扫描 |
| D6 | §3.3 动作菜单「打开插件所在目录」等固定动作 | 保持不变；另外把 `ActionDecl` 的能力边界写实：`open` 需要 `shell.open`、`copy` 需要 `clipboard.write` | 需求未规定，但不加约束的话"纯前端插件"可以靠结果项打开任意 URL，P5 会被绕过 |
| D7 | §3.2 `Enter` 执行默认动作、`⌘Enter/⇧Enter` 执行第二动作 | 一致；`→/←` 二级面板用 `ResultItem.detail` | — |
| D8 | §3.1「输入框内容保留上次的选中状态但默认清空（可配置）」 | `config.keepQuery`；当前实现是"UI 唤出时清空，插件可通过 `hostUi.setSearchContent` 回填" | UI 无法感知"唤出"事件（内核/壳才知道），已在 `ui/searchContent` 事件上留好通道 |
| D9 | §11 契约测试用 `echo-plugin` | 已实现（`tests/fixtures/echo-plugin` + `tests/contract/*.test.ts`，真 HTTP） | — |
| D10 | §10「主线程 > 50ms 的必须进 Worker」（拼音索引构建、大文件解析） | 拼音索引规模小（命令级），暂未进 Worker；历史文件 ≤ 2000 条，读取在毫秒级 | 记为待办：命令数量破千或历史破万时迁移 |
| D11 | §6.3 打包体积/冷启动指标 | 未做基准；自用版（`pnpm app:local`）已实机运行 | 需要真机 `tauri build` 才能量体积；自用不分发，暂不阻塞 |
| D12 | §8.10 与第三方旧宿主的兼容层 | **不做兼容**（2026-09-16 起）：桥只认原生信封 `__launcher: 1`，清单校验不放过 `apiVersion` / `capabilities` 缺省，旧布局数据迁移一并移除 | 半兼容的代价是长期维护两套语义，还会把"未实现的能力"伪装成"能用"；底座与插件同仓库，没有历史包袱要背 |
| D13 | §7.5 「拼音匹配」 | 用 `pinyin-pro`（ZTools 同选型） | 需求 §12 风险对策明确要求"用成熟库" |
| D14 | 未规定 plist 读取方式 | 自研 `plugins/app-launcher/src/core/plist.ts`（binary + XML 只读） | `simple-plist` 内部是运行时 `require`，打不进自包含产物（违反 N1）；`build-plugin.mjs` 现在会校验产物只含 `node:*` 依赖 |
| D15 | §7.6「插件在 200ms 内回结果」 | 插件激活后**延迟 800ms 预热**贡献型搜索 worker | 否则用户第一次输入必然吃一次 worker 冷启动 + 索引加载而超时（体验上就是"第一次搜不到"） |
| D16 | §8「出厂插件」只描述了 `plugins/` | 全部出厂插件（内置 4 个 + Vue 4 个）都住在 `plugins/`，同出厂流程、工具链各自保留；`--builtin-plugins` 仍支持多目录 | 2026-09-16 收敛：取消 `presets/` 层 —— 插件从「两类来源」变成「一个目录、两套工具链」。旧数据目录由内核一次性接手（`LEGACY_PLUGIN_IDS`） |
| D17 | §3.1 只规定「隐藏」的触发条件，未规定显隐过程 | 窗口显隐拆成**广播 + 落地**两步：内核先 `emit('shell/visibility')` 让 UI 播动画，**等 UI 回执「离场最后一帧画出来了」再落地**（`HIDE_FALLBACK_MS`=500ms 兜底；壳侧另有 800ms 兜底防内核失联）；显隐的**裁决权仍在壳**（`window/toggled` 方向不变） | ADR-0004。透明无边框窗口的弹出感只能在 CSS 里做，而 UI 得先知道"要隐藏了"才播得了离场；固定时长会被不可控的广播延迟砍在淡出中途（半透明的一帧留在窗口里 = 下次唤出闪一下） |
| D18 | §6.1「壳只提供系统原语」 | `screenshot`（区域截图 → 系统剪贴板）**由内核直接 `execFile('screencapture')` 完成**，没有下沉到壳（`apps/shell/src/primitives/` 现有 clipboard / hotkey / notify / opener / tray / window，无 screenshot） | 交互式截图（`-i`）无法自动化验证，改壳＝改协议 + 重打包实机确认，收益不抵风险；先记录现状，等做「壳原语补全」时与其它系统调用一起下沉。**边界上这是内核唯一一处直接执行系统命令的地方**（`apps/kernel/src/services/shell.ts` 的 `screenshotFor`） |
| D19 | §3.1「选中文本带入」（2026-09-17 新增） | 读取由**壳**完成（`selection.read`，macOS Accessibility API），时机是 `window.show` 内部、**真正上屏之前**；结果随 `window.show` 返回值 / `window/toggled` 通知回到内核，由内核决定"填不填"（搜索框非空就不覆盖，见 `Kernel.applySelection`） | 窗口一显示，前台 App 就是自己，`AXFocusedUIElement` 拿到的选区随之消失 —— 这件事只有壳在 show 的那一刻做得到。策略（何时用、怎么用）留在内核，壳只提供"此刻前台选中了什么"这个事实 |
| D20 | §3.1「尺寸记忆」（2026-09-17 新增，同日由"仅本会话"改为"持久记忆"） | 记忆值存**内核 config**：`windowSizes.host` / `.plugin`（各 `{width,height}`）；UI 负责"什么时候读/写"（缩放结束后 debounce 提交、唤出/进插件页时应用），内核只做 `patchConfig` 与钳制 | 一开始写在 UI 侧且只活在本次会话（离场复位）；用户随后要求"下次打开仍是这个大小" ⇒ **必须落盘**，而 UI 的 localStorage 随内核端口变化（每次启动都变）不可用。放 config 还顺带让尺寸跟着 `config/changed` 广播走已有的同步链路 |
| D21 | §3.1「状态显示」（2026-09-17 新增） | 状态条显示的是**启动台自身**的占用：内核报自己（`process.memoryUsage.rss` / `process.cpuUsage`），壳用新原语 `app.usage` 报另一半（`task_info(MACH_TASK_BASIC_INFO)` 的 resident_size + user/system time），内核合并并差分出"占整机百分比"；UI 每 3s 拉 `/api/system/stats`；**不进插件 API**（底座自用，与 `app.info` 同级） | 用户要判断的是"这个启动台轻不轻"，所以要的是两个进程之和，不是整机负载 —— 整机数字（`node:os`）只留作 tooltip 里的对照。跨进程的"另一半"只有壳给得了（内核自己的 `os` 看不到壳的 RSS） |

---

## 9. 已知边界（安全）

| 面 | 现状 | 说明 |
|---|---|---|
| 脚本沙箱 | `script` / `no-view` 产物跑在 `worker_threads` 里，拥有完整 Node 权限（可读写文件、起子进程） | 这是"脚本命令"这一形态的固有代价（与 uTools/ZTools 一致）。审计记录调用，但无法阻止脚本自行 `child_process`。缓解：安装时展示 `exec.spawn` 高风险能力、可拒绝（拒绝后脚本无法被 `ctx.exec.run` 拉起，但用户仍可通过命令直接触发）。**若要真正沙箱化，需要给 worker 加 `--experimental-permission` 或换进程级沙箱，属于 v2 议题。** |
| 插件页网络 | CSP `connect-src 'self' https:` + `default-src 'self'`，禁止访问 `127.0.0.1` | 防止插件探测本机服务 |
| 插件页与宿主 | iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"` | 需要 `allow-same-origin` 才能用 `localStorage` / `ctx.storage` |
| 审计旁路 | 没有：所有插件→宿主调用都过 `BridgeDispatcher`（UI 侧）或 `ScriptRuntime.handleRpc`（脚本侧） | P6。唯一例外：底座基础能力（`essential` 出厂插件，不可禁用）的调用经 `AuditLog.setExempt` 豁免，不进环形缓冲与日志文件 |
| zip 安装 | 拒绝绝对路径 / `..` / 超大文件；**符号链接**：`adm-zip` 不还原符号链接（按普通文件处理），因此不存在链接逃逸 | 与需求 §9 的"拒符号链接"目标等价 |

---

## 10. 测试与验收

```bash
pnpm typecheck       # 15 个工作区包（含 packages/ui 与各插件，vue 工程走自己的 vue-tsc）
pnpm test            # 15 个测试文件：内核单元 / 契约 / 验收 + 插件 core·script 用例
pnpm build           # kernel + ui + 全部出厂插件
pnpm spec-check      # 出厂插件规范自检（清单 / N1 / N2 / N3 / 产物 / 远程资源）
pnpm app:local       # 打包自用 .app（M4 的自用形态；公证 / updater 未接）
```

出厂插件在真底座上另有两条端到端冒烟：

```bash
node scripts/smoke-real.mjs          # 真内核 + 8 个出厂插件
node scripts/smoke-first-batch.mjs   # 四个 Vue 插件端到端（HTTP 驱动，不起壳）
```

| 层 | 位置 | 覆盖 |
|---|---|---|
| 单元 | `tests/unit/` | 清单校验矩阵、历史排序/淘汰/原子写、路径穿越、审计打码、拼音匹配、Context 装配期裁剪（含 disposer 逆序） |
| 契约 | `tests/contract/` | `echo-plugin` 覆盖 §8.6 全表（含 `exec.run` / token 校验 / 未授权 / 管理面 `FORBIDDEN`） |
| 验收 | `tests/smoke/` | §1.3 口径：零插件可启动可搜索、装插件后立刻可搜、执行写历史、固定项持久化、禁用后命令消失而历史置灰、卸载后目录消失 |
| 插件用例 | `plugins/*/test/`、`packages/*` | 各插件的 core 纯函数与 script 胶水；`packages/ui` 等公共库（`pnpm test` 一并收集） |

**人工验收（自动化覆盖不到的部分）**：自动化已覆盖「会话能开、生产资源可达、桥与脚本正确、能力越权被拒、数据落点正确」；
下面这些在发版/大改后仍需人点一遍：粘贴→格式化→树视图（json-tools）、footer 按键与 `Esc` 分级退出、截图→粘贴导入（totp）、host-manager 的块开关与提权写入回读校验、拖拽重排后的固定顺序落库。
