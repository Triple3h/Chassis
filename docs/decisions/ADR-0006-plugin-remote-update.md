# ADR-0006：插件远程更新 —— 下载在插件、安装在内核、覆盖出厂需内核放行

- 状态：已采纳
- 日期：2026-09-18
- 相关：`docs/plugin-spec.md` §2.3 / §6.4 / 附录 C、`docs/launcher-requirements.md` §9 / §13（M7）；ADR-0003（`ctx.settings` 只注入 `internal-` 前缀）

## 背景

出厂插件随 App 包发布，改一行也要重新打包整个 App。M5 之后逻辑层是 Rust 可执行产物，更不可能"改个 JS 就生效"。
需要一条独立通道：**除 3 个 essential 出厂插件外，其余出厂插件可在线更新、不重启 App 生效**。

两个前置事实决定了形态：

1. 内核**零能力**（不联网）⇒ 拉索引与下载只能由插件做；
2. 插件目录归内核管 ⇒ 覆盖规则 / 原子替换 / 回滚只能由内核做（一致性与权限的唯一裁决者）。

## 决策

### 1. 不拆仓库：独立发版靠 tag + Release，与仓库边界无关

热更新只取决于两件事：`extensions/` 能否覆盖出厂插件（内核规则）与一套独立发布通道（固定 tag `plugins-latest` 的 Release 资产）。两者都与"源码在几个仓库"正交。
拆仓库反而增加环节：SDK 要发包、工具链要独立、App 组装要跨仓库拉产物、协议变更要跨仓库协调。

### 2. 三段分工（每条都有理由）

| 环节 | 归属 | 理由 |
|---|---|---|
| 拉索引 / 版本比对 / 下载 / sha256 校验 | `internal-store` 的逻辑层命令（`update`） | 内核零网络 |
| **发起安装** | `internal-store` 的 **view 页**（`ctx.settings.pluginAction('installZip')`） | 更新 `internal-store` 自己时，`installZip` 内部的 `disable()` 会杀掉正在执行命令的子进程 ⇒ 命令收不到结果；view 跑在宿主 webview，不受影响 |
| 覆盖规则 / 原子替换 / 备份 / 回滚 / 恢复出厂 | 内核 | 插件目录归内核管 |

管理动作只认 `internal-` 前缀（ADR-0003）⇒ 更新器必须叫 `internal-store`，不新增通用 API。

### 3. 内核放行「覆盖非 essential 出厂插件」，但 essential 只认出厂身份表

`extensions/<id>/` 可覆盖非 essential 出厂插件，覆盖后 `builtin` 仍为 true（不可卸载、可禁用）。
`is_essential()` 改为查**出厂身份表**（`scan()` 时从出厂 bundle 清单读出），不再读当前生效目录的清单 ——
否则一个被放进 `extensions/` 的版本只要声明 `essential: true`，就白拿了「不可禁用 + 免审计」（`audit.set_exempt` 走的正是 `is_essential`）。

### 4. 安装是原子的，且任何失败路径都不允许「插件消失」

`staging → disable(Reload) → 旧版本整目录备份 → rename 落地 → scan + load`，load 失败自动回滚并报 `UPDATE_FAILED`。
**绝不走 `uninstall` 路径**：那条会清 `plugin-overrides.json` 与 `plugin-settings.json`（升级必须保留用户设置与别名）。
备份只保留最近 1 份；出厂版本不需要备份（App 包里本来就还有一份，`revertToBuiltin` 就是回到它）。

### 5. v1 的信任模型：固定仓库 + HTTPS + sha256，不上签名

- 更新源是**编译期常量**（固定 tag `plugins-latest`；不用 `releases/latest` —— 会被 App 的 `v*` Release 顶掉）；
- `download` 命令**只接受插件 id，不接受 URL**（下载地址一律从索引取），杜绝"被诱导下载任意包"；
- 下载后强制 sha256 校验，不匹配即删除文件；
- 多源（镜像 / 加速代理）与签名（`sig` 字段预留）**不在 v1**：一旦引入第三方通道，"GitHub 账号 + TLS"的信任模型就不成立，那时签名必须同期上。

### 6. 平台分化：一份索引、多份产物

逻辑层是原生产物（Rust 可执行文件），索引的每个插件带 `assets[]`，按 `platforms` / `arch` 挑；zip 命名 `<id>-<version>-<platform>-<arch>.zip`。
CI 双平台各自原生构建 → 各出一份分片 → 汇总成 `registry.json`（schema 1，未知 schema 客户端直接拒绝）。

## 不做（v1）

- essential 三个的热更新（随 App 包发布）；第三方插件的更新（仍走手动装 zip）
- 静默自动安装（替换可执行产物至少要用户点一次）、后台自动检查（打开页面即检查 + 手动按钮足够）
- 自定义更新源、差分更新、灰度、多通道、App 自身更新
- 「浏览未安装插件并安装」（那是商店 v2 的活）
