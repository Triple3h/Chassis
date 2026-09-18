# 内核热更新 · 集成说明（v0.1.0）

> 状态：**已实现**（2026-09-18，M8）｜机制版本 **0.1.0**（`HOT_UPDATE_VERSION`，写进每条日志与 `hot/status`）
> 需求口径：`docs/launcher-requirements.md` §7.8 + §13 M8｜实现：`apps/kernel/src/hot/`（22+ 单测）+ `tests/contract/kernel-hot*.test.ts`

不重启壳（主程序）动态加载新版本内核**配置 / 代码**：路由、中间件、事件订阅热替换；
内核二进制可替换并优雅重启（壳自动拉起）；失败自动回滚；全程写结构化日志。

## 1. 落点（交付物）

| 文件 | 职责 |
|---|---|
| `apps/kernel/src/hot/mod.rs` | generation 状态机：`boot` / `stage` / `apply` / `rollback` / `status` / `drain` + **分发层** `dispatch_router` |
| `apps/kernel/src/hot/spec.rs` | spec 解析与校验（schema / hotVersion / 路由冲突 / 停用清单）+ 扩展路由构造 + 自检 `probe` |
| `apps/kernel/src/hot/middleware.rs` | 热中间件：`requestLog` / `timeoutMs` / `maintenance` / 在途计数 |
| `apps/kernel/src/hot/log.rs` | 热更新日志（JSONL，每行带时间与 `hotVersion`） |
| `apps/kernel/src/hot/binary.rs` | 二进制热替换：staging / 备份 / 原子替换 / `pending` 台账 / 启动守卫回滚 |
| `apps/kernel/src/api.rs` | `/api/hot/*` 八个接口 + `builtin_routes()`（内置路由唯一源） |
| `apps/kernel/src/kernel.rs` | 装配：`hot` 字段、`build_hot_tree`（builder 回调）、`hot_restart`（排空 + 优雅退出） |
| `apps/shell/src/{sidecar.rs,primitives/mod.rs}` | 壳侧：`kernel/restarting` = 计划内重启；重启就绪后重新导航窗口到新端口；**外置内核**（数据目录副本 + App 版本失效策略 + UI 同源） |
| `scripts/pack-kernel.mjs` | 打内核更新包：`launcher-kernel-<版本>-<平台>-<架构>.zip`（内核 + `ui/` 同包）+ 分片 |
| `scripts/gen-kernel-registry.mjs` | 汇总分片 → `kernel-registry.json`（schema 1，含 sha256 与 `minHotVersion`） |
| `.github/workflows/kernel-release.yml` | 发布流水线：双平台原生构建 → 固定 tag **`kernel-latest`** |
| `plugins/internal-store/` | 更新器的**内核分区**：`check-kernel` / `download-kernel`（逻辑层）+ 应用发起（view 调 `applyKernelUpdate`） |

## 2. 机制（三层）

```
  投递（外部）                     内核 hot 模块                         生效
  ─────────────                   ─────────────────────────            ──────────────
  spec.json ──► stage ──────────► 校验 + 落 candidate.json（不生效）
              ──► apply ────────► ① 构建候选代（新路由树 + 新中间件 + 新订阅）
                                  ② 自检（对扩展路由发 probe 请求）
                                  ③ 原子切换（换指针；在途请求持旧代跑完）
                                  ④ 复核（走当前分发通道再 probe；失败自动 swap 回上一代）
  二进制 ──────► binary apply ──► 备份 → 原子替换 → pending 台账 → 优雅重启（壳拉起）
                                  启动守卫：连续两次启动未就绪 ⇒ 自动恢复备份
```

- **不中断**：HTTP listener 上挂的只是**分发层**（`dispatch_router`）；每个请求现取「当前代」的树，
  在途请求持有旧代的 `Arc` 直到响应结束 —— 切换只换指针，不打断任何在途请求。
- **回滚**：`previous.json` 只保留上一稳定代；`apply` 的任何失败（校验/构建/自检/复核）都**不动当前代**；
  `POST /api/hot/rollback` 与上一代互换（**再回滚一次 = 恢复刚才回滚掉的那一版**，undo/redo 语义）。
- **零能力**：内核不联网。spec / 二进制由外部（人、脚本，或插件逻辑层下载后投递）放到本地路径，
  或直接放进请求体 —— 谁下载谁负责，内核只做校验与应用（与插件热更新同款分工）。

## 3. spec 格式（`schema: 1`）

