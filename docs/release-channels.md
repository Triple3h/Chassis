# 发布通道与版本策略

> 读者：发版操作者与维护 CI 的人。机制的**内部实现**不在这里：
> 应用自更新见 [`shell-hot-update.md`](shell-hot-update.md)，内核热更新见 [`kernel-hot-update.md`](kernel-hot-update.md)，
> 插件更新契约见 [`plugin-spec.md`](plugin-spec.md) §6.4 与附录 C（含三段分工的理由）。

四条 tag 通道互相独立，客户端只读 `releases/download/<tag>/...` 直链 —— **不需要 GitHub API，也不需要 token**。
独立发版靠 tag + Release，与仓库边界无关：不拆仓库（SDK 发包、工具链独立、App 组装跨仓库拉产物、协议变更跨仓库协调，成本都大于收益）。

| 通道 | tag | 触发 | 产物 | 客户端入口 |
|---|---|---|---|---|
| App 换包（给人） | `v*` | 推 tag → `release.yml` | 整包（`.app` / 绿色版 zip） | 新机器安装 / 手动换包 |
| App 自更新 | `app-latest` | `workflow_dispatch` → `app-release.yml`，或 tag `app/*` | `app-registry.json` + `Chassis-<版本>-<平台>-<架构>.zip` | 托盘「检查更新…」/「关于」页 → 更新页 →「应用」 |
| 内核 | `kernel-latest` | `workflow_dispatch` → `kernel-release.yml`，或 tag `kernel/*` | `kernel-registry.json` + `launcher-kernel-<版本>-<平台>-<架构>.zip`（内核 + `ui/`） | 更新页 →「内核」 |
| 插件 | `plugins-latest` | 推 tag `plugins/<id>/<ver>` → `plugins-release.yml`，或 `workflow_dispatch` | `registry.json` + `<id>-<版本>-<平台>-<架构>.zip` | 更新页 → 单个插件 |

## 1. 触发口径

- **日常用 `pnpm ship`**：本地 bump → verify → commit → tag → 推送（默认 SSH）。不经过 GitHub API / token，
  也不需要 `gh` 登录；一条命令对应一次发布：
  `pnpm ship kernel` / `pnpm ship app` / `pnpm ship plugin json-tools`。
  加 `--version x.y.z` 指定版本、`--notes "…"` 覆盖自动生成的变更说明、`--skip-verify` 跳过本地验证、`--dry-run` 只打印计划。
  版本已经是目标值时只打 tag（提交已就位、只差发布时用同一条命令）。
- **CI 不在 `main` 推送时运行**：`verify.yml` 用 `branches-ignore: ['main']`；四条发布 workflow 都只响应
  `workflow_dispatch` 或各自的一次性 tag。合并到 `main` 不构建任何东西，发布永远是显式动作。
- **tag 约定**（`scripts/lib/release-tag.mjs`，`pnpm ship` 与 workflow 共用同一份解析）：
  - `kernel/<x.y.z>` → 内核
  - `app/<x.y.z>` → App 自更新
  - `plugins/<id>/<x.y.z>` → 只打这个插件（增量）
  - `plugins/all[/<label>]` → 全部非 essential 插件
- 发布 workflow 取的是**触发时的提交**：tag 指向的提交必须已经包含本次代码（`pnpm ship` 会先 commit 再打 tag）。
  同名 tag 不能重复推；`pnpm ship` 在「tag 已存在但指向 HEAD」时会复用，方便推送失败后重试。
- `app-release.yml` / `kernel-release.yml` 的 `notes` 与 `min_hot_version` / `min_shell_hot_version`、
  插件的 `min_kernel` 目前只能通过 `workflow_dispatch` 传；日常发版用 tag 即可。

## 2. 版本

- **唯一维护点是根 `version.json`**：`app` = 壳/App，`kernel` = 内核。
  `pnpm version:set app 0.1.12` 同步 `apps/shell/tauri.conf.json`、`apps/shell/Cargo.toml`、`apps/shell/Cargo.lock`；
  `pnpm version:set kernel 0.1.9` 同步 `apps/kernel/Cargo.toml` 与根 `Cargo.lock`。
  `pnpm version:check` 拦漂移，且在每条发布 workflow 里都跑。
- **绝不手改上述 `version` 字段**：漂移会让客户端看不到新版本，自更新链路**静默失效**。
- 插件版本在各自 `package.json`；机制版本 `SHELL_HOT_VERSION`（`apps/shell/src/update.rs`）与
  `HOT_UPDATE_VERSION`（`apps/kernel/src/hot/spec.rs`）独立演进 —— 只有机制本身变了才动它们，
  且内核 spec 必须声明与 `HOT_UPDATE_VERSION` 相同的值。
