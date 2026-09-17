# M5 实现计划：Rust 内核（阶段 A）→ Windows 平台（阶段 B）

> **状态**（2026-09-17）：**A0 / A1 / A2 / A3 已完成**（阶段 A 收尾；仅剩「换包实机」这一步需人工操作）。
> - **A0**：ADR-0005、文档 v2 修订、`packages/plugin-sdk-rs`、`scripts/parity-echo.mjs`（v1 worker ↔ v2 子进程 4/4 逐字段一致）。
> - **A1**：Rust 内核全部模块（契约 / 数据层 / 插件层 / 搜索链路 / 会话 + 服务层 / HTTP+SSE / 桥 / 插件管理 / 显隐 / `api.rs` 33 端点 / `kernel.rs` 装配），`cargo test --workspace` 内核 96 单测 + 7 集成全绿；**standalone 真实启动冒烟通过**（8/8 插件、搜索命中、SSE、落盘、干净退出）。
> - **A2**：五个出厂插件的逻辑层全部 Rust 化（web-open / file-search / host-manager / totp / app-launcher），`dist/<name>` 可执行产物，各插件 5–11 项单测；**顺带修掉 v1 的搜索延迟补位缺口**（慢源结果过去会被丢弃）。
> - **A3 已完成**：`spec-check` 认 v2 产物、v1 逻辑层残留清理（24 文件）、`build-all` / `dev.mjs` / `resources.mjs` / 壳 `sidecar.rs`（**净删 71 行 Node 搜索逻辑，直接执行内核二进制**）全部切换；**A3.2 测试矩阵落地** —— `tests/helpers/harness.ts` 改为 spawn 真内核二进制（假壳走 stdio、事件走 SSE），14 个测试全部移植并跑通，**顺带抓出并修掉两个内核真 bug**（壳 handler 内联 await 链路请求导致读循环死锁；多音字漏搜，见下）；**A3.1 清理完成** —— `apps/kernel` / `packages/plugin-api-node` / `scripts/parity-echo.mjs` 已删除，文档全线同步。
> **本文件的性质**：实施计划（roadmap + 分阶段设计 + 验收清单），**不是**需求源、**不是**对外契约。
> 落地第一步必须按 §A0.1 修订 `launcher-requirements.md`（需求唯一源）、`plugin-spec.md`（对外契约）与新增 ADR-0005 —— spec-first 铁律，先改文档再写代码。
> **动机**：① 把应用分享给使用 Windows 的同事（不能要求对方装 Node）；② 顺带把常驻内存与依赖形态收敛（Node 内核 121MB → Rust 内核目标 15–30MB）。
> **顺序**：先完成全 Rust（阶段 A，macOS 上跑通并换包），再做 Windows 平台化（阶段 B）。两阶段之间不并行改动同一批文件。

---

## 0. 决策摘要

| # | 决策 | 说明 |
|---|---|---|
| D1 | **内核换成 Rust**，保留全部对外契约 | 壳 ↔ 内核的 stdio JSON-RPC、UI ↔ 内核的 28 个 HTTP 端点 + SSE、插件 ↔ 宿主的 postMessage 桥 —— 三条协议**字段级不变** |
| D2 | **逻辑层插件（`no-view` / `script`）改为独立子进程 + NDJSON over stdio** | 消息类型（`result` / `done` / `log` / `progress` / `rpc`）与语义照搬现有 worker 协议；隔离、超时、失败计数、降级逻辑原样平移 |
| D3 | **视图层插件保持 Web（Vue + iframe），一行语言都不换** | WebView 里永远是 HTML/CSS/JS；`apps/launcher-ui` 与 4 个 Vue 插件只做「平台文案 + 样式微调」 |
| D4 | **不做 JS 插件兼容层**（明确不支持 `.mjs` 逻辑层产物） | 出厂插件全走 Rust 子进程 ⇒ 机器上不需要 Node，且这是**明确承诺**（沙箱外没有任何 JS 执行路径）。依据：`extensions/` 与 `devPlugins` 均为空、无第三方生态（2026-09-17 实测）。明确不支持 > 半支持。未来若确有需要，按 §A3.4 增量补（纯增量，不动协议与数据） |
| D5 | **数据格式一律不变** | `config.json` / `history.json` / `pinned.json` / `plugin-overrides.json` / `plugin-settings.json` / `quicklinks.json` / `logs/audit-*.jsonl` 与 `extensions/`、`plugins/<id>/` 布局逐字段兼容 |
| D6 | **Windows 作为阶段 B**，单独验收、单独打包 | 壳的平台分支、app-launcher / file-search 的 Windows 后端、NSIS 打包与给同事的安装包 |

### 0.1 目标 / 非目标

**目标**

- G1：macOS 上 Rust 内核全面接管，UI 与插件视图零视觉差异，31 个测试文件的断言在新宿主上全绿。
- G2：机器上**没有 Node** 也能完整运行（出厂插件全部为 Rust 子进程）。
- G3：Windows 10/11 上可安装、可唤出、可搜索、可启动应用、文件搜索可用、hosts 插件可用。
- G4：产出一个可以直接发给同事的 Windows 安装包 + 一页使用说明。

**明确不做**

- N1：不换 UI 技术栈（不引入 egui / 原生窗口 GUI）。
- N2：不支持 JS 逻辑层插件（`.mjs`）——apiVersion 2 只认可执行产物。想写逻辑层插件就用 Rust SDK；**视图层插件完全不受影响**（仍是 Web 技术，不用编译 Rust）。
- N3：不做 Linux（内核与壳的代码天然可移植，留给未来）。
- N4：不做代码签名 / 公证（自用分享，接受 Windows SmartScreen 首次提示）。
- N5：不做自动更新 / CI（可选，见 §B3.4）。

### 0.2 与三铁律的一致性

- **内核零能力**：Rust 内核依旧只做调度与协议；扫描 / 读写文件 / 启动 / 连网全部留在插件（现在变成 Rust 子进程）。
- **出厂插件与第三方同机制**：出厂插件走的就是 D2 协议，不比第三方多任何一个特权字段。`essential` / `internal-` 前缀 / `settings` 声明等机制原样搬运。
- **能力即权限**：capability 校验仍在装配期与调用期两处；子进程形态额外多一层——**未声明的能力对应的宿主 RPC 方法直接不注册**（见 §A0.2.6）。

---

## 1. 目标态总览