```jsonc
{
  "schema": 1,
  "hotVersion": "0.1.0",          // 必填，必须等于内核的机制版本（不匹配即拒绝）
  "kernelVersion": "0.1.0",       // 标注用（不参与兼容判断）
  "revision": "2026.09.18-1",     // 本次变更的版本标识（日志 / 回滚展示；留空自动生成 gen-<n>）
  "note": "维护模式 + 兼容别名",
  "modules": ["routes", "middleware"],   // 作者声明（可留空；日志按实际差异推断）
  "routes": {
    "extensions": [
      { "kind": "json", "method": "GET", "path": "/api/ext/ping", "status": 200, "body": { "pong": true } },
      { "kind": "text", "method": "GET", "path": "/api/ext/version", "text": "hot 0.1.0" },
      { "kind": "redirect", "method": "GET", "path": "/api/ext/old", "status": 308, "location": "/api/health" }
    ],
    "disabled": ["/api/dev/register"]      // 停用内置路由（路径必须真实存在，写错即拒绝）
  },
  "middleware": {
    "requestLog": true,        // 请求日志（method/path/status/耗时）写进热更新日志
    "timeoutMs": 30000,        // 请求超时（0 = 关；SSE / 热更新 API 豁免）
    "maintenance": false       // 维护模式：/api/* 的写请求 503（GET 与 /api/hot/* 豁免，能自救）
  },
  "bus": { "log": ["history/changed", "plugin/reloaded"] }   // 订阅事件 → 写热更新日志
}
```

约束：扩展路由不得与内置路由冲突、不得占用 `/api/hot*` 前缀；`disabled` 只认真实内置路径；
未知 schema / 未知 `hotVersion` / 未知 kind / 非法状态码一律拒绝（不猜测、不迁移）。

## 4. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/hot/status` | 当前代 / 版本 / 声明与生效 spec / 上一稳定代 / 在途数 / 路径 / 二进制状态 |
| GET | `/api/hot/log?limit=100` | 热更新日志尾部（JSONL 解析后的数组） |
| POST | `/api/hot/stage` | 只校验并落 `candidate.json`（body：`{ spec }` 或 `{ path }`，缺省用 candidate） |
| POST | `/api/hot/apply` | 应用（校验 → 构建 → 自检 → 切换 → 复核） |
| POST | `/api/hot/rollback` | 回滚到上一稳定代（与当前代互换） |
| POST | `/api/hot/binary` | 二进制热替换：`{ mode: "stage"\|"apply", path, version?, restart? }` |
| POST | `/api/hot/binary/rollback` | 恢复备份（无 pending 则 `rolledBack:false`） |
| POST | `/api/hot/restart` | 优雅重启：排空在途（≤3s）→ 通知壳 → 退出（壳拉起） |

错误码：`BAD_ARGS`（400）、`PROBE_FAILED`（400）、`NO_PREVIOUS` / `SIGNED_BUNDLE` / `UPDATE_FAILED` / `ROLLED_BACK`（409）。

## 5. 集成方式

```bash
# 1) 应用一份配置（内联或文件均可）
curl -X POST http://127.0.0.1:<kernelPort>/api/hot/apply \
  -H 'Content-Type: application/json' \
  -d '{"path":"/path/to/spec.json"}'

# 2) 查看状态 / 日志
curl http://127.0.0.1:<kernelPort>/api/hot/status
curl 'http://127.0.0.1:<kernelPort>/api/hot/log?limit=20'

# 3) 回滚
curl -X POST http://127.0.0.1:<kernelPort>/api/hot/rollback -d '{}' -H 'Content-Type: application/json'
```

- **UI / 脚本**：直接调上表接口；内核会广播 SSE `hot/updated`（载荷：`generation` / `revision` / `modules` / `message`）。
- **插件投递**（推荐的生产形态，与 `internal-store` 同分工）：插件逻辑层负责下载与校验，
  把 spec 写到 `<自己的 dataPath>`，再用 `hostUi`/fetch 调 `/api/hot/apply`（下载在插件、应用由内核裁决）。
- **重启期表现**：二进制更新会重启内核进程（壳不重启）。UI 会短暂断开，壳在重启就绪后自动
  `navigate` 到新端口；期间 SSE `hot/restarting` 可用来提示用户。

## 6. 二进制热替换与边界

流程：`stage`（复制到 `<dataRoot>/hot/bin/staging/` + 跑 `--hot-probe` 自检）→ `apply`
（备份当前 `current_exe` → 原子替换 → 写 `pending.json`）→ `POST /api/hot/restart`（或 `restart` 默认 true）
→ 壳 `supervise` 拉起新二进制 → 新内核**就绪即确认**（清 pending，日志 `binary-applied`）。

- **自动回滚**：新二进制连续两次启动没走到就绪 ⇒ 下一次启动时启动守卫（`run()` 最早期）把备份换回来
  （`hot/bin/backup/` 只保留最近 1 份）。
- **`.app` 内二进制默认拒绝**（`SIGNED_BUNDLE`）：替换会让代码签名失效，macOS 上可能直接起不来；
  打包版请随 App 一起更新，开发/自编译产物或愿意重新签名时设 `LAUNCHER_HOT_ALLOW_BUNDLE_SWAP=1`。
- **Windows**：运行中的 exe 无法被替换（句柄占用），接口会返回 `UPDATE_FAILED` 并保留旧版本；
  由壳在重启间隙替换（后续里程碑）。
- `--hot-probe` 是自检入口：**最先**处理、不初始化任何东西，只输出
  `{"version":"…","hotVersion":"0.1.0"}`（这个短命进程的 stdout 是它自己的，与内核协议无关）。

## 7. 内核 Release 通道（kernel-latest）与更新器

