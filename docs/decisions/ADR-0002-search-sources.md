# ADR-0002：贡献型搜索的执行载体 —— script 常驻 worker（补齐 §9.2 的空档）

- 状态：已采纳
- 日期：2026-09-14
- 相关：`docs/plugin-spec.md` §9.2、`docs/launcher-requirements.md` §7.6

> **2026-09-17（M5）**：决策本身不变（贡献型搜索由「常驻载体」承担），换的是载体实现 ——
> v1 是 Node `worker_threads`，v2 是**常驻子进程**（ADR-0005 / plugin-spec §4.4，SDK 侧对应 `ctx.on_query`）。
> 协议（query → result 多次往返、不 done）逐条一致。

## 背景

plugin-spec §9.1 / §9.2 把搜索分成两种模式：

- **入口型**（`searchable: true`）：搜索结果里出现"命令本身"，命中后用 `hostUi.getSearchContent` 把输入交给插件页。
- **贡献型**（`contributes: true`）：搜索过程中由插件返回结果项，协议是 UI 侧 SDK 的 `search.onQuery(handler)`。

问题在于：`search.onQuery` 是**插件页**的 API，而插件页（view 会话）只在用户已经打开插件时存在。
应用启动器、文件搜索这类插件天然是"用户还没打开任何东西，就要把结果显示在列表里"——此时没有任何 view 会话可广播。

## 决策

贡献型搜索支持**两种载体**，内核按命令的 `mode` 选择：

| 命令 | 载体 | 说明 |
|---|---|---|
| `mode: 'script'` + `contributes: true` | **常驻搜索 worker**（`worker_threads`） | 内核懒启动该插件的 `<name>.mjs`，常驻复用（空闲 5 分钟回收）；每次输入下发给 worker `{type:'query', query, token}`，worker 用 `onQuery()` 回 `{type:'result', token, data}` |
| `mode: 'view'` + `contributes: true` | **活跃 view 会话** | 通过 `postMessage` 广播 `search/query` 给该插件的所有会话（`@launcher/api` 的 `search.onQuery`） |

配套约定：

1. Node 侧 SDK 新增 `onQuery(handler)`（`@launcher/api-node`），复用 §8.7 的消息协议（`result` / `log` / `progress` / `done`），**没有新增消息类型**，只是允许一个 worker 收到多次 `query` 而长期不 `done`。
2. 搜索预算 200ms：超时的插件本次贡献丢弃（不回滚已显示的），并记审计。
3. 常驻搜索 worker 不属于"no-view 命令不得长期驻留"（§4.2）的禁止范围——它不是用户触发的命令实例，而是内核为贡献型搜索维护的运行时；回收策略明确（空闲 5 分钟）。
4. 历史/固定不变：worker 重启不影响 `history.json` / `pinned.json`。

## 后果

**收益**

- 应用启动器 / 文件搜索这类"索引型"插件可以零会话工作，这是 M2/M3 验收的前提。
- 复用同一份脚本协议：脚本命令只要实现 `onQuery` 就能被当作搜索源。
- worker 常驻避免了"每次按键冷启动 Node worker"（约 30–50ms × 每次输入）的开销。

**代价**

- 内核多了一份"搜索 worker 池"的生命周期管理（`apps/kernel/src/services/exec.ts`）：懒启动、复用、空闲回收、插件停用时释放。
- 插件作者要理解"script 命令有两种形态"：一次性执行（`ctx.exec.run`）与常驻搜索源（`onQuery`）。

## 备选方案与不采纳原因

| 方案 | 不采纳原因 |
|---|---|
| 只支持 view 会话贡献（严格照 §9.2） | 索引型插件无法工作（用户没打开插件时列表空白），M2 验收不可能通过 |
| 每次搜索冷启动 worker | 200ms 预算里光启动就吃掉 1/4，且并发上限 4 会排队 |
| 让插件在主进程/内核里直接注册 JS 回调 | 破坏"插件代码只读、数据分离"（P7）与崩溃隔离；插件异常会拖垮内核 |
| 贡献型也走"命令 + args"（入口型） | 失去实时性：用户每次输入都要先命中命令再回车 |