- **App 升级会重置内核基线**：壳把包内内核重投到 `<dataRoot>/kernel/`（台账 `kernel.json` 记 `sourceAppVersion`）。
  所以内核热更新只是「两次 App 发版之间的领先」，不是替代 App 通道。

## 3. 变更记录（CHANGELOG）

- 每个通道一份 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式的文件：
  `CHANGELOG.md`（App）、`CHANGELOG-kernel.md`（内核）、`plugins/<id>/CHANGELOG.md`（插件）。
- 条目由 `pnpm ship` 从 Conventional Commits 自动生成：`feat → Added`、`fix → Fixed`、
  `perf/refactor/revert → Changed`；`docs/chore/test/ci/build/style` 不进；`!` 标 **BREAKING**。
  基线是上一次发布 tag，没有 tag 时退回版本位点文件的上一次改动。
- 想写汇总或对外措辞：`pnpm ship ... --notes "…"` 覆盖自动生成的那一段。
- 发布 workflow 在 `notes` 输入为空时，把该版本段落写进索引的 `notes`，更新页直接显示。
- 共享包（`packages/plugin-api`、`packages/ui`）的变化不自动计入某个插件；需要时用 `--notes` 说明。
- 首个版本的 changelog 从下一次发布开始生成，不回溯历史。

## 4. 可见性与门槛

- 更新源是编译期常量（固定仓库地址），**发布即对所有装机客户端可见，没有灰度**。
- 唯一的门控在索引里：`minHotVersion`（内核包 vs 客户端内核热更新机制）、
  `minShellHotVersion`（App 包 vs 客户端壳自更新机制）、`minKernel`（插件索引 vs 运行中的内核）。
  不满足时更新页只提示、不给「更新」按钮。
- 内核 / 插件更新**不重启 App**（热替换）；App 更新会**重启整个应用**（内核随之重启），这是该通道的目的。

## 5. 发布收尾（三条固定 tag 共用）

- **只保留索引指向的资产**：`action-gh-release` 之后跑 `scripts/prune-release-assets.mjs`，删掉当前索引不再指向的 `.zip`。
  zip 名带版本号、覆盖上传只认同名 ⇒ 不清理会无限积累孤儿；单个 Release 上限 1000 个资产，攒满会中断发布。
- **插件索引必须合并**：增量发布时 `gen-plugin-registry.mjs --merge-registry <上一版 registry.json>` 把没打包的插件整条沿用
  （`plugins-release.yml` 自动做）。少了这一步，索引里只剩本次打包的插件，其余插件对客户端等于「不存在」。
  守卫：`tests/unit/plugin-registry-merge.test.ts`。
- **Gitee 镜像**：发布收尾跑 `scripts/sync-release-to-gitee.mjs`，把本次索引与 zip 同步到同名 tag / 同名文件。
  需要仓库 secret `GITEE_TOKEN`（Gitee 私人令牌，`projects` 权限）；未配置时跳过，这步 `continue-on-error`，失败不阻塞主通道。
  - 删除策略与 prune 同构（**按索引保留**）：若「全删再传」，会误删本次没重发的插件包（`tests/unit/gitee-release-sync.test.ts` 守护）。
  - 请求串行 + 退避：Gitee 普通仓库附件总量 1GB，匿名 API 也有限流。
  - 客户端（`internal-store` ≥ 0.1.3）**镜像优先、主源回落**：索引与产物都先试镜像，
    连不上 / HTTP 错 / sha256 不符就换下一个候选；`lib.rs::PRIMARY_BASE` / `MIRROR_BASE` + `mirror_url()` 推导地址（大小写不敏感），
    `bin/update.rs::fetch_verified()` 逐个校验，`gitee.com` 在 `is_allowed_host` 白名单里。日志会写明实际来源。
- **App 包签名**：CI 用与本机相同的固定证书（`MACOS_SIGN_P12` / `MACOS_SIGN_P12_PASSWORD`，
  由 `node scripts/export-signing-cert.mjs` 一次性导出）。没配就回落 ad-hoc —— 包照发，但用户每次自更新后
  都要重新授权辅助功能 / 屏幕录制（TCC 按签名身份记账）。细节见 [`permissions.md`](permissions.md)。

## 6. 常用命令

```bash
pnpm version:check                                  # 发版前自查（workflow 里也会跑）
pnpm ship kernel                                    # 内核：bump patch → verify → commit → tag → 推送
pnpm ship plugin json-tools                         # 单个插件（增量）
pnpm ship app                                       # App 自更新
pnpm ship plugin json-tools --version 0.4.1         # 版本已就位：只打 tag 发布
pnpm ship kernel --dry-run                          # 只看计划，不改仓库

# 需要 notes / min_* 门控时仍可走 dispatch：
gh workflow run plugins-release.yml --ref main -f plugins="totp" -f min_kernel=0.1.9
```
