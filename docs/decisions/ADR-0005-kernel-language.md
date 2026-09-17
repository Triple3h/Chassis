# ADR-0005：内核语言 —— Rust 重写（协议不变）+ 逻辑层插件改子进程

- 状态：已采纳
- 日期：2026-09-17
- 相关：`docs/launcher-requirements.md` §4.1 / §7 / §8.7 / §13（M5、M6）；`docs/plugin-spec.md` §4.4 / §11；`docs/m5-rust-and-windows.md`（实施计划）；`apps/kernel`（M0–M4 TypeScript → M5 起 Rust，同一目录）

## 背景

两条动因叠加：

1. **要把应用分享给使用 Windows 的同事**，不能要求对方安装 Node（当前内核是 Node sidecar + 系统 Node ≥ 22）。
2. 顺带把常驻内存与依赖形态收敛。2026-09-17 实测：Node 内核常驻 **121MB**（其中 Node 基线 47 + `pinyin-pro` 词典 17 + 两个常驻 worker 的隔离开销 30），壳 103MB；而一个裸 Rust 进程 RSS 仅 **1.7MB**。

现状规模：内核 38 文件 / 6951 行 TS；5 个出厂插件的逻辑层（`no-view` / `script`）合计约 1700 行 TS。这两块正是"机器上必须有 Node"的全部原因 —— 视图层插件跑在 WebView 的 iframe 里，本来就不需要 Node。

## 决策

### 1. 内核重写为 Rust（bin: `launcher-kernel`），三条协议字段级不变

- 壳 ↔ 内核：stdio + newline-delimited JSON-RPC 2.0（21 个原语方法 + 5 个上报方法/通知）**不变**
- UI ↔ 内核：28 个 HTTP 端点 + 12 个 SSE 事件（`/api/*`、`/api/events`）**不变**
- 插件页 ↔ 宿主：iframe + postMessage 桥（`__launcher: 1` + 三重校验 + 每插件独立端口）**不变**

因此 `apps/launcher-ui` 与 4 个 Vue 插件**零改动**；`packages/plugin-api`（UI 侧 SDK）不动。壳侧只把 `node_binary()` 换成 `kernel_binary()`，supervisor / wait_ready / 日志转发 / `MAX_RESTARTS` 一行不改。

### 2. 逻辑层插件（`no-view` / `script`）改为独立子进程 + NDJSON over stdio

- 对应 `plugin-spec` 的 **apiVersion 2**（§4.4）：产物为**可执行文件**（`dist/<name>`，Windows `.exe`），宿主 spawn 后按行读写 JSON
- 消息类型与语义照搬 v1 worker 协议（`result` / `done` / `log` / `progress` / `rpc` ↔ `query` / `rpc-result` / `shutdown`）；隔离、超时（10s / 上限 5min）、并发 4、失败计数（连续 3 次 `degraded`）、搜索常驻回收（5min）原样平移
- 新增 `packages/plugin-sdk-rs`（crate `launcher-plugin-sdk`），对标 `@launcher/api-node`

### 3. 不做 JS 插件兼容层：v2 只认可执行产物

"机器上没有 Node"是**明确承诺**而不是打折保证。实测依据（2026-09-17）：`<dataRoot>/extensions/` 与 `config.devPlugins` 均为空、无第三方插件生态；5 个出厂插件 Rust 化后，兼容层没有任何消费者。明确不支持 > 半支持 —— 留下"能跑但要装 Node、且只在部分机器上能跑"的状态，会让同事机器上的行为无法解释。

**保留后路**（零成本）：产物规范按"形态分派"表述，未来若要支持 `.mjs` 只加一节、不改既有条款；adapter + 一个 runtime 分支是纯增量改动（见 `docs/m5-rust-and-windows.md` §A3.4）。

### 4. 数据格式不变

`config.json` / `history.json` / `pinned.json` / `plugin-overrides.json` / `plugin-settings.json` / `quicklinks.json` / `audit-*.jsonl` 与 `extensions/`、`plugins/<id>/` 布局逐字段兼容，**无 schema 迁移**；改名链（`RENAME_CHAINS`）逐条搬运。

## 后果

**收益**

- 交付物不含 Node：macOS 换包与 Windows 安装包都免依赖；内核闲置内存 121MB → 预计 10–20MB（整机口径 ≈224MB → ≈120–140MB）
- 内核就绪从数百毫秒降到预计 20–80ms；单文件二进制 + 静态链接
- Windows 分发问题一并解决（不需要内嵌 Node）

**代价**

- 磁盘反而变大：macOS 9.2MB → 20–30MB（每个插件二进制静态链接运行时）
- 逻辑层插件开发门槛上升：从"一个 `.mjs` 即改即用"变为"装工具链 + 编译 + 双平台产物"（视图层插件不受影响，仍是放进去就生效）
- 双份真源一处：`host-manager` 的 `blocks.ts` 两个函数（`removeOutsideLines` / `spliceRegion`）被视图与逻辑层同时使用 ⇒ TS 版保留 + Rust 版新增，用共享 fixture 测试向量守护一致（风险 R5）
- 状态条口径必须跟着扩展（壳 + 内核 + 所有插件子进程），否则用户看到"占用忽然变小"的假象（内存只是从内核搬到子进程）
- 全程功能冻结（阶段 A/B 期间）

## 备选方案与不采纳原因

| 方案 | 不采纳原因 |
|---|---|
| 保持 Node 内核，内嵌 `node.exe`（或 Node SEA / `bun build --compile`） | 体积 +80–110MB；内存一分不省；"免 Node"只是把 Node 塞进包里，Windows 上仍需搬运与签名 |
| 内嵌 V8（`rusty_v8`）跑 JS 插件 | 省 ~40MB 但产物 +35MB、每 isolate 再吃 20–40MB；收益与成本相当 |
| 内嵌 QuickJS | 内存小，但 Node API 全缺 —— 等于自己重写迷你 Node + 现有 npm 依赖（`adm-zip` / `chokidar` / `pinyin-pro` / `simple-plist`）全部作废 |
| Rust dylib 直接加载插件 | Rust 无稳定 ABI（必须同编译器同版本）；插件崩溃会带崩内核 |
| WASM（wasmtime）插件 | 沙箱最强（能力靠 host function，正合三铁律），但内嵌 +10–20MB、npm 生态全废、调试体验差；留作未来选项 |
| 只做 Windows 平台化（保留 Node 内核） | 内存不变、仍需内嵌或要求 Node；交付质量与"轻量"定位倒退。可作为中间态（1.5–2.5 周）先行，但不是终态 |
| 只为省内存做 Rust | 不值得：单独压内存有更便宜的中间态（换掉 `pinyin-pro` −17MB、搜索 worker 按需启动 −30MB、调 V8 参数）。**真正的理由是 Windows 分发免 Node**，省内存是顺带收益 |

## 参考

- 实测数据与阶段计划：`docs/m5-rust-and-windows.md`（含 §1.2 目标占用表、协议一致性测试、回滚策略）
- 对外契约：`docs/plugin-spec.md` §4.4（逻辑层运行时）/ §11（版本与兼容）
- 需求源：`docs/launcher-requirements.md` §4.1 / §7 / §13（M5、M6）
