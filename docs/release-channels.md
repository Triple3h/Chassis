# 发布通道与版本策略

> 读者：发版操作者与维护 CI 的人。机制的**内部实现**不在这里：
> 应用自更新见 [`shell-hot-update.md`](shell-hot-update.md)，内核热更新见 [`kernel-hot-update.md`](kernel-hot-update.md)，
> 插件更新契约见 [`plugin-spec.md`](plugin-spec.md) §6.4 与附录 C（含三段分工的理由）。

四条 tag 通道互相独立，客户端只读 `releases/download/<tag>/...` 直链 —— **不需要 GitHub API，也不需要 token**。
三条自更新通道的产物还会额外发布到 npm，客户端优先从 npmmirror 的**签名索引**读取（§7）；tag 直链仍是主通道与兜底。
独立发版靠 tag + Release，与仓库边界无关：不拆仓库（SDK 发包、工具链独立、App 组装跨仓库拉产物、协议变更跨仓库协调，成本都大于收益）。

| 通道 | tag | 触发 | 产物 | 客户端入口 |
|---|---|---|---|---|
| App 换包（给人） | `v*` | 推 tag → `release.yml` | 整包（`.app` / 绿色版 zip） | 新机器安装 / 手动换包 |
| App 自更新 | `app-latest` | `workflow_dispatch` → `app-release.yml`，或 tag `app/*` | `app-registry.json` + `Chassis-<版本>-<平台>-<架构>.zip` | 托盘「检查更新…」/「关于」页 → 更新页 →「应用」 |
| 内核 | `kernel-latest` | `workflow_dispatch` → `kernel-release.yml`，或 tag `kernel/*` | `kernel-registry.json` + `launcher-kernel-<版本>-<平台>-<架构>.zip`（内核 + `ui/`） | 更新页 →「内核」 |
| 插件 | `plugins-latest` | 推 tag `plugins/<id>/<ver>` → `plugins-release.yml`，或 `workflow_dispatch` | `registry.json` + `<id>-<版本>-<平台>-<架构>.zip` | 更新页 → 单个插件 |

> npm/npmmirror 是三条自更新通道的**额外读取路径**（不是第五条 tag）：CI 把产物与签名索引发到 npm，
> 客户端优先读 `registry.npmmirror.com`，失败回落加速代理 / GitHub。见 §7。

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
- **Gitee 镜像已移除**：国内下载改由 npm/npmmirror 承担（见 §7）。客户端不再把 `gitee.com` 视为更新源，
  回落链变成「加速代理 → GitHub」；仓库 secret `GITEE_TOKEN` 可以删除。
- **npm 通道**：GitHub Release 之后跑 `scripts/publish-npm.mjs`（产物包先、签名索引最后）。需要
  `NPM_TOKEN` 与 `INDEX_SIGNING_KEY`；包布局、签名与 trusted publishing 切换见 §7。
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

## 7. npm / npmmirror 读取路径

三条自更新通道的产物会**额外**发布到 npm，客户端（`internal-store` 下一版起）优先读 npmmirror，
拿不到再回落自有通道：索引走 GitHub，附件依次试加速代理 → GitHub。GitHub 通道本身不变。

**包布局**（scope = `@triple3h`，token 只授权这个 scope）：

| 包 | 内容 | 版本 |
|---|---|---|
| `chassis-app-<platform>-<arch>` / `chassis-kernel-<platform>-<arch>` | 对应平台的 zip | App / 内核版本 |
| `chassis-plugin-<id>` | 该插件的各平台 zip（单插件更新只下这一个包） | 插件版本 |
| `chassis-index-app` / `-kernel` / `-plugins` | `package.json` 的 `chassis.registry` 内嵌索引原文 + `sig` | `0.<yyyymmdd>.<epoch 秒>`（与产物版本无关） |

按平台拆 app/kernel 是为了避免为装一个平台下两个平台的包；按插件拆是为了避免为一个插件更新下载全量插件。

**索引必须签名**：npm/npmmirror 是第三方通道，而索引是信任根（决定「下载什么、校验值是多少」）。
`publish-npm.mjs` 用 ed25519 对索引**原文**签名，原文以字符串内嵌（避免两端 JSON 规范化差异），
`chassis.sig` / `keyId` 放在同一封装里；客户端先验签再解析，失败即拒绝该候选并回落自有通道。
密钥用 `pnpm index:key` 生成：私钥只进 CI secret `INDEX_SIGNING_KEY`，公钥编译进 `internal-store`。
契约见 [`plugin-spec.md`](plugin-spec.md) 附录 C。

**发布流程**：
1. CI 在 GitHub Release 之后跑 `node scripts/publish-npm.mjs --channel <c> --dir <产物目录>`：
   **产物包先、索引包最后**；产物版本已存在则跳过（幂等重跑）；索引版本每次都新。
2. 发布完自动 `PUT https://registry.npmmirror.com/-/package/<scope>%2F<name>/syncs` 触发同步：
   新包的元数据常先到、tarball 后到（实测不触发会持续 `NoSuchKey`）。同步失败不影响发布，
   客户端在空窗期会回落 mirrors 里的 GitHub zip（同一份 sha256）。
3. 首次启用某条通道必须**全量发布**（插件用 `plugins/all`）：npm 索引覆盖全量，没进过 npm 的包会 404。
4. 首发之后不再做 prune：npm 版本不可覆盖，旧版本永久保留（对老客户端反而是好事）；
   App 每版约 18MB，按发版频率评估存储增长。

**凭据与长期方案**：
- bootstrap：仓库 secret `NPM_TOKEN`（granular token，`@triple3h` scope，发布权限，最长 90 天）。
  **必须勾选 Bypass 2FA**：npm 当前拒绝没有 bypass 的 granular token 发布
  （`E403 … granular access token with bypass 2fa enabled is required`），账号本身关闭 2FA 也不例外。
  这个 token 只用于每个包的首次发布；包创建后立刻配 trusted publishing，见下一条。
- npm 从 2027-01 起移除「granular token 直接发布」：所有包创建后执行
  `node scripts/publish-npm.mjs --channel <c> --configure-trust`（内部是 `npm trust github …`），
  然后删掉 workflow 里的 `NODE_AUTH_TOKEN`，改走 `id-token: write` 的 OIDC（npm ≥ 11.5.1）。
- 本机调试 `npm publish` 要显式 `--registry=https://registry.npmjs.org`（默认 registry 是只读的 npmmirror）。

**回滚**：npm 版本不可覆盖，回滚 = 重发一个索引版本指向旧产物版本；已装新版的客户端不会自动降级
（与 GitHub 通道语义一致），壳/内核的崩溃回滚仍由各自机制负责。
