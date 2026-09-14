---
name: sofast-plugin-dev
description: 开发、修改、构建或发布如快 Sofast 插件时使用。触发场景：新建一个 sofast 插件、增删 commands 清单、实现 view/no-view/script 命令、用 Backend.run 调用脚本、把产物安装到 extensions 目录、排查插件白屏或宿主 API 卡死。关键词：sofast、如快、插件、extension、commands、Backend.run、extensions 目录。
allowed-tools:
disable: false
---

# 如快 Sofast 插件开发

按下面的顺序做，不要跳步。硬约束见 `.codebuddy/rules/sofast-plugin/RULE.mdc`，原理与踩坑复盘见 `docs/sofast-plugin-dev-guide.md`。

## 第 1 步：确定命令形态

先问清楚这个功能需要什么能力，再决定 `mode`：

| 需求 | 形态 | 环境 |
|---|---|---|
| 要界面、要交互 | `view` | iframe（静态页） |
| 无界面、用户主动触发的一次性任务 | `no-view` | Node Worker |
| 只在 UI 内部调用的「后端函数」（读写文件、调 Node 生态） | `script` | Node Worker |

要点：**iframe 里读不了本地文件路径**，凡是按路径读写磁盘的需求，一律走 `script`。

## 第 2 步：搭工程

在 `presets/<name>/` 下建独立 Vite 工程。所有需要复制的配置模板在 [`references/scaffold-templates.md`](references/scaffold-templates.md)，包含：

- `package.json`（含 `commands` 清单与 `build` 脚本串联方式）
- `vite.config.ts`（UI，`base: './'` + 写清单插件 + shared alias）
- `vite.worker.config.ts`（有 no-view/script 命令时才需要）
- `tsconfig.json`、`src/styles/app.css`、`src/main.ts`、`index.html`

装依赖：

```bash
cd presets/<name>
npm install --no-fund --no-audit
npm i @sofastapp/api         # script 命令也要装（@sofastapp/api/node 在同一包里）
```

## 第 3 步：写代码

- UI 复用 `shared/`：`AppShell`（页面骨架 + 轻提示）、`SofIcon`（图标）、`SofDialog`（弹窗）、`useVirtualList`（虚拟滚动）、`platform`（宿主能力）。
- 宿主能力**只准**通过 `shared/lib/platform.ts` 调；新增能力时先在那里加封装（超时 + 降级），再在 UI 用。
- 大计算放 Worker：`presets/sofast-text-diff/src/core/{worker,runner}.ts` 是标准范式（worker + 主线程降级 + 序号防串包）。
- 需要读本地文件时，照抄 `presets/sofast-totp/src/no-view/`：`find-image.ts` 放纯逻辑（可测），`read-image.ts` 是 `ctx/log/done` 胶水。

## 第 4 步：验证（不许跳）

```bash
npm run typecheck && npm run build && npm test
```

然后逐项确认：

1. `dist/` 里有 `index.html`、`assets/`、`package.json`；有 script 命令时还有 `dist/<name>.mjs`。
2. `dist/package.json` 的 `commands` 与源码一致，`no-view`/`script` 的名字与 `.mjs` 文件名逐字相同。
3. 起静态服务器打开 `dist/` 实机点一遍（**不要只测 dev server**）：
   ```bash
   python3 -m http.server 5233 --directory dist
   ```
4. 有 Worker 的功能，确认在网页面里真的走了 Worker（不是降级分支）。
5. 有 script 命令的，用 `worker_threads` 直接拉起产物做一次端到端（模拟宿主，见 references/scaffold-templates.md 末尾）。

## 第 5 步：发布

```bash
node presets/scripts/build-all.mjs --pack   # 仓库根：全部构建 + 打包到 presets/release/*.zip
node presets/scripts/spec-check.mjs         # 发布前自检（清单/N1/N2/N3/产物/远程资源）
```

安装：把 `dist/`（或解压后的 zip）放进 `<如快安装目录>/extensions/<插件名>`，**重启如快**，在命令面板搜 `commands[].title`。

## 出问题

先看 [`references/troubleshooting.md`](references/troubleshooting.md) 的「症状 → 定位 → 修复」速查表；里面没覆盖的，回到 `docs/sofast-plugin-dev-guide.md` §5 看原理。
