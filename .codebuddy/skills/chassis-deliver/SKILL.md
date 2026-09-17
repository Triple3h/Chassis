---
name: chassis-deliver
description: 改完代码收尾时使用（底座与插件通用）：跑类型检查/测试/构建/冒烟/spec-check、真实路径验证、实机点一遍、分批提交与 git add -p 拆 hunk。触发场景：改完收尾、跑测试、验证一下、提交代码、分批提交、帮我提交、发布前自检。关键词：验证、收尾、提交、分批提交、冒烟、spec-check、pnpm build、typecheck、git add -p。
allowed-tools:
disable: false
---

# 交付：收尾验证与提交（全仓适用）

改完任何代码（底座或插件）后按下面的顺序收尾。插件内部另有更细的验证，两者叠加（见技能 `chassis-plugin-dev`）。
硬约束见规则 `chassis-core` / `chassis-plugin`。

## 第 1 步：跑什么（按改动范围）

| 改动 | 必跑 |
|---|---|
| 任何 TS / Vue | `pnpm typecheck`（= `scripts/run-tsc.mjs`，15 个包） |
| 任何逻辑 | `pnpm test`（= `run-tests.mjs`；分层 `pnpm test:unit` / `test:contract` / `pnpm smoke`） |
| 内核 / UI / 插件 | `pnpm build`（= `build-all.mjs`：kernel → ui → plugins） |
| 内核或插件协议 | `node scripts/smoke-real.mjs`（真内核 + 出厂插件，走「输入 → 首屏 → 执行 → 写历史」整条链路） |
| 插件清单相关 | `pnpm spec-check`（N1–N3 / 产物 / 远程资源；N3 只做人工核对提示） |
| Rust 壳 | `cd apps/shell && cargo check`（只编壳）/ `pnpm shell:dev`（跑） |
| Rust（M5：内核 / 插件逻辑层 / SDK） | `cargo test`（workspace 在**仓库根** `Cargo.toml`）+ `pnpm parity:echo`（v1↔v2 协议对拍；动了 runner / SDK / 协议必跑） |

要点：

- 测试文件放 `tests/{unit,contract,smoke}`（插件内部用例放插件 `src` 旁）；**类型检查只覆盖 `tests/` 与各包 src，插件包 tsconfig 不含自己的 tests**。
- `run-ts.mjs` 用 esbuild bundle 到 `.dev/`；测试 import 走源码，不需要先构建。
- **冒烟必须跑在新产物上**（先 `pnpm build` 再冒烟；旧 dist 会让冒烟「假通过」）。

## 第 2 步：真实路径验证（不许用等效捷径）

- 改配置 / 事件 / 外观：走**真实 UI 路径**（设置页 → `ctx.settings.patch`）验证 —— 历史上「一条路径修了、另一条还在坏」，就是自测用了 `curl /api/config` 恰好绕开坏路径。
- 改插件页 / 宿主边界：起静态服务器打开生产 `dist/` 实机点一遍（`python3 -m http.server 5233 --directory dist`），**别只信 dev server**（生产资源路径不同）。
- 改 shell / 窗口行为：必须 `pnpm app:local` 打包实机验证（dev 模式跑不出窗口显隐与系统权限的真实行为）。
- 改 UI / 主题：截图核对（agent-browser 或手动），明暗两套主题 + 主题色各看一眼。
- **插件页（iframe）内部的验证走 CDP**：跨源 iframe 用不了 DOM 选择器 / `get box`。`agent-browser get cdp-url` 拿 browser ws → `curl <host>/json/list` 找页面 target → 连上 `Runtime.enable`，插件 iframe 是**同进程、不会单独出 target**，要从 `executionContextCreated` 里按 origin 挑上下文，再用 `Runtime.evaluate` + `contextId` 读真实计算样式 / DOM / 触发 `el.click()`（Node 22+ 自带全局 `WebSocket`，写十几行即可）。
- **`agent-browser screenshot` 抓不到 CSS 动画**（定格/禁用，表现为「倒计时环、呼吸动画没在跑」的假象）。验证动画是否真在跑：CDP `Page.captureScreenshot` 连抓两帧（间隔 0.3–0.5s）比像素差。
- **别凭观感读截图**：明暗与配色一律像素取样（`sips -s format bmp x.png --out x.bmp` → python 直读 24/32bpp BMP，注意 `h<0` 表示行自顶向下、每行 4 字节对齐）。观感会把深色页面看成浅色、把已经渲染的描边看成没渲染。

## 第 3 步：提交（用户要求「分批提交」）

- 提交前先 `git status --short` + `git diff --stat` **读完全部改动**：工作区常同时积压多条互不相干的改动（**可能来自其它并行会话**），按「一条主题 = 一个提交」拆。
- 信息风格：`feat|fix|docs: 中文主题` + 空行 + 分点正文（根因 / 改法 / 验证，把「为什么」讲清楚）；多段用 `-m $'subject\n\n正文'`（ANSI-C 引用，正文里的反引号无需转义）。
- 同一文件混两组改动：`printf 'y\ny\nn\n...' | git add -p <file>` 按 hunk 拆 —— 先 `git diff -U3 <file> | grep -c '^@@'` 核对 hunk 数再喂答案（防边界漂移错暂存）；提交后 `git diff --numstat <file>` 为空才算拆干净。
- **并行会话在途的新文件不要顺手带上**（提交中途冒出来的 untracked 文件同理）。
- 提交是用户的显式动作，不要自行 commit / push。

## 常见误判

- 类型检查过、运行报错：多半是 `verbatimModuleSyntax` 的 type-only import（需 `import type`）。
- 冒烟失败但单测过：先确认产物是不是旧的重跑 `pnpm build`。
- Rust 改动没生效：`.app` 里跑的是 release 产物，用 `pnpm app:local --skip-build` 重编（它跳过前端构建，仍会重编 Rust 并重新组装）。