内核与插件**各自独立**监控自己的 Release 通道（2026-09-18 拍板）：App 用 `v*`、插件用 `plugins-latest`、
内核用 **`kernel-latest`** —— 三个 tag 互不干扰，客户端走 `releases/download/<tag>/...` 直链（无需 GitHub API、无 token）。

```
kernel-release.yml ──macOS + Windows 原生构建──▶ 固定 tag kernel-latest
  ├── kernel-registry.json                          索引：schema 1 / version / hotVersion / minHotVersion / assets[]
  └── launcher-kernel-<版本>-<平台>-<架构>.zip        内核 + UI（解压结构 = launcher-kernel + ui/）

internal-store「内核更新」区
  ① exec.run(update, { mode:'check-kernel', current, hotVersion })      拉索引 + semver 比对 + 平台挑选 + minHotVersion 门槛
  ② exec.run(update, { mode:'download-kernel', … })                    下载 → sha256（不匹配即删）→ 解压到
                                                                       <dataPath>/downloads/kernel-<版本>/（恢复可执行位 / 防穿越 / 结构校验）
  ③ ctx.settings.pluginAction('applyKernelUpdate', { path, uiPath })   ← 必须 view 发起（重启会收掉命令进程）

内核 ──▶ stage（--hot-probe 自检）→ 备份（内核 + UI）→ 原子替换 → kernel/restarting → 壳拉起 → 就绪即确认（失败自动回滚）
```

**打包版的内核外置**（壳 `sidecar.rs`）：包内内核先复制成 `<dataRoot>/kernel/launcher-kernel`（+ `ui/`）再启动 ——
热更新替换的是数据目录里的副本，`.app` 的签名与 TCC 授权都不受影响（内核不直接调 TCC API，责任进程仍是壳）。
台账 `kernel.json` 记「投放时的 App 版本」：App 升级 ⇒ 重投包内版本（热更新成果作废，保证内核不落后于 App）；
开发态（从 `target/{release,debug}` 启动）不做外置，作者的重新 build 立刻生效。

**版本门槛**：索引里的 `minHotVersion` 与客户端 `host.info().hotVersion` 比对 —— 不满足时更新页提示但不给「更新」按钮
（避免装上一个本客户端应用不了的内核）。

## 8. 壳侧配合（已实现）

- `primitives::dispatch` 新增 `kernel/restarting`：记为**计划内重启**（`sidecar::note_hot_restart`），
  不计入崩溃重启预算（否则连续几次热更新会撞上 `MAX_RESTARTS`）。
- `supervise` 重启成功后 `wait_ready` + `navigate_main_window`：内核端口每次启动都变，
  不重新导航 = UI 停在旧端口白屏。

## 9. 日志与可观测

`<dataRoot>/hot/hot-update.log`（JSONL，一行一条）：

```jsonc
{"ts":"2026-09-18T15:50:52.432+08:00","hotVersion":"0.1.0","type":"apply","result":"applied",
 "source":"api:file:…","from":"2026.09.18-1","to":"2026.09.18-2","generation":3,"modules":["routes"],"probed":1,"inflight":0}
```

`type` ∈ `boot` / `stage` / `apply` / `rollback` / `binary` / `event` / `request`；
结果 ∈ `applied` / `rejected` / `rolled-back` / `staged` / `done` / `timeout` / `blocked`。
时间、版本、变更模块、结果四项在**每一行**都能读到（`ts` / `hotVersion` / `modules` / `result`）。

## 10. 验证

```bash
cargo test -p launcher-kernel --lib hot::             # 25 个单测（状态机 / spec / 中间件 / 二进制 / UI 同包 / 分发层回归）
cargo test -p launcher-kernel --lib                   # 内核全量
cargo test -p launcher-plugin-internal-store          # 更新器逻辑（11 个：索引 / 挑选 / minHotVersion / 解压）
node scripts/run-ts.mjs tests/contract/kernel-hot.test.ts          # 11 条契约（真内核 + HTTP/SSE）
node scripts/run-ts.mjs tests/contract/kernel-hot-restart.test.ts  # 1 条（优雅重启：壳收到 kernel/restarting）
node scripts/pack-kernel.mjs && node scripts/gen-kernel-registry.mjs   # 本地出包 + 索引（kernel/release/）
```

真实路径手工验证（已跑通并记录在日报）：apply → 替换 → 重启 → 就绪确认（pending 清）；
构造 `attempts:1` 的 pending → 启动即自动回滚（备份恢复 + 日志留痕）。

## 11. 明确不做（v1）

- 不做任意代码热加载（声明式路由 / 中间件配置 / 事件订阅，三样之外没有扩展面）；
- 内核自身不校验候选二进制的哈希 / 签名（`/api/hot/binary` 的信任模型 = 本地路径 + `--hot-probe` 自检）；
  分发链路（`internal-store`）对**下载**的内核包做 sha256 校验 —— 两道防线分工不同，v1 不引入签名；
- 不做多版本历史（只留 1 份备份 / 1 个上一稳定代，与插件热更新同口径）；
- 不做 Windows 上的「重启间隙替换」（运行中的 exe 无法替换，另立里程碑）。
