# ADR-0001：启动台 UI 的托管方式 —— 内核托管（方案 B）

- 状态：已采纳
- 日期：2026-09-14
- 相关：`docs/launcher-requirements.md` §4.1（"二选一，ADR 记录"）

## 背景

需求 §4.1 给了两条路：

- **方案 A**：启动台 UI 由壳的 WebView 加载（Tauri asset 协议），通过 `invoke`/`event` 与壳通信，再由壳转发给内核。
- **方案 B**（推荐）：内核托管启动台 UI 的静态资源（`http://127.0.0.1:<uiPort>`），WebView 直接加载该 URL。

关键约束：

1. **插件页必须与启动台 UI 同源可达**：插件页是 iframe，父页面（启动台 UI）需要用 `postMessage` 与它通信，并在父页面完成 `event.source` / `origin` 校验。→ 父页面必须能拿到 iframe 的 `contentWindow`，两者都在 WebView 里，与谁托管无关。
2. **开发体验**：UI 开发时需要 HMR。
3. **壳的定位**：P1「底座零能力」——壳越薄越好，壳里不该出现搜索/历史/插件等业务。

## 决策

采用**方案 B**：

```
WebView ── 加载 http://127.0.0.1:<uiPort>（内核托管 vite 产物）
        ── UI ↔ 内核：HTTP(/api/*) + SSE(/api/events)
        ── 插件页 iframe：http://127.0.0.1:<pluginPort>（内核为每个插件分配端口）
```

- 壳只做 §6.1 的原语；它通过 JSON-RPC 调用内核（如 `tray/menu`、`window/blurred`），**不代理 UI 流量**。
- 开发态：`vite dev server`（3333）通过 `?kernel=http://127.0.0.1:<port>` 指定内核地址；内核用 `--ui-dev` 时会把静态请求 302 到 vite。
- 壳启动时先加载本地 UI stub（`apps/shell/ui-stub/index.html`，骨架 + 加载动画），内核就绪后 `window.navigate()` 到内核 URL（§6.2 的"冷启动 ≤ 800ms 可唤出"）。
- 内核崩溃时壳把 stub 页改写成错误面板（§6.2：不许白屏）。

## 后果

**收益**

- 壳里没有一条业务路由，`apps/shell/src/primitives/*` 只有 6 个原语文件。
- UI 与内核的契约是普通 HTTP + SSE，可以直接用 curl / 测试脚本驱动（`tests/helpers/harness.ts` 就是这样做集成与契约测试的，不需要起壳）。
- 打包产物小：Tauri bundle 里只带一个 stub 页，真实 UI 走 `resources/ui`。

**代价**

- 需要给 WebView 配置 CSP 允许连 `http://127.0.0.1:*`（已在 `tauri.conf.json` 里放开，仅限本机回环）。
- 内核必须先起来才有 UI（用 stub 页 + 错误面板兜住）。
- 内核退出后窗口会停在错误页（可接受：内核崩溃属于异常态）。

## 备选方案与不采纳原因

| 方案 | 不采纳原因 |
|---|---|
| 方案 A（壳托管 + invoke 转发） | 每条 UI 请求都要在壳里过一次，壳会被迫理解"搜索/历史/插件"这些概念，直接违反 P1；且壳重启会连带 UI 不可用 |
| 让 WebView 直接 `file://` 加载 UI | 插件 iframe 的 origin 与 UI 不同源，`postMessage` 校验与 CSP 都更难做 |
| UI 与内核走 WebSocket 而不是 SSE+HTTP | 需要额外的握手/重连逻辑；SSE 足够（事件是单向推送），且调试成本低 |