```
┌─────────────────────────────── macOS / Windows ───────────────────────────────┐
│                                                                                │
│  ┌── 壳（Rust / Tauri 2，系统原语）────────────────────────────┐               │
│  │  窗口 · 热键 · 托盘 · 单实例 · 通知 · 剪贴板 · open · 选中文本(NEW: UIA)      │
│  │  app.usage(NEW: Win)  —— 只提供原语，零业务                  │               │
│  └───────────────┬────────────────────────────────────────────┘               │
│                  │ stdio + newline JSON-RPC 2.0（不变）                        │
│  ┌───────────────▼── 内核（Rust, bin: launcher-kernel）───────┐                 │
│  │  协议层  link.rs（stdio） / http::server（28 端点 + SSE）     │                │
│  │  业务层  config / history / pinned / overrides / settings    │                │
│  │          plugin manager / registry / search / audit / legacy │                │
│  │  插件运行时  exec::runtime（子进程 + NDJSON）               │                │
│  │  插件页面托管  http::plugin_servers（每插件独立端口 + token） │                │
│  └───────┬────────────────────────────┬───────────────────────┘                 │
│          │ HTTP /api/* + SSE           │ spawn + NDJSON (stdin/stdout)           │
│  ┌───────▼──────────────┐     ┌────────▼─────────────────────────────┐          │
│  │ 启动台 UI（Vue，不变）│     │ 逻辑层插件进程（Rust 二进制，不变的是协议）│          │
│  └──────────────────────┘     └──────────────────────────────────────┘          │
│          ▲ iframe + postMessage（不变）                                        │
│  ┌───────┴──────────────┐                                                      │
│  │ 视图层插件（Vue，不变）│                                                      │
│  └──────────────────────┘                                                      │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 差异清单（谁被替换 / 谁不动）

| 组件 | 现状 | M5 后 | 动作 |
|---|---|---|---|
| `apps/shell`（Rust/Tauri） | 系统原语 | 同左 + 平台分支补全 | **改**（§A1.4、§B1） |
| `apps/kernel`（TS，38 文件 / 6951 行） | Node sidecar | 由 Rust 版取代（bin: `launcher-kernel`，同一路径） | **✅ 完成**（A1 期间先落 `rust/kernel` 避让；A3.1 删 TS 版后搬回 `apps/kernel`，代码留 git 历史） |
| `apps/launcher-ui`（Vue） | 启动台 UI | 同左 | **几乎不动**（3 处，§A3.3） |
| `packages/plugin-manifest`（TS 类型 + 校验） | 契约实现 | Rust 侧以 `serde` 类型 + 校验重写；TS 包继续服务视图层 SDK 与工具链（spec-check / 测试夹具） | **新增 Rust 版** |
| `packages/plugin-api`（view 侧 SDK） | postMessage 桥 | 同左 | **不动** |
| `packages/plugin-api-node`（script 侧 SDK） | Node worker API | 由 `packages/plugin-sdk-rs` 取代（JS 兼容层决定不做） | **✅ 已删除**（A3.1） |
| `plugins/*`（8 个） | 3 个纯 view + 5 个带脚本 | 3 个不动；5 个的 `no-view/` 重写为 Rust crate | **重写脚本侧** |
| `apps/shell/icons/*` | icns + png + template png | 增加 `.ico` 与彩色托盘图 | **新增产物** |
| `scripts/*.mjs` | 构建 / 打包 | 增加 Rust 内核与插件 crate 的构建；打包路径调整 | **改** |

---

### 1.2 目标占用（预估，A1/A2 收尾时用真实数据回填）

**实测锚点**（2026-09-17）：裸 Rust 进程 RSS **1.7 MB**；现状 Node 内核 121 MB（其中 Node 基线 47 + `pinyin-pro` 词典 17 + 2 个常驻 worker 隔离 30）；壳 103 MB。

**A1/A2 完成后实测回填**（standalone + 8 个出厂插件全部装配，取自 `/api/system/stats` 的 `app.rssKernel`）：**内核 RSS 13.64 MB** —— 落在预估区间下沿，且此时逻辑层是**真在跑**的（不含 Node 基线、不含 pinyin 词典外的额外开销）。

| 项 | macOS 现状 | macOS（M5 后） | Windows（M6 后，预估） |
|---|---|---|---|
| 壳进程 | 103 MB | 103 MB（阶段 A 不动壳） | 25–50 MB（没有 AppKit / WKWebView 宿主） |
| 内核进程 | 121 MB（含 worker 内存） | **13.6 MB（实测）** | 10–20 MB |
| 常驻插件子进程 | —（现在是内核里的线程） | 8–18 MB（app-launcher 6–14 + web-open 2–4） | 8–18 MB |
| **应用自身合计** | **224 MB** | **≈ 120–140 MB（省 ~90–100 MB）** | **43–88 MB** |
| WebView2 进程组 | —（WKWebView 未统计） | — | 100–200 MB（另计） |
| **整机实际** | ≈ 224 MB（WKWebView 另计） | ≈ 120–140 MB | **≈ 150–290 MB** |

- **磁盘**：macOS 9.2 MB → **20–30 MB**（Rust 内核 8–15 + 5 个插件二进制 5–8 + 壳 5.4 + ui 0.16 + 图标 0.9）；每个插件二进制静态链接了运行时，比 `.mjs` 大，但换来免 Node。Windows 便携目录 **20–35 MB**、NSIS 安装包 **12–20 MB**（WebView2 用系统自带）。
- **启动**：内核就绪从 Node 的数百毫秒降到预计 **20–80 ms**；插件冷启 5–20 ms。
- **连带必做**（否则用户看到"占用忽然变小"的假象——内存只是从内核搬到子进程）：状态条口径扩展为**壳 + 内核 + 所有插件子进程**；Windows 上再把 `msedgewebview2.exe` 子进程求和（§B1.6）。

> 区间的不确定性来自 Rust 依赖（pinyin 词典、zip / plist / notify）与分配器行为；**内核那行已按 A1/A2 实测回填（13.6 MB）**，"闲置 RSS ≤ 30 MB"的验收线成立且有余量。常驻插件子进程（app-launcher / web-open 的 search 进程）与"应用自身合计"待 A3 收尾时用同样口径补测。

## 阶段 A0 —— 契约与 SDK（先改文档，再写代码）

**工期**：AI 实现 1–2 小时｜人工 3–5 天

### A0.1 需要先修订的文档（逐条）

| 文件 | 改动 |
|---|---|
| `docs/decisions/ADR-0005-kernel-language.md`（新增） | 记录 D1/D2/D4 三条决策、被否方案（内嵌 V8 / QuickJS / dylib 直接加载）与理由 |
| `docs/launcher-requirements.md` §4.1 | 进程与通信：内核语言改为 Rust；写明「协议不变、语言无关」 |
| 同上 §7 | 章节标题与内容从「内核规格（TypeScript）」改为「内核规格（语言无关）」；模块名对齐 Rust crate 结构（§A1.1） |
| 同上 §8.7 | 「Node 侧 API」→「插件运行时（逻辑层）API」：命令产物改为可执行文件 |
| 同上 §13 | 新增 **M5 — Rust 内核**、**M6 — Windows 平台** 两个里程碑与验收 |
| 同上 §14 | 第 4 条平台项更新：Windows 由「M4 之后单独立项」改为「M6」 |
| `docs/plugin-spec.md` §2.2 | 产物规范：逻辑层产物为 `<name>`（Windows `<name>.exe`），可执行权限 0755 |
| 同上 §4.2 / §4.3 | `no-view` / `script` 的运行方式改为「宿主 spawn 子进程 + NDJSON」 |
| 同上 §4.4（新增） | 逻辑层运行时全表：产物与查找顺序 / 上下文注入 / 双向消息表 / SDK 对照 / 生命周期与超时降级 —— 与 v1 语义逐条对齐 |
| 同上 §11 | 版本与兼容：`apiVersion: 2`；**v1 的 `.mjs` 逻辑层产物不再支持**（D4）；视图层插件不受版本影响 |
| `docs/plugin-dev-guide.md` | 新增「Rust 插件」章节：工程结构、SDK 用法、构建与打包 |
| 规则 `chassis-plugin` / `chassis-core` | 逻辑层插件的硬约束改写（产物名 = 命令名这条保留；新增"必须用 SDK 读写 ctx"等） |

### A0.2 子进程插件协议（apiVersion 2）

#### A0.2.1 产物与查找顺序

```
<pluginRoot>/dist/<name>          # macOS / Linux（0755）
<pluginRoot>/dist/<name>.exe      # Windows
<pluginRoot>/dist/workers/<name>  # 备选位置（与 v1 对齐）
```

查找顺序：`<name>(.exe)` → `workers/<name>(.exe)`。v1 的 `.mjs` / `workers/*.mjs` 与 JS 运行时**不再支持**（见 §A3.4）；找不到产物时命令报 `ENTRY_MISSING`（错误码不变）。

#### A0.2.2 启动与上下文注入

宿主 spawn：

```
launcher-plugin-<name> --mode run|search [--launcher-context <base64url JSON>]
```

`context` 字段（与 v1 `workerData` 一一对应）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `pluginId` | string | 插件 id |
| `command` | string | 命令名（= 产物文件名） |
| `pluginPath` | string | 插件根目录绝对路径 |
| `dataPath` | string | 插件唯一可写目录 `<dataRoot>/plugins/<id>/` |
| `dataRoot` | string | 数据根 |
| `mode` | `"run"` \| `"search"` | 一次性执行 / 贡献型常驻 |
| `args` | any | `mode=run` 的入参 |
| `settings` | object | 生效设置快照（用户值 ?? 清单默认） |
| `host` | string | `"launcher"`（恒为常量，供插件自检） |
| `apiVersion` | number | `2` |

另外注入环境变量 `LAUNCHER_PLUGIN_ID` / `LAUNCHER_DATA_PATH`（便于插件在极早期（如 panic hook）自报身份）。

#### A0.2.3 消息协议（NDJSON，双向）

插件 → 宿主（stdout，每行一个 JSON）：

| type | 字段 | 语义 | 与 v1 对应 |
|---|---|---|---|
| `result` | `data` | 递交结果（可多次，后到的追加） | 同 `postMessage({type:'result'})` |
| `done` | — | 本次执行结束（`run` 的唯一结束信号） | 同 `done()` |
| `log` | `level`, `message` | 日志（`debug`/`info`/`warn`/`error`） | 同 `log()` |
| `progress` | `data` | 进度（仅记日志） | 同 `progress()` |
| `rpc` | `id`, `method`, `params` | 调用宿主（`storage` 等） | 同 RPC 消息 |

宿主 → 插件（stdin）：

| type | 字段 | 语义 |
|---|---|---|
| `query` | `token`, `query` | `mode=search`：新查询（可打断上一次） |
| `rpc-result` | `id`, `ok`, `data?`, `error?` | RPC 应答 |
| `shutdown` | — | 宿主要求退出（插件应尽快 exit） |

**约定**：stdout 只能出现协议行（`log` 走协议、不要直接 print 到 stdout）；插件的野 stdout 一律由宿主**按行当协议解析失败后转入日志**（宽容处理，与 v1 的 `pipeOutput` 语义一致）。stderr 一律作为 `warn` 级日志转发。

#### A0.2.4 生命周期、超时与降级

| 场景 | 行为 |
|---|---|
| `run` | spawn → 等 `done` → 内部 `terminate`（SIGTERM，2s 后 SIGKILL）；超时 `TIMEOUT`（默认 10s，上限 5min） |
| `search` | 常驻；每查询写一行 `query`（宿主预热后可立即下发：SDK 缓冲 handler 注册前的 query）；空闲 5 分钟回收；每插件并发上限 4，队列排队 |
| 崩溃 | 非零退出 → `onFailure` 计数 +1；连续 3 次 → 该命令 `degraded`（搜索结果静默置空，UI 不报错） |
| 孤儿 | 宿主退出时关闭所有子进程 stdin 并 `kill`；插件侧应处理 stdin EOF 自行退出（SDK 已内建） |
| 输出过大 | 单行 > 1MB 截断并记 `warn`（防 OOM） |

#### A0.2.5 与 v1 的对照表（迁移手册）

| v1（worker_threads） | v2（子进程） | 备注 |
|---|---|---|
| `new Worker(entry, { workerData })` | `Command::new(entry).arg("--launcher-context")` | 入口从 `.mjs` 变成可执行文件 |
| `parentPort.postMessage` | 写 stdout 一行 | 语义相同 |
| `onQuery(cb)` | 读 stdin 的 `{type:'query'}` | SDK 内建循环 |
| `ctx()` | 解析 `--launcher-context` | 字段一一对应 |
| `done(data)` / `fail(err)` | 写 `{type:'result'}` + `{type:'done'}` | `fail` → `{type:'result', data:{__error}}`，宿主沿用现有 `isFailurePayload` 判定 |
| worker 内 `storage.call` | `rpc` 消息往返 | 宿主侧 `handleRpcMessage` 逻辑照搬 |

#### A0.2.6 能力与权限（子进程形态）

- **装配期**：清单校验照旧（`manifest-keys` 白名单、`commands[].name` = 产物名、`capabilities` 表）。
- **调用期**：宿主 RPC 方法在注册时按插件 capability 过滤（v1 的 `audited()` 语义保留），未声明 ⇒ 方法不存在 ⇒ 插件收到 `NOT_FOUND`。
- **子进程自身**：进程权限 = 当前用户权限（与 v1 worker 相同）；不引入额外的沙箱承诺（WASM 才有），文档需明说。

### A0.3 Rust 插件 SDK（`packages/plugin-sdk-rs`）

```
packages/plugin-sdk-rs/
  Cargo.toml                 # package: launcher-plugin-sdk（由仓库根 Cargo.toml 的 workspace 引入）
  src/lib.rs                 # pub fn run(...) 收口：解析 context → 分发 → 收尾（panic → fail）
  src/context.rs             # Context { plugin_id, data_path, args, settings, ... } + stdin reader + executor
  src/protocol.rs            # 消息类型（serde）与 NDJSON 行构造
  src/output.rs              # stdout 行输出（写完 flush；多线程写用锁收口）
  src/rpc.rs                 # call(method, params) 同步等待 rpc-result（默认 5s 超时）
  src/log.rs                 # log / progress 方法（走协议行，不用宏）
  src/search.rs              # on_query(|query, token| ...) 常驻循环 + wait_shutdown
  examples/echo.rs           # 协议 fixture（对应 tests/fixtures/echo-plugin）
```

API 形状（与 `@launcher/api-node` 对标）：

```rust
fn main() {
    launcher_plugin_sdk::run(|ctx| {
        match ctx.mode() {
            Mode::Run => {
                let args = ctx.args::<MyArgs>()?;
                let out = do_work(ctx, &args)?;
                ctx.done(json!(out))?;                                  // 等价 v1 done(out)
            }
            Mode::Search => ctx.on_query(|query, _token| search(ctx, query))?,  // 等价 v1 onQuery
        }
        Ok(())
    });
}
```

依赖：`serde` / `serde_json` / `base64`。**不引入 tokio**——同步阻塞 + 内部 reader / executor 两个线程（`rpc` 等待由 reader 线程唤醒；handler 在 executor 线程跑，可以安全地在里面发起 RPC）。
细节：**宿主预热后可立即下发 `query`**，SDK 会缓冲 handler 注册前到达的 query（≤32 条），注册后补投 —— 与 v1 的 worker 消息端口缓冲语义对齐。

### A0.4 验收

1. ✅ `node scripts/parity-echo.mjs`：同一个 Node 假宿主同时拉起 v1（worker）与 v2（`target/debug/examples/echo`），4/4 用例（compute / compute-fail / job【log+progress+storage RPC】/ feed【query→result】）事件序列与最终结果逐字段一致。**这是后续所有阶段的回归门**（A1 / A2 的宿主实现要让它继续全绿）。
2. ✅ `plugin-spec.md` 已升 v2：§2.2（可执行产物）/ §4.2 / §4.3（子进程语义）/ §4.4（逻辑层运行时，新增）/ §11（apiVersion 2 兼容规则）；`requirements` §4.1 / §7 / §8.7 / §13（M5、M6）/ §14 与 `ADR-0005` 同步完成。
3. 附带落地：`packages/plugin-sdk-rs`（6 个单测全绿）、仓库根 `Cargo.toml`（workspace；布局修正见 §A1.1）、`scripts/parity-echo.mjs`。

---

## 阶段 A1 —— Rust 内核骨架

**工期**：AI 实现 4–6 小时｜人工 3–4 周

### A1.1 crate 与模块划分（TS → Rust 映射表）

```text
Cargo.toml                         # 仓库根 workspace（2026-09-17 修正：Cargo 要求成员位于根**之下**，而成员分散在
                                   # packages/、apps/ 与 plugins/ 三处）；exclude = ["apps/shell"]
apps/kernel/                       # bin: launcher-kernel（成员；A1 期间先落 rust/kernel 避让 v1 的 apps/kernel，
                                   # A3 删掉 TS 版后搬回同一路径）
packages/plugin-sdk-rs/            # launcher-plugin-sdk（成员，A0 已落地）
plugins/<id>/                      # 各插件逻辑层 crate（成员，A2；crate 根 = 插件目录，源码在 src/）
target/                            # workspace 统一产物（.gitignore 已忽略）
```

SDK 固定在 `packages/plugin-sdk-rs/`（与它替代的 `packages/plugin-api-node` 对称），由 workspace 的 members 引入。

| 现有 TS | Rust 模块（`apps/kernel/src/` 下） | 行数量级 | 要点 |
|---|---|---|---|
| `main.ts` | `main.rs` | ~150 | CLI 解析（`--data-root` / `--builtin-plugins` / `--ui-dist` / `--ui-dev` / `--standalone`）、console → stderr、信号、stdin EOF 退出 |
| `jsonrpc.ts` | `link.rs` | ~250 | NDJSON 收发、pending map、超时、`handle()` 注册、断连清理 |
| `kernel.ts` | `kernel.rs` | ~700 | 编排：start/stop、`patchConfig` 收口、tray 注册、`applySelection`、`quit()` |
| `api.ts` | `api.rs` | ~600 | 28 个端点的参数校验 + 分发 + SSE 广播 |
| `http/server.ts` | `http/server.rs` | ~300 | axum 路由、静态托管（UI dist / ui-dev 反代）、CSP、只绑 127.0.0.1 |
| `http/pluginServers.ts` | `http/plugin_servers.rs` | ~250 | 每插件独立 listener + sid/token 三重校验 + 端口分配 |
| `config.ts` | `config.rs` | ~300 | 默认值 / 迁移 / 清洗 / 原子写；`defaultDataRoot()` 分平台 |
| `history.ts` | `history.rs` | ~350 | 滚动、去重、`migratePluginIds()`、`dropHistoryBy` |
| `registry.ts` / `pipeline.ts` / `search.ts` | `registry.rs` / `pipeline.rs` / `search.rs` | ~800 | 注册表、排序与打分、节流（80ms）、`MAX_RESULTS` |
| `pinyin.ts` | `search/pinyin.rs` | ~250 | **换 Rust 实现**（见 §A1.2），命中面与权重照搬规则：前缀 1.0 / 包含 0.7 / 全拼 0.6 / 首字母 0.5 / subtitle 与 keywords 0.4 |
| `plugin.ts` / `pluginAdmin.ts` / `pluginSettings.ts` | `plugin/{manager,admin,settings}.rs` | ~1200 | 扫描（`dist/package.json` 为插件根）、启用/禁用、`reloadOrLoad`、zip 安装、`pruneEssentialDisabled` |
| `services/exec.ts` | `exec/runtime.rs` | ~600 | 子进程插件运行时（§A0.2.4 全部语义） |
| `services/{shell,bridge,hostUi,storage,settings,kernel}.ts` | `services/*.rs` | ~900 | 原语转发、postMessage 桥、hostUi、storage、settings 注入 |
| `services/quicklink.ts` / `systemStats.ts` | `services/*.rs` | ~350 | 快捷链接、状态条采样（口径不变） |
| `audit.ts` | `audit.rs` | ~250 | jsonl 滚动 7 天、`setExempt` |
| `overrides.ts` / `legacy.ts` | `overrides.rs` / `legacy.rs` | ~300 | 别名覆盖、`RENAME_CHAINS` 改名链（逐条搬运，勿重设计） |
| `session.ts` / `windowVisibility.ts` / `events.ts` | `session.rs` / `window_visibility.rs` / `events.rs` | ~400 | 会话状态机、显隐广播 + 隐藏回执清理（`HIDE_AT_MS`）、SSE 事件总线 |
| `util/fsx.ts` / `util/text.ts` | `util/{fsx,text}.rs` | ~150 | 原子写（tempfile + rename）、文本工具 |

**行数合计估计**：10,000–13,000 行（含 serde 类型定义；TS 里可以 `any` 的地方 Rust 必须显式建模，这是行数增量的主要来源）。

### A1.2 依赖选型

| 用途 | TS 现状 | Rust 选型 | 说明 |
|---|---|---|---|
| 异步运行时 | Node 事件循环 | `tokio`（rt-multi-thread） | |
| HTTP + SSE | `node:http` 手写 | `axum` + `tokio-stream` | SSE 用 `axum::response::sse` |
| 序列化 | 原生 JSON | `serde` / `serde_json` | 字段名全部 `#[serde(rename_all = "camelCase")]` 对齐前端 |
| 文件监听 | `chokidar` | `notify` | 插件目录热重载 |
| zip | `adm-zip` | `zip` | 插件 zip 安装 |
| plist | `simple-plist` | `plist` | app-launcher 读 `Info.plist` |
| 拼音 | `pinyin-pro` | `pinyin`（rust-pinyin，内置词典） | 需自实现"全拼/首字母"两种模式与缓存；**这是唯一需要行为对齐验证的替换** |
| 哈希 | `node:crypto` sha1 | `sha1` | 图标缓存 key |
| 图标（macOS icns→png） | 调 `sips` | 先保留调 `sips`（零风险） | 可选升级：`icns` + `image` 自解析（不再依赖外部命令） |
| 时间 | `Date` | `std::time` / `chrono` | |
| 日志 | 手写 stderr | 手写 stderr（保持 `[kernel:x]` 前缀格式） | 不要引 `tracing` 的默认格式，日志格式是排障接口 |

### A1.3 协议实现清单（三张表 = 实现 checklist）

**(1) 壳 ↔ 内核（stdio JSON-RPC）—— 不变，逐条实现**

内核 → 壳（21 个方法，壳侧 `primitives::dispatch` 已实现）：`window.show`/`window.hide`/`window.isVisible`/`window.setHeight`/`window.setSize`/`window.startDragging`/`window.startResizeDragging`/`selection.read`/`hotkey.register`/`hotkey.unregister`/`tray.setMenu`/`notify.show`/`clipboard.readText`/`clipboard.writeText`/`open.url`/`open.path`/`open.reveal`/`app.setAutostart`/`app.info`/`app.usage`/`app.quit`。

壳 → 内核（5 个方法 + 2 个通知）：`kernel/ready`（就绪探询，返回 `{ready, uiPort, dataRoot, version}`）、`app/shutdown`、`window/toggled`（含 `selection`）、`tray/menu`、`window/blurred`；通知 `kernel/booting` / `kernel/ready`。

**(2) UI ↔ 内核 HTTP（28 个端点）—— 不变**

`/api/bootstrap`、`/api/search`、`/api/invoke`、`/api/exec`、`/api/bridge`、`/api/config`、`/api/history`（GET/DELETE）`/api/history/remove`、`/api/history/clear`、`/api/pinned/toggle`、`/api/pinned/reorder`、`/api/plugins`、`/api/plugins/action`、`/api/session/close`、`/api/session/crashed`、`/api/audit/clear`、`/api/data/openDir`、`/api/system/stats`、`/api/ui/theme`、`/api/window/show|hide|visible|setHeight|setSize|startDrag|startResize|hidden`、`/api/app/quit`。

**(3) SSE 事件（12 个）—— 不变**

`search/query`、`shell/visibility`、`ui/searchContent`、`ui/footer`、`ui/hide`、`config/changed`、`history/changed`、`pinned/changed`、`plugin/state`、`plugin/reloaded`、`session/closed`、`app/quit`。

> 实现建议：把这三张表做成 `apps/kernel/tests/protocol_parity.rs` 里的常量数组，一侧断言"端点/事件已注册"，另一侧让现有 `tests/contract/*` 与 `tests/unit/config-events.test.ts` 等当黑盒跑过。

### A1.4 壳侧改动（`apps/shell`）

| 文件 | 改动 |
|---|---|
| `sidecar.rs` | `node_binary()` → `kernel_binary()`：`LAUNCHER_KERNEL_BIN` env → `<resource_dir>/kernel/launcher-kernel(.exe)` → dev 态向上找 `target/{release,debug}/launcher-kernel` → cwd。**supervisor / wait_ready / 日志转发 / `MAX_RESTARTS` 一行不改** |
| `sidecar.rs` | `data_root()` 的分平台统一（见 §A1.5） |
| `lib.rs` | 启动横幅日志文案（"内核已启动"后的 node 版本信息改为内核版本） |
| `Cargo.toml` | 无变化（壳仍独立 workspace 成员） |

### A1.5 数据兼容与迁移

- **格式不变**：Rust 侧按现有 JSON schema 读写（字段名 camelCase），**不加新字段**。
- **数据目录统一**（顺带修一个潜在分叉）：壳与内核都用「应用名」而不是 bundle identifier —— macOS `~/Library/Application Support/Chassis`；Windows `%APPDATA%\Chassis`。壳侧 Windows 分支不再走 `app_data_dir()`，改为 `std::env::var("APPDATA") + APP_DATA_DIR_NAME`。
- **改名链**：`legacy.rs` 的 `RENAME_CHAINS` / `LEGACY_DATA_DIR_IDS` / `LEGACY_ID_TO_CURRENT` 逐条搬；`adopt_legacy_data_dir()`（壳侧，仅在数据目录不存在时复制一次）保持不变。
- **回归方式**：用**现网数据目录的副本**跑 Rust 内核（`--data-root /tmp/chassis-copy`），断言：历史条数、固定项、插件禁用状态、别名覆盖、设置值逐项与 TS 版一致（写一个小对拍脚本 `scripts/parity-data.mjs`）。

### A1.6 构建与产物

- workspace 在**仓库根** `Cargo.toml`（成员分散在 packages/、apps/ 与 plugins/ 三处，只有根能罩住）：`members` 逐个列出 `packages/plugin-sdk-rs`、`apps/kernel` 与 5 个逻辑层插件 `plugins/<id>`（A1 / A2 加入；**不写 `plugins/*` glob** —— 它会匹配到没有清单的纯 view 插件目录而报错），`apps/shell` 显式 `exclude`（保护现有 `apps/shell/target` 与打包脚本的路径假设）。产物统一在仓库根 `target/`（已 gitignore）。
- 内核产物：`target/release/launcher-kernel`（约 8–15MB，`lto=true, opt-level="s", strip=true, panic="abort"` 与壳同款 profile）。
- `scripts/build-all.mjs` 增加一步：`cargo build --release -p launcher-kernel`，并拷进 `apps/shell/resources/kernel/launcher-kernel`（替代 `kernel.mjs`）。
- `scripts/lib/resources.mjs` 的 `assembleResources()` 同步改（资源目录名不变，文件名变）。
- `pack-local-app.mjs`：`Resources/kernel/` 下改为 `launcher-kernel`；`--skip-build` 语义不变。
- **CI 骨架建议在 A1 就建**：`.github/workflows/verify.yml`（ubuntu 上跑 `pnpm typecheck` + `pnpm test` + `cargo test --workspace`），Rust 代码一落地就有回归门（详见 §B3.7）。

### A1.7 验收

1. `pnpm dev:kernel`（改成 `cargo run -p launcher-kernel -- --standalone`）+ `pnpm dev:ui`：UI 全部功能可用，8 个插件的 view 打开正常。
2. 现有契约测试全部以 Rust 内核为目标跑过：`tests/contract/*`（`shell-link` / `capability` / `echo`）、`tests/unit/{config-events,security,history,overrides,window-sizes,theme-priority,system-stats}.test.ts`。
3. 数据对拍脚本通过（§A1.5）。
4. 内存：闲置 RSS ≤ 30MB（不含插件子进程）。
5. `node` 从 PATH 移除后（或 `LAUNCHER_NODE=/nonexistent`）全流程仍可用（G2）。

---

## 阶段 A2 —— 逻辑层插件 Rust 化

**工期**：AI 实现 2–3 小时｜人工 2–3 周

### A2.1 构建体系

- 每个插件新增 `Cargo.toml`（crate 根 = 插件目录，Rust 源码直接放同目录 `src/`），由仓库根 workspace 的 `members` 逐个列入。
- `package.json` 的 `build:scripts` 改为：`cargo build --release -p <plugin-crate> && node ../../scripts/build-plugin.mjs <id> --copy-scripts`（`build-plugin.mjs` 扩展一个模式：把**仓库根** `target/release/<bin>` 复制为 `dist/<name>` + 0755）。
- 产物形态对齐规则：`commands[].name` == 产物文件名（**这条铁律不变**）。
- `scripts/spec-check.mjs` 的 N1（同名产物）检查：改为"`dist/<name>(.exe)` 可执行产物存在"（`.mjs` 不再算合规产物，见 §A3.4）。

### A2.2 逐插件任务

| # | 插件 | 现有 TS | Rust 任务 | 验收 |
|---|---|---|---|---|
| 1 | `web-open` | `no-view/web.ts` 23 行 + `core/parse.ts` | 最小改造（`parse` 的逻辑一并搬，注意与 view 侧 `core/parse` 的**双份化**：只有 URL 解析与引擎表） | 搜网址 → 一条结果 → `open.url` 正确 |
| 2 | `app-launcher` | `no-view/{search,refresh}.ts` + `core/{scanner,plist,icons,match,store}` ≈ 780 行 | 全套搬：plist 解析（`plist` crate）、icns→png（先调 `sips`）、索引读写、`match` 打分（与 `pinyin` 共享打分实现，避免两套） | 冷启动扫描 / 热搜索 / 刷新命令 / 图标显示 |
| 3 | `file-search` | `no-view/{files,reveal}.ts` + `core/spotlight.ts` ≈ 130 行 | 搬 `mdfind` 调用（macOS）；`reveal` 走宿主 `open.reveal` | 搜文件 → 打开 / 显示 |
| 4 | `host-manager` | `no-view/{hosts-read,hosts-write,_hosts-file}.ts` ≈ 490 行 | 搬"手术式写入"（区外逐字节不动）、备份、提权（osascript）、回读校验；**`blocks.ts` 的两个函数双份化**（§A2.3） | `tests` 里现有 27 条 script 用例的等价 Rust 测试；真机读写 + 区外字节不动断言 |
| 5 | `totp` | `no-view/{read-image,find-image}.ts` ≈ 275 行 | 搬文件扫描 + 魔数校验 + base64 返回 | 截图路径读取 → 二维码解码（view 侧） |

### A2.3 共享逻辑双份化（唯一一处）

- 范围：`plugins/host-manager/src/core/blocks.ts` 的 **`removeOutsideLines` / `spliceRegion`**（被 `no-view/_hosts-file.ts` 与 6 个 `.vue` 同时使用）。
- 做法：TS 版保留（视图实时预览用）；Rust 版新增（写入用）；**建共享 fixture 向量** `plugins/host-manager/test/fixtures/blocks-vectors.json`（输入文件 + 操作序列 → 期望输出），两侧各有一个测试读它。
- 其余 core（`hosts.ts` / `runner.ts` / `snapshots.ts` / json-tools 与 text-diff 的全部 core）**只在视图里跑，不动**。

### A2.4 验收

- 5 个插件的每条命令手工点一遍（`invoke` 通道 + 真实 UI 入口各一次）。
- 插件目录 `cargo test` + 仓库 `pnpm test`（TS 侧剩 view 插件与契约测试）。
- 打包后 `builtin-plugins/<id>/dist/` 内既无 `.mjs` 也无 `node_modules`（G2 的物证）。

---

## 阶段 A3 —— 收尾（macOS 交付）

**工期**：AI 实现 2–3 小时｜人工 1–2 周

### A3.1 清理

- 删除 `apps/kernel`（TS 内核）与其构建步骤、`tsconfig` 引用、`tests` 中针对 TS 内核实现的单测（改写成对 Rust 内核的黑盒/契约测试）。
- 保留 `packages/plugin-manifest`（TS）：视图层 SDK、工具链与测试夹具需要类型；Rust 侧是独立实现（**注意：两份契约类型要同步维护，纳入 spec-check**）。
- **删除** `packages/plugin-api-node`（兼容层不做，见 §A3.4；`tests/fixtures/echo-plugin` 同步改写为 Rust fixture）。代码留在 git 历史里，需要时随时取回。

### A3.2 测试矩阵

| 层 | 命令 | 通过标准 |
|---|---|---|
| Rust | `cargo test --workspace` | 协议一致性、运行时、拼音打分、数据兼容、hosts 手术式写入 |
| TS | `pnpm typecheck && pnpm test` | 契约 / 单测 / 冒烟（JS 侧） |
| 端到端 | `node scripts/smoke-real.mjs`（改造：内核换成 Rust bin） | 真内核 + 真插件冒烟 |
| 数据 | `node scripts/parity-data.mjs` | 与 TS 版读数一致 |
| 交付 | `pnpm app:local` + 换包 | 包内 `launcher-kernel` 可执行、8 插件可用、日志无 error |

### A3.3 UI 侧改动（全部，共 3 处）

1. 平台快捷键文案：`⌘` / `Cmd+` 的 14 处命中（`apps/launcher-ui/src/{App.vue,components/{FooterBar,SearchBox}.vue,lib/keys.ts}`、`packages/ui/lib/{keys,clipboard}.ts`、`plugins/{host-manager,internal-settings,totp}` 的界面）改用已有的 `Mod` 判断渲染。
2. Windows 实机样式微调（阶段 B 一并做）：字体栈、滚动条、透明窗口相关 CSS。
3. 其余为确认项：`lib/api.ts` 的 28 端点与 SSE 事件名单**一个字不动**。

### A3.4 JS 插件兼容层（决定：**不做**）

**决定（2026-09-17，用户拍板）**：不实现 JS 兼容层。依据（实测）：`<dataRoot>/extensions/` 为空、`config.devPlugins` 为空、无第三方插件生态、无插件市场；5 个出厂插件的逻辑层全部 Rust 化后，**没有任何消费者**。明确不支持 > 半支持——若留下"能跑但要装 Node、且只在部分机器上能跑"的状态，同事机器上的行为无法解释，也会让"免 Node"从承诺降级为打折保证。

**保留的后路（成本为零，不必现在写）**：
1. `plugin-spec` 的产物规范按"形态分派"表述（逻辑层产物 = 可执行文件）；未来若要支持 `.mjs`，**只加一节**，不改既有条款。
2. 本节保留为设计备注。
3. 触发条件（满足任一条再回头补，属纯增量：adapter 文件 + 一个 runtime 分支，不动协议与数据）：① 你自己写出并长期使用一个 JS 插件；② 需要把某个 JS 插件分发到没有 Node 的机器（此时**更应重写成 Rust**）；③ 出现外部插件作者。

**常见疑虑的替代答案**：想"不编译、随手写个插件"——**视图层插件本来就满足**（Vue + iframe，放进 `dist/` 刷新即生效，无编译步骤）；逻辑层插件要访问文件系统 / 系统命令，本来也只在"真需要"时才写，用 Rust SDK 的模板起手即可（§A0.3，`cargo build` 一条命令）。

---

## 阶段 B —— Windows 平台化

**工期**：AI 实现 8–12 小时｜人工 3–5 周（含实机调试）

### B1 壳侧（逐项）

| # | 项 | 现状 | Windows 做法 |
|---|---|---|---|
| B1.1 | 内核二进制 | `node_binary()` 搜 homebrew/nvm/fnm | A1.4 已改为 `kernel_binary()`；Windows 分支找 `<resource_dir>/kernel/launcher-kernel.exe` |
| B1.2 | 数据目录 | 手工拼 macOS 路径 | `%APPDATA%\Chassis`（§A1.5 已统一） |
| B1.3 | 热键 | 默认 `Alt+Space`；回退链含 `Cmd+*` | 默认 `Ctrl+Shift+Space`（`Alt+Space` 在 Windows 是系统窗口菜单键）；回退链分平台：`Ctrl+Space` → `Ctrl+Alt+Space` → `F1` → `Shift+F1` |
| B1.4 | 托盘 | template 图标（只取 alpha，系统反色） | 出**彩色托盘图**（应用图标缩版）；`icon_as_template(true)` 仅 macOS 调用；Windows 托盘左键/右键行为按平台规范（左键 toggle、右键菜单） |
| B1.5 | 选中文本（`selection.read`） | AX API | UI Automation：`CoInitialize` → `IUIAutomation::GetFocusedElement` → `TextPattern`(或 `ValuePattern`) 取选区；不可用时返回 `{ok:false, reason:'unsupported'}`（**不改协议**） |
| B1.6 | `app.usage` | mach `task_info` | `GetProcessMemoryInfo`（WorkingSetSize）+ `GetProcessTimes`；**顺带**：把 `msedgewebview2.exe` 子进程一起求和（Windows 上 WebView2 独立成进程组，不加会低估） |
| B1.7 | 截图原语 | `screencapture -i -c`（darwin only） | 可选：唤起 `explorer ms-screenclip:`（系统截图 → 剪贴板）；做不到就保持 `false` 降级 |
| B1.8 | 透明无边框窗口 | macOS 调优过（阴影/圆角/失焦时序） | Windows 实测重调：透明窗口边缘、DWM 阴影、`SHOW_GRACE_MS` 与隐藏回执链路参数；必要时去掉 CSS 阴影改由 DWM 提供 |
| B1.9 | 自启动 | LaunchAgent | 注册表 `Run` 键（`tauri_plugin_autostart` 自动分平台，验证参数即可） |
| B1.10 | 通知 | 系统通知 | AUMID：NSIS 安装会创建开始菜单快捷方式后通知正常；便携模式通知可能显示异常，文档说明 |
| B1.11 | 单实例 | mutex（插件已跨平台） | 验证：第二实例唤出 + 参数转发 |
| B1.12 | 拖动 / 缩放 | `start_dragging` / `start_resize_dragging` + IPC 兜底 | 验证；`.drag-strip` 的 `-webkit-app-region` 在 WebView2 无效（已有 IPC 兜底，确认可用即可） |

### B2 插件侧（Windows 后端）

| # | 插件 | 任务 | 估工 |
|---|---|---|---|
| B2.1 | `app-launcher` | 扫描后端：开始菜单（`%ProgramData%\Microsoft\Windows\Start Menu\Programs`、`%APPDATA%\...\Start Menu\Programs`）+ 桌面 + 注册表 `App Paths` + UWP（`shell:AppsFolder`）；`.lnk` 解析（`IShellLink` COM）；图标提取（`SHGetFileInfo` / `ExtractIconEx` → `image` 编码 PNG data URL，沿用现有缓存目录与 hash key 规则） | 3–5 天 |
| B2.2 | `file-search` | 后端二选一：**优先 Everything**（用户装了就用其 IPC/HTTP 接口）；回退**自建索引**（扫固定盘 + `notify` 增量 + 内存索引）；`reveal` 走 `open.reveal`（壳已支持 `explorer /select,`） | 3–5 天 |
| B2.3 | `host-manager` | hosts 路径 `%SystemRoot%\System32\drivers\etc\hosts`（已有）；提权走 UAC：`ShellExecuteEx(verb=runas)` 调 PowerShell 复制 → 已有 TS 参考实现，翻译即可 | 0.5 天 |
| B2.4 | `totp` | 默认扫描目录已含 `Pictures\Screenshots`；验证即可 | 0.5 天 |
| B2.5 | `web-open` / 其余 view 插件 | 无改动 | — |

### B3 打包与分发

1. **构建通道（已定，2026-09-17）**：**GitHub Actions**，`macos-latest` + `windows-latest` 双 job；仓库后续**公开**（MIT），公开仓库的 Actions **免费且无额度限制**（私有仓库下 macOS runner 按 10× 计费，公开后这一项消失）。两端的产物都在 CI 上原生编译，不做交叉编译。
2. `tauri.conf.json`：`bundle.targets` 增加 `"nsis"`；`icon` 增加 `icons/icon.ico`；`webviewInstallMode` 用 `downloadBootstrapper`（安装时自取 WebView2，Win11 已自带）。
3. 图标链路：`scripts/make-icon.mjs` 增加 `.ico` 生成（多尺寸 16/32/48/64/128/256，`image` crate 或 `png-to-ico`）与**彩色托盘 PNG**（Windows 用）。
4. 便携版：`dist-app/Chassis-win64/`（exe + Resources + 说明），并给同事两种选择（安装包 / 解压即用）。
5. 打包脚本：新增 `scripts/pack-win.mjs`，与 `pack-local-app.mjs` 并列（共用 `assembleResources()`）。
6. **SmartScreen**：未签名 exe 首次运行会提示"Windows 已保护你的电脑"→ 说明书写"更多信息 → 仍要运行"；如介意可购买代码签名证书（非本计划范围）。

### B3.7 CI 与发布（GitHub Actions + Releases）

**Workflow 设计**（`.github/workflows/`，三个文件）：

| 文件 | 触发 | Runner | 做什么 |
|---|---|---|---|
| `verify.yml` | push / PR | `ubuntu-latest` | `pnpm install` → `pnpm typecheck` → `pnpm test` → `cargo test --workspace`（Linux 上只做静态与单元验证，不产包） |
| `build.yml` | 手动 / tag | `macos-latest`（arm64）+ `windows-latest`（x64） | 各自 `pnpm install` → `build-all` → `cargo build --release` → 组装（macOS：`pack-local-app.mjs`；Windows：`pack-win.mjs`）→ 上传 artifact |
| `release.yml` | 打 tag `v*` | `ubuntu-latest` | 下载两个 artifact → `softprops/action-gh-release` 发 Release（macOS `.app` 压缩包 + Windows 安装包 + 便携 zip） |

**要点**：

- **必须走 Release 而不是 artifact**：公开仓库的 artifact 下载要登录 GitHub；Release 附件任何人都能直接下——这才是"发给同事"的通道。
- **零 secrets**：ad-hoc 签名不需要证书 ⇒ 公开仓库不会因为 CI 而引入任何密钥（继续保持"无 secrets"状态）。
- 缓存：`actions/setup-node` + `pnpm/action-setup`、`Swatinem/rust-cache`（两端），把 Rust 编译从 ~10 分钟压到 2–3 分钟。
- **图标必须已在仓库里**（已确认：`apps/shell/icons/{icon.icns,icon.png,icon.svg,tray.png,tray.svg}` 均入库）——CI 上**不能**跑 `make-icon.mjs`（依赖 `rsvg-convert` + `iconutil`）；新增 Windows `.ico` 与彩色托盘 PNG 后同样入库。
- macOS 只用 arm64（`macos-latest`）先满足自用；要 Intel 支持再加 `macos-13`（x64）矩阵。
- Windows runner 自带 Rust 稳定版与 MSVC；Tauri 的 NSIS bundler 会在首次构建时自行下载 NSIS（CI 有网络）。
- 权限：仅 `release.yml` 需要 `permissions: contents: write`。
- 建议：**`verify.yml` 在阶段 A1 就建起来**（Rust 代码一落地就有回归门），`build.yml` 到 A3 再加。

**下载端的两道系统拦截（写进 README）**：

- macOS：从网络下载的 `.app` 带 quarantine → "右键 → 打开"，或 `xattr -dr com.apple.quarantine Chassis.app`。
- Windows：SmartScreen 提示 → "更多信息 → 仍要运行"。

### B3.8 公开仓库准备清单

| 项 | 状态 |
|---|---|
| LICENSE | ✅ 已有（MIT，`Copyright (c) 2026 TripleH`） |
| 敏感文件 / secrets | ✅ 无（306 个入库文件检查过，无 `.env` / 证书 / token） |
| `.gitignore` | ✅ 已覆盖 `node_modules/`、`dist/`、`dist-app/`、`.dev-data/`、`apps/shell/{target,gen,resources/*}`、`.codegraph/`；`.codebuddy/` 只放规则与技能 |
| 第三方来源声明 | ✅ `docs/THIRD-PARTY.md`（ZTools MIT / Lucide ISC） |
| 插件 `author` 署名 | ⚠️ 4 个插件写的是 `triple3h`（`text-diff` / `json-tools` / `totp` / `host-manager` 的 `package.json`）→ 统一为公开身份（GitHub 用户名或组织） |
| README | ⚠️ 需补：Windows 安装段（Release 下载 + SmartScreen 说明）、macOS 安装段（右键打开 / xattr）、"数据只在本机、不联网"的隐私说明、Actions 徽章（可选） |
| 版本号 | ⚠️ 建议起 tag `v0.2.0` 之类，并把 `tauri.conf.json` / 各 `package.json` 的 `0.1.0` 与之对齐（写进发布流程） |
| 计划文档 | ✅ 本文件（`docs/m5-rust-and-windows.md`）也在仓库里，公开无妨 |

### B4 样式与文案（Windows）

- 字体栈：`PingFang SC` → `"Microsoft YaHei UI", "Microsoft YaHei"`；等宽字体 `SF Mono` → `Cascadia Mono / Consolas`。
- 滚动条、CJK 与 emoji 回退实测微调；面板圆角/阴影按 B1.8 的结果调整。
- 快捷键文案（A3.3 已改）在 Windows 上显示 `Ctrl+…`。

### B5 验收清单（Windows 实机，逐条打勾）

- [ ] 双击安装（NSIS）→ 首次运行无 Node 依赖报错；托盘图标可见（浅/深任务栏都看得见）
- [ ] 热键唤出 / 隐藏；连按不闪；失焦隐藏（不误触）
- [ ] 拖动、四边四角缩放、尺寸记忆（重启后仍是上次尺寸）
- [ ] 搜索：应用（图标正确）、文件、网页、快捷键
- [ ] 启动应用 / 打开文件 / 在资源管理器中显示 / 复制路径
- [ ] 选中文本唤出带入（支持的应用内；不支持的应用静默跳过）
- [ ] 插件页：totp / host-manager / text-diff / json-tools 全部可用；Esc 退出；主题跟随
- [ ] hosts 读写（UAC 提权 + 区外字节不动）
- [ ] 托盘菜单 / 状态条 / 设置项（自启、热键、主题）生效
- [ ] 退出：托盘退出 → 进程无残留（任务管理器确认）
- [ ] 关机 / 注销时无残留报错

---

## 风险登记册

| # | 风险 | 影响 | 缓解 | 触发条件（何时升级处理） |
|---|---|---|---|---|
| R1 | 拼音匹配行为与 `pinyin-pro` 有差异（多音字、命中率） | 搜索体验退化 | 建 fixture 对拍：同一批 (查询, 目标) 在两版下命中面与排序一致；不一致的用例逐个校准 | 对拍差异 > 5% 用例 |
| R2 | 子进程插件启动开销（spawn 比 worker_threads 慢） | 首次输入延迟上升 | 搜索源仍预热常驻（5 分钟回收）；`run` 类命令可接受冷启动；实测单次 spawn + 初始化 ≤ 50ms | 端到端 p95 > 300ms |
| R3 | 壳与内核二进制版本错配 | 诡异协议错误 | 版本号写进 `kernel/ready` 与 `app.info`，壳发现主版本不一致时弹错误面板 | 任意一次换包 |
| R4 | 数据对拍遗漏（字段级差异写坏用户数据） | 历史/固定项丢失 | 只读对拍 + 写入路径全部走"先备份后原子写"；上线前用真数据副本跑一遍 | 对拍出现任何不一致 |
| R5 | view 与 script 的 `blocks.ts` 双份实现漂移 | hosts 插件写入与预览不一致（危险） | fixture 向量 + 两侧测试；写入前"回读校验"已有 | 任一侧测试改 fixture |
| R6 | Rust 借用/mutex 设计不当导致内核并发死锁 | 内核挂起（白屏） | 少用共享可变状态：单 `Mutex<KernelState>` + 短临界区；`wait_ready` 类路径不做 IO；压测（100 次搜索并发） | 出现任何一次挂起 |
| R7 | Windows 构建环境缺失（mac 上编不出 win 产物） | 阶段 B 卡住 | 阶段 A 收尾就先把 CI/虚拟机准备好（§B3.1），不要等 B 才发现 | 阶段 B 开始前一周 |
| R8 | WebView2 透明窗口/失焦观感差于 macOS | 同事体感变差 | B1.8 单独留 2–3 天实机调；最坏情况退回"有边框 + 常规阴影"（功能优先） | 调整两天仍不达标 |
| R9 | 功能冻结期用户提新需求 | 计划失控 | 新需求一律记入 backlog，阶段 A/B 结束后统一处理 | 任何新需求 |
| R10 | 升级后旧 `.mjs` 插件（若存在）直接不可用 | 低（当前无存量插件） | 升级说明写明"逻辑层插件须为可执行产物"；个案需要时按 §A3.4 补兼容层，或把该插件重写为 Rust | 出现任何存量 JS 插件的实际使用 |

## 回滚策略

- 阶段 A 期间：TS 内核**保留在仓库**（不删），`scripts/build-all.mjs` 用开关 `--kernel=ts|rust` 选择产物；壳查找顺序优先 `launcher-kernel`、回落 `kernel.mjs`。任何一天出问题，一个开关切回。
- 阶段 A 完成后：删除 TS 内核的那次提交单独成一个 commit（可 `git revert`）。
- 数据层：无 schema 变化 ⇒ 无数据回滚需求（旧版本可直接读新数据）。
- 阶段 B：Windows 只新增文件（`pack-win.mjs`、`.ico`、平台分支），macOS 路径不受影响，可单独 revert。

## 工作量与里程碑

| 阶段 | 内容 | AI 实现（机器时长） | AI 实现（日历） | 人工实现 |
|---|---|---|---|---|
| A0 | 契约 + Rust SDK + 一致性测试 | 1–2 h | 0.5 天 | 3–5 天 |
| A1 | Rust 内核骨架（≈11k 行） | 4–6 h | 1–2 天 | 3–4 周 |
| A2 | 5 个插件逻辑层（≈3k 行） | 2–3 h | 1–2 天 | 2–3 周 |
| A3 | 收尾（测试矩阵 / 打包 / 清理） | 2–3 h | 1–2 天 | 1–2 周 |
| **A 小计** | **全 Rust（macOS）** | **9–14 h** | **4–6 个工作日** | **7–10 周** |
| B | Windows 平台化 + 打包 + 实机 | 8–12 h | 4–6 个工作日 | 3–5 周 |
| **合计** | | **17–26 h** | **8–12 个工作日** | **10–15 周** |

日历口径的瓶颈（不是写代码速度）：实机验收要人点（TCC 挡住自动化）、协议/SDK 需拍板往返、Rust 编译迭代、Windows 需要独立机器或 CI。

**建议的里程碑卡点**（每个都可验收、可回滚）：

1. **M5.1 协议一致**：`echo` 插件在 v1 与 v2 宿主上输出一致（A0 完成）。
2. **M5.2 UI 无感**：Vue UI 一点没改，后端已是 Rust，搜索/启动/插件页全部可用（A1 完成）。
3. **M5.3 去 Node**：从 PATH 移除 `node` 后全流程可用 + 出厂插件全部是 Rust 二进制（A2 完成）。
4. **M5.4 换包**：macOS 上 `pnpm app:local` 出包、换包、日常使用（A3 完成）。
5. **M6.1 Windows 可跑**：同事机器上安装、唤出、搜索、启动应用。
6. **M6.2 Windows 全功能**：B5 清单全绿 + 安装包交付。

## 附录

### 附录 A：文件级索引（实现时按此找代码）

| 关注点 | 现状（TS/Rust） | 目标（Rust/Windows） |
|---|---|---|
| 壳 ↔ 内核协议 | `apps/kernel/src/jsonrpc.ts` + `apps/shell/src/ipc.rs` | `apps/kernel/src/link.rs`（协议不变） |
| URI/端点契约 | `apps/kernel/src/api.ts`（28 端点） | `apps/kernel/src/api.rs` |
| UI 侧调用面 | `apps/launcher-ui/src/lib/api.ts`（243 行） | **不动** |
| 插件运行时 | `apps/kernel/src/services/exec.ts`（431 行） | `apps/kernel/src/exec/runtime.rs` |
| 插件装载 | `apps/kernel/src/plugin.ts` / `pluginAdmin.ts` | `apps/kernel/src/plugin/*.rs` |
| 搜索打分 | `apps/kernel/src/search.ts` + `pinyin.ts` | `apps/kernel/src/search/*.rs` |
| 数据兼容 | `config.ts` / `history.ts` / `legacy.ts` / `overrides.ts` / `pluginSettings.ts` | 同名 `.rs` |
| 壳原语 | `apps/shell/src/primitives/*.rs` | 增加 Windows 分支（B1） |
| 插件逻辑层 | `plugins/*/src/no-view/*.ts`（10 文件 / ≈1700 行） | `plugins/*/src/*.rs`（crate 根 = 插件目录） |
| 构建 | `scripts/{build-all,pack-local-app,spec-check}.mjs` | 增加 Rust 构建与 `scripts/pack-win.mjs` |

### 附录 B：开工前必须拿到的三样东西

1. ~~用户拍板 `apiVersion: 2` 的产物形态与 D4~~（已定：可执行文件；**不做 JS 兼容层**，见 §A3.4）。
2. ~~Windows 构建通道~~（已定 2026-09-17：**GitHub Actions** 双 job（`macos-latest` + `windows-latest`），仓库后续**公开**（MIT）⇒ Actions 免费无额度限制；详见 §B3.1 与 §B3.7）。
3. **验收人**：实机点验由谁做（macOS 换包 + Windows 安装）。

### 附录 C：术语

| 术语 | 含义 |
|---|---|
| 逻辑层插件 | `no-view` / `script` 命令的实现（M5 后为 Rust 可执行文件） |
| 视图层插件 | `view` 命令（Vue 页面，跑在宿主 WebView 的 iframe 里） |
| 宿主 | 内核（M5 后为 `launcher-kernel`） |
| NDJSON | newline-delimited JSON（每行一个 JSON 对象） |
| 形态 A / 形态 B | 本文件中的阶段 A（全 Rust）与阶段 B（Windows） |
