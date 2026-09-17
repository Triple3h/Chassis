---
name: chassis-plugin-dev
description: 开发、修改、构建或发布本仓库的 Vue 插件（plugins/{totp,host-manager,text-diff,json-tools}）时使用。触发场景：新建一个 Vue 插件、增删 commands 清单、实现 view/no-view/script 命令、用 exec.run 调用脚本、把产物装进 extensions 目录、排查插件白屏或宿主 API 报错。关键词：插件、extension、commands、exec.run、extensions 目录、Vite + Vue。
allowed-tools:
disable: false
---

# Vue 插件开发（plugins/ 下的 Vite + Vue 插件）

按下面的顺序做，不要跳步。硬约束见 `.codebuddy/rules/chassis-plugin/RULE.mdc`；
原理与踩坑复盘见 `docs/plugin-dev-guide.md`。

## 第 1 步：确定命令形态

先问清楚这个功能需要什么能力，再决定 `mode`：

| 需求 | 形态 | 环境 |
|---|---|---|
| 要界面、要交互 | `view` | iframe（静态页） |
| 无界面、用户主动触发的一次性任务 | `no-view` | 独立子进程（Rust，`dist/<name>`） |
| 只在 UI 内部调用的「后端函数」（读写文件、调系统命令） | `script` | 独立子进程（Rust，`dist/<name>`） |

要点：**iframe 里读不了本地文件路径**，凡是按路径读写磁盘的需求，一律走 `script`。

## 第 2 步：搭工程

在 `plugins/<name>/` 下建独立 Vite 工程（pnpm workspace 成员，依赖由仓库根 `pnpm install` 统一装）。
所有需要复制的配置模板在 [`references/scaffold-templates.md`](references/scaffold-templates.md)，包含：

- `package.json`（含 `commands` 清单、`build:view` / `build:scripts` 脚本、`@launcher/api` 依赖）
- `vite.config.ts`（UI，`base: './'` + 清单裁剪插件 + vue 去重别名）
- `tsconfig.json`、`src/styles/app.css`、`src/main.ts`、`index.html`
- `Cargo.toml`（有 no-view/script 命令时才需要：crate `launcher-plugin-<id>`，**crate 根 = 插件目录**、源码直接放 `src/`；`[[bin]]` 名 = 命令名，依赖 `launcher-plugin-sdk`；新插件记得把 `plugins/<id>` 加进根 `Cargo.toml` 的 members）

装依赖：

```bash
pnpm install   # 仓库根；插件是 workspace 成员，不单独 install
```

## 第 3 步：写代码

- UI 复用 `@launcher/ui`：`AppShell`（页面骨架 + 轻提示）、`UiIcon`（图标）、`UiDialog`（弹窗）、`virtual`（虚拟滚动）、`clipboard` / `keys` / `theme` / `toast` 工具。
- 宿主能力**直连 SDK**：view 侧 `import { exec, host, hostUi, screenshot, storage } from '@launcher/api'`；
  逻辑层（Rust）用 `launcher_plugin_sdk`（`ctx.args` / `ctx.settings` / `ctx.data_path` / `ctx.done` / `ctx.fail` / `ctx.log` / `ctx.progress` / `ctx.on_query`）。
  先用 `host.isLauncher()`（同步）分流，失败路径在调用点兜（`.catch(() => null)`）。
- 大计算放 Worker：`plugins/text-diff/src/core/{worker,runner}.ts` 是标准范式（worker + 主线程降级 + 序号防串包）。
- 需要读本地文件时，照抄 `plugins/totp/`：纯逻辑放 `src/lib.rs`（可单测），`src/bin/read_image.rs` 是 `ctx.log/done` 胶水。

## 第 4 步：验证（不许跳）

```bash
npm run typecheck && npm run build && npm test
node scripts/spec-check.mjs <name>    # 仓库根；不传名字则检查全部插件
```

然后逐项确认：

1. `dist/` 里有 `index.html`、`assets/`、`package.json`；有逻辑层命令时还有 `dist/<name>`（可执行、0755）。
2. `dist/package.json` 的 `commands` 与源码一致，`no-view`/`script` 的名字与产物文件名逐字相同；`apiVersion` 是 `"2"`。
3. 起静态服务器打开 `dist/` 实机点一遍（**不要只测 dev server**）：
   ```bash
   python3 -m http.server 5233 --directory dist
   ```
4. 有 Worker 的功能，确认在网页面里真的走了 Worker（不是降级分支）。
5. 有逻辑层命令的，手工拉起产物做一次端到端（模拟宿主注入上下文，见 references/scaffold-templates.md 末尾）。

## 第 5 步：发布

```bash
pnpm build:plugins   # 仓库根：构建全部插件
pnpm pack:plugins    # 打 zip 到 plugins/release/
pnpm spec-check      # 发布前自检（清单 / N1 / N2 / N3 / 产物 / 远程资源）
```

安装：把 `dist/`（或解压后的 zip）放进 `<dataRoot>/extensions/<插件名>`（设置页的「插件管理」也能装），
然后在搜索框搜 `commands[].title`。

## 出问题

先看 [`references/troubleshooting.md`](references/troubleshooting.md) 的「症状 → 定位 → 修复」速查表；
里面没覆盖的，回到 `docs/plugin-dev-guide.md` §5 看原理。
