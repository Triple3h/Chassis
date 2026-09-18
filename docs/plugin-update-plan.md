# 插件远程更新方案（规划）

> 状态：**已实现（M7，2026-09-18）** —— 内核规则 / 分发链路 / `internal-store` 三批都已落地，见文末 §12「实现状态」。
> 日期：2026-09-17 ｜ 关联：`docs/plugin-spec.md`（§2.3 / §6.4 / 附录 C）、`docs/launcher-requirements.md`（§9 供应链 / §13 M7）、`docs/decisions/ADR-0006-plugin-remote-update.md`
> 决策前提：**不拆仓库** —— 底座与全部出厂插件同仓库；插件的独立发版靠 tag + Release 资产，与仓库边界无关（见 §0.3）。

---

## 0. 目标与边界

### 0.1 目标

- **除 3 个 essential 出厂插件（`app-launcher` / `file-search` / `internal-settings`）外的 11 个出厂插件**支持：
  从 GitHub 检查更新 → 下载 → 校验 → **不重启 App 生效**（热更新）。
- 更新全程保数据（插件设置 / 别名覆盖 / 历史 / 固定项）、可回滚、失败不损坏现有安装。
- 开源后普通用户零配置可用（更新源编译期内置）；作者发版只需打一条流水线。

### 0.2 非目标（v1 明确不做）

| 不做 | 理由 |
|---|---|
| essential 三个的热更新 | 它们是底座基础能力（禁用它底座残废 / 用户失去自救入口）；随 App 包发布，由 App 更新覆盖 |
| 第三方插件自定义更新源 | 信任模型后置；第三方插件的安装仍走「设置页手动装 zip」。开放自定义源 = 任意代码执行的入口 |
| 静默自动安装 | 更新会替换可执行产物，至少要用户点一次 |
| 代码签名（minisign / ed25519） | v1 用 sha256 + HTTPS + 固定域名；registry schema 预留 `sig` 字段，后续 minor 引入（**若走国内镜像，见 §3.6：签名建议提前到 v1**） |
| 差分更新 / 灰度 / 多通道（stable / beta） | 独立发布单元粒度太小，收益低 |
| App 自身更新 | 那是另一件事（requirements §6.3，tauri-plugin-updater + minisign，自用版未做） |
| 更新前备份「N 个历史版本」 | 保留最近 1 个用于回滚即可；再往前靠「恢复出厂版本」与重新下载 |

### 0.3 为什么不需要拆仓库

「热更新」取决于两件事：**① `extensions/` 能覆盖出厂插件（内核规则）；② 有一套独立的发布通道（tag + Release + 索引）**。两者都与「源码放在几个仓库」正交：

- 单仓库同样可以让 `plugins-release.yml` 只构建、只发布 `plugins/<id>`，打独立 tag、生成独立索引；App 包里的插件只是「出厂快照」，热更新拉的是 Release 资产；
- 拆仓库反而给这条路增加环节：SDK 要发 npm/crates.io、构建工具链要独立包、App 组装要跨仓库拉产物、协议变更要跨仓库协调。

---

## 1. 现状约束（实现前必读）

### 1.1 两个硬阻塞（不解决就没有热更新）

| # | 阻塞 | 位置 | 后果 |
|---|---|---|---|
| B1 | `scan()` 里 **extensions 永远不覆盖同 id 的出厂 bundle**：`if builtin \|\| !found.contains_key(&id) { found.insert(...) }` | `apps/kernel/src/plugin/manager.rs:502-505` | 11 个出厂插件装新版本到 `extensions/` 也**不生效**；且 `uninstall` 对 builtin 直接 `FORBIDDEN`（`:944-946`） |
| B2 | 安装**非原子**：先 `remove_dir_all(target)` 再 `copy_dir_recursive` | `apps/kernel/src/plugin/manager.rs:846-849` | 升级中途失败 = 插件消失；无备份、无回滚 |

### 1.2 三条不可绕的架构约束

1. **内核零能力**：内核不联网 ⇒ 拉索引与下载必须由插件（逻辑层 Rust 子进程）完成。
2. **管理面只认 `internal-` 前缀**（ADR-0003，`services/settings.rs:45-50`）⇒ 安装动作走 `ctx.settings.pluginAction('installZip', …)`，不新增通用 API。
3. **N1 / N2**（plugin-spec）⇒ 更新只替换**安装目录**；插件可变数据只在 `dataPath`，更新天然不碰用户数据。

### 1.3 已有的可复用件（尽量不加新机制）

| 复用件 | 位置 | 用途 |
|---|---|---|
| `--builtin-plugins` 多根（逗号分隔） | `apps/kernel/src/cli.rs` | 打包/开发时多来源组装 |
| `install_from_zip`（拒绝绝对路径 / `..`、单文件 ≤ 50MB、解压后 ≤ 200MB） | `apps/kernel/src/plugin/manager.rs:862-938` | 安装原语，本方案在其上做原子化 |
| `reload()` + `plugin/reloaded` 事件 + UI 换会话重开 | `apps/kernel/src/plugin/manager.rs:736-756`、`apps/launcher-ui` | 更新后免重启生效的全部链路 |
| `ctx.settings.plugins()`（返回 `id/title/version/apiVersion/capabilities/state/builtin/essential/dir`） | `apps/kernel/src/plugin/manager.rs:257-272` | 更新器读取本地版本的唯一渠道 |
| `pluginAction` 的 `installZip` / `installDir` / `reload` / `reveal` | `apps/kernel/src/plugin/admin.rs:53-70` | 管理动作入口 |
| `scripts/pack-plugins.mjs` | 已存在 | zip 打包（需改命名，见 §3.1） |
| 设置页「插件」tab（主从两栏、4s 轮询、事件委托） | `plugins/internal-settings/src/view/main.ts` | 更新状态展示的落点之一 |

---

## 2. 总体设计

```
GitHub（分发侧）                    internal-store（插件侧）                  内核（规则与安装）
────────────────────              ─────────────────────────────           ──────────────────────────────
registry.json  ────① check ──────▶ 拉索引 + 与本地版本比对（semver）
<id>-<ver>.zip ────② download ───▶ 下载 → sha256 校验 → <dataPath>/downloads/
                                      │
                                      └──③ installZip（由 view 发起）────▶ M1 覆盖规则（非 essential）
                                                                            M2 原子替换 + 备份 + 回滚
                                                                            M3 revertToBuiltin（恢复出厂）
                                     ◀── plugin/reloaded ──────────────────  reload()
```

**职责切分（每条都有理由）**：

| 环节 | 归属 | 理由 |
|---|---|---|
| 拉索引 / 版本比对 / 下载 / 哈希校验 | `internal-store` 的逻辑层命令 | 内核零网络 |
| **发起安装** | `internal-store` 的 **view 页**（宿主 webview，通过 `ctx.settings.pluginAction`） | 更新 `internal-store` 自己时，`installZip` 内部的 `disable()` 会杀掉正在执行命令的子进程 ⇒ 命令收不到结果；view 不受影响 |
| 覆盖规则 / 原子替换 / 回滚 / 恢复出厂 | **内核** | 插件目录归内核管；权限与一致性的唯一裁决者 |
| 展示与用户确认 | `internal-store` view 页 | — |

---

## 3. 分发侧规格（GitHub）

### 3.1 产物与命名

- `scripts/pack-plugins.mjs` 产物从 `<name>.zip` 改为 **`<id>-<version>.zip`**（plugin-spec §2.3 已建议此命名），避免 Release 附件互相覆盖。
- zip 根 = 插件目录内容（现状已符合，`zip -r <zip> .`）。
- 版本号来源：插件 `package.json` 的 `version`（构建产物 `dist/package.json` 里的同一字段）。

### 3.2 `registry.json`（schema 1）

```jsonc
{
  "schema": 1,                                  // 未知 schema ⇒ 客户端拒绝（不猜测）
  "generatedAt": "2026-09-17T12:00:00Z",
  "plugins": {
    "totp": {
      "title": "双重验证器",
      "version": "0.5.0",                       // semver，来自产物清单
      "apiVersion": "2",                        // 来自产物清单
      "minKernel": "0.5.0",                     // 可选：低于此内核版本不提示更新（内核版本取 host.info().version）
      "notes": "修复倒计时漂移",                  // 可选：展示在更新页
      // 实现时改为 assets[]：逻辑层是原生产物，一个平台一份（见 §12）
      "assets": [
        {
          "platforms": ["macos"],               // 省略 / 空数组 = 不限制（与 spec §3.5 同义）
          "arch": ["arm64"],
          "url": "https://github.com/<owner>/<repo>/releases/download/plugins-latest/totp-0.5.0-macos-arm64.zip",
          "sha256": "…64 位十六进制…",
          "bytes": 808995
        }
      ]
    }
  }
}
```

`sig`（预留的签名字段）在实现版里**不出现**：v1 只走 GitHub 官方源，信任模型 = 固定仓库 + HTTPS + sha256（§12 拍板结果）。

- `title` / `platforms` / `arch` 在生成端从 `dist/package.json` 原样读出，客户端**不重复维护**。
- `notes` 在 v1 由发布者在 workflow 输入或从 `CHANGELOG` 片段取，可省略。
- `url` 在引入多源（§3.6）后**应改为相对文件名**（如 `"file": "totp-0.5.0.zip"`），由客户端与「源基址」拼接；`url`（绝对）作为单源兼容保留。

### 3.3 发布通道：固定 tag + Release 资产

- 用一个**固定的 tag（`plugins-latest`）**承载插件发布：每次发布更新该 Release 的资产（GitHub 允许覆盖同名资产）。
- 更新源 URL（编译期常量，写进 `internal-store`）：

```
https://github.com/<owner>/<repo>/releases/download/plugins-latest/registry.json
```

- **不要用 `releases/latest/download/...`**：App 的 `v*` Release 会成为 latest，把插件索引顶掉（404）。
- 为什么走 Release 而不是仓库文件（raw / Pages）：公开仓库 artifact 下载需登录、raw 有 CDN 缓存延迟；Release 资产是「一次发布 = 原子切换」，且 `releases/download/<tag>/<asset>` 是稳定直链，无需 GitHub API、无 token、无速率限制。

### 3.4 CI 流水线（新增 `.github/workflows/plugins-release.yml`）

与 App 的 `release.yml`（tag `v*`）**完全独立**：

- 触发：`workflow_dispatch`（输入：插件名列表 + 可选 notes / minKernel），或 `push` tag `plugins/*`。
- 步骤：
  1. `pnpm install` → `pnpm build`（或只建指定插件）；
  2. `node scripts/pack-plugins.mjs <id…>` → `plugins/release/<id>-<version>.zip`；
  3. `node scripts/gen-plugin-registry.mjs <id…>`（**新脚本**）：逐个算 sha256 → 生成 `registry.json`；
  4. `softprops/action-gh-release` 上传到固定 tag `plugins-latest`（`allowUpdates: true`，`prerelease: false`）。
- 零 secrets（公开仓库 Actions 免费）；v1 若不上签名 ⇒ CI 不引入任何私钥。

### 3.5 版本与兼容

- 插件版本独立演进（semver），与 App 版本无绑定；**兼容性由两个字段表达**：
  - `apiVersion`（插件清单声明，内核加载期校验，已在）；
  - `minKernel`（registry 字段，更新器判断，避免「装上去起不来」）。
- 内核侧不做版本比较（零能力/零策略），只负责「装」与「装载校验」。

### 3.6 国内可达性与多源回落（2026-09-17 补）

**事实**：GitHub **没有**官方中国镜像。国内「能用」的通道都是第三方搭的加速层或镜像，分四类：

| 类别 | 例子 | 适用 | 风险 |
|---|---|---|---|
| 文件加速代理（前缀拼接式） | gh-proxy 系列（域名频繁变更/关停） | Release 附件直链 | 随时失效；**内容经第三方，可投毒** |
| 仓库文件 CDN | jsDelivr / Statically | 只能取**仓库内文件**（有大小上限），**不能**取 Release 附件 | 适合放 `registry.json`（小文件），不适合放 zip |
| 国内代码平台镜像仓库 | Gitee / GitCode / CNB | 仓库 + 附件双发 | 需同步机制；平台政策（实名/流量/审查）不可控 |
| 自建 | Cloudflare Worker 反代 / 国内 OSS+CDN | 完全可控 | 前者国内也不稳；后者需备案域名 + 成本 |

另一个常被忽略的事实：`github.com`（网页）、`api.github.com`、`objects.githubusercontent.com`（Release 资产直链）三个域名在国内的连通性**并不一致** —— 常见「浏览器打不开 github.com，但某个应用的更新却能下载」，因为该应用只走 API + objects 直链。所以「看起来不受影响」的项目，多数并没有镜像，只是**没走主站**（或自建 Worker 中转，例如 `koldllc/f50-monitor` 仓库里就有 `cloudflare-worker/` 目录）。

**设计：把「源」做成候选列表，而不是写死一个 URL。**

- 客户端持有源基址列表，按序尝试（每个源超时 2–3s 即切换）：
  1. **Gitee 镜像**（同产物双发，最稳；发布时同步上传）
  2. 第三方加速代理（零成本、最不可靠、仅作兜底）
  3. **GitHub 官方**（`api.github.com` + `objects.githubusercontent.com` 直链，海外首选）
  4. 自建 Worker 反代 / 国内 OSS+CDN（可选增强）
- **所有通道必须分发逐字节相同的 zip**（一次构建、多处上传）⇒ 各源 sha256 一致，校验才有意义。
- `registry.json` 很小，可同时放「仓库文件」（走 raw / jsDelivr）与「Release 资产」，客户端同样按源尝试。
- **安全升级（本节引发的变更，重要）**：多源意味着「HTTPS + GitHub 账号」的信任模型**不再成立**（加速层与镜像方可见、可篡改内容）⇒
  - sha256 从「防损坏」升级为「必须」；
  - **签名（`sig`）从「v2 可选」升级为「建议 v1 就做」**：公钥编译进客户端、签名覆盖 zip 内容，任一源被投毒都无法绕过校验。
- 用户可在设置页配置「更新源」（默认「自动（依次尝试）」）；实现上仍是 v1 范围（不做自定义 URL，只是内置源之间的选择）。

---

## 4. 内核侧改动（3 项，均不新增对外协议）

### 4.1 M1 —— `extensions` 允许覆盖「非 essential 出厂插件」

**行为规格**（`PluginManager::scan()`）：

| 出厂 bundle 里有该 id？ | 出厂清单 `essential` | extensions 里有同 id？ | 结果 |
|---|---|---|---|
| 是 | `true` | 有 | **忽略 extensions 版本** + `log warn`（底座基础能力不可被外部内容顶替） |
| 是 | `false` / 省略 | 有 | 用 extensions 的目录；`builtin` 标记**保留 true**（仍是出厂插件：不可卸载、可禁用） |
| 是 | — | 无 | 用 bundle（现状） |
| 否 | — | — | 用 extensions（现状，第三方插件） |

**实现要点**：

- 出厂 roots 先扫，顺带建 **出厂身份表** `id → { essential: bool }`（数据来自 bundle 的清单，可信来源）；
- `is_essential(id)` 改为**查身份表**，不再读当前生效目录的清单 —— 否则「把非 essential 插件换成声明 `essential: true` 的版本」= 白拿「不可禁用 + 免审计」（审计豁免 `kernel.rs:312` 的 `set_exempt` 走的就是 `is_essential`）；
- extensions 覆盖目录**清单读不出/非法**时：回落 bundle 版本 + 日志（fail-safe，不能让一次坏下载把插件变没）；
- 身份表读不到出厂清单时：该 id 按 **essential = true** 处理（保守，宁可不让覆盖）。

**测试用例（Rust 单测）**：

1. 非 essential 出厂插件：extensions 有覆盖 → `record.dir` 指向 extensions、`builtin=true`、`essential=false`；
2. essential 出厂插件：extensions 有覆盖 → `record.dir` 仍指向 bundle，且有一条 warn 日志；
3. extensions 覆盖目录清单损坏 → 回落 bundle、插件仍可加载；
4. 覆盖版本声明 `essential: true`（非出厂 id 也测）→ `is_essential()` 仍为 false。

### 4.2 M2 —— 原子安装（覆盖路径）+ 备份 + 回滚

**流程**（`install_from_directory` / `install_from_zip` 的 `overwrite` 路径）：

```
① 前置校验：清单合法 / apiVersion 支持 / platforms 匹配
② essential 拒绝：目标是 builtin && essential ⇒ FORBIDDEN（ESSENTIAL_PROTECTED）
③ 解压/拷贝到 <dataRoot>/extensions/.staging-<id>-<rand>   （必须同文件系统，rename 才原子）
④ disable(旧版, SessionCloseReason::Reload)                  （关会话、收常驻进程；Windows 上不先释放句柄 rename 必败）
⑤ rename(extensions/<id> → extensions/.backup/<id>/<旧版本>)  （旧版本不存在则跳过）
⑥ rename(.staging-… → extensions/<id>)
⑦ scan() + load()：was_disabled 的插件只替换文件不 load（与 reload() 语义一致）
⑧ 失败处理：
   - ⑤⑥ 任一步失败：能回滚就 rename 回旧目录，报 UPDATE_FAILED（附 rolledBack 标记）
   - ⑦ load 失败：rename 新目录到 .failed/<id>-<ts>、旧目录 rename 回来、重新 load，报 UPDATE_FAILED（rolledBack=true）
⑨ 清理：.backup 只保留最近 1 个版本；.failed 保留最近 1 个（供诊断）；安装成功后删除下载的 zip 由插件侧决定
```

**要点与边界**：

- `disable()` 用 **Reload** 语义（`SessionCloseReason::Reload`）：内核 reload 后 UI 会自动重开会话，用户正看着的插件页「原地换新」；首次安装无旧会话，不受影响。
- **绝不走 `uninstall` 路径**：那条路会清 `plugin-overrides.json` 与 `plugin-settings.json`（`manager.rs:950-951`）——升级必须保留用户设置与别名。
- 数据不受影响：设置 / 别名 / 历史 / 固定项全部按 id 寻址，更新只换安装目录。
- Windows：杀进程后句柄释放可能滞后 ⇒ `rename` 做**重试**（如 5 次 × 200ms）；仍失败则报错并保留旧版本（永不半替换）。
- `.backup` / `.failed` / `.staging-*` 目录都在 `extensions/` 下且以 `.` 开头 —— `scan()` 的 `name.starts_with('.')` 已跳过，不会误扫。
- 目录 watcher（2s 快照轮询 `start_watcher`）可能看到变化再触发一次 `reconcile/reload`：幂等，无害（实现时确认不会与显式流程互相打断）。
- 并发：同一 id 的安装串行（复用 manager 现有锁粒度即可）；v1 不做并发安装。

**错误码（新增，风格与现有一致）**：

| 码 | 场景 |
|---|---|
| `ESSENTIAL_PROTECTED` | 覆盖目标为 essential 出厂插件 |
| `UPDATE_FAILED` | 替换/加载失败（消息里附「已回滚 / 未回滚」） |

### 4.3 M3 —— `revertToBuiltin`（恢复出厂版本）

- 新 `pluginAction`：`revertToBuiltin { id }`。
- 语义：若 `extensions/<id>` 存在且覆盖着 bundle 版本 ⇒ 删除覆盖 → `scan()` → `load()`（同 reload 语义）；无覆盖 ⇒ 返回明确提示（不是错误）。
- 这是**逃生口**：更新到坏版本时用户能回到 App 自带的那份（卸载对 builtin 是 `FORBIDDEN`，必须有等价动作）。
- 是否清 `.backup`：一起清（避免「恢复了出厂但备份又把它装回去」的困惑）。

### 4.4 内核**不做**的事（保持零能力）

- 不联网、不认识 `registry.json`、不做版本比较、不校验 sha256（那是插件的活）。
- 只接受「一个本地 zip 路径」，在 `internal-` 插件语义下执行安装。

---

## 5. 更新器插件 `internal-store` 规格

### 5.1 形态与清单

| 项 | 值 |
|---|---|
| id / title | `internal-store` / 插件更新（v2 可改名「插件商店」） |
| 前缀 | **必须 `internal-`**：`ctx.settings` 只注入该前缀（ADR-0003） |
| essential | `false`（它自己也可以被更新机制覆盖；App 包里始终有一份可用的） |
| apiVersion | `"2"` |
| 命令 | `updates`（view，searchable，别名：插件更新 / 检查更新 / update / upgrade）；`update`（**script**，args.mode 分派 `check` / `download`，单产物名 = `update`，满足 N1 与多入口铁律） |
| capabilities | `hostUi`（footer）、`storage`（本地偏好，如「忽略此版本」）——逻辑层联网**不需要** capability（不是宿主能力，但要在清单 description 与文档中如实说明） |
| 依赖（Rust） | `ureq`（`default-features=false, features=["tls"]`，translate 已验证同款）、`sha2`、`semver`；均为小依赖 |

### 5.2 命令协议

`update`（script，NDJSON 单次请求-响应）：

```jsonc
// 入参
{ "mode": "check" }                       // 拉索引 + 比对
{ "mode": "download", "id": "totp" }      // 下载并校验（只接受 id，不接受 url——见 §6）

// 返回（mode=check）
{
  "checkedAt": 1758100000000,
  "current": { "totp": "0.4.0", "…": "…" },        // 来自 ctx.settings.plugins()
  "updates": [
    { "id": "totp", "title": "双重验证器", "current": "0.4.0", "latest": "0.5.0",
      "notes": "…", "minKernelOk": true, "platformOk": true }
  ]
}

// 返回（mode=download）
{ "id": "totp", "path": "/…/plugins/internal-store/downloads/totp-0.5.0.zip",
  "version": "0.5.0", "sha256": "…", "bytes": 1234567 }

// 错误：网络失败 / 索引 schema 未知 / 插件不在索引 / sha256 不匹配（删除已下载文件后报错）
```

- 索引只认**当前已装且非 essential** 的 id：`updates` 列表由「已装 id ∩ 索引条目 − essential − 标记忽略」得出。
- 版本比较在命令内（`semver` crate）；`minKernelOk` / `platformOk` 由该插件判断并展示（不满足则不给「更新」按钮）。

### 5.3 安装分工与时序

```
用户打开「插件更新」页
  → exec.run(update, { mode: 'check' })         // 逻辑层命令，网络在子进程
  → 渲染列表（v0.4.0 → v0.5.0 + notes）
用户点某项「更新」
  → exec.run(update, { mode: 'download', id })  // 下载 + sha256 校验 → 返回本地路径
  → ctx.settings.pluginAction('installZip', { path, overwrite: true })   // view 发起！
  → 内核 M2：disable(Reload) → 原子替换 → scan+load → plugin/reloaded
  → view 刷新列表（已是最新）
```

- **为什么安装必须由 view 发起**：更新 `internal-store` 自身时，命令进程会被 `disable()` 杀掉；view 跑在宿主 webview、生命周期不受目标插件影响。
- 更新 `internal-store` 自己：它的 view 会话会随停用关闭 → `plugin/reloaded` 触发 UI 用同一命令重开 → 用户看到页面闪一下重开，可接受；v1 在页面上给一句提示（「正在更新本插件，完成后页面会重新打开」）。
- 串行：v1 一次只处理一个更新（下载中禁用其它按钮）。

### 5.4 UI 规格（v1）

- 页面：顶栏（标题 + 「检查更新」按钮 + 「全部更新」）+ 列表行（图标 / 标题 / `v0.4.0 → v0.5.0` / notes / 「更新」按钮）+ 状态（下载中 / 校验中 / 安装中）+ 三种终态：已是最新 / 网络失败（重试）/ 索引不可用。
- footer：`hostUi.setFooter([{ button: 检查更新 }, { button: 全部更新 }])`。
- Esc / ⌘W 交还宿主（不消费），与其他插件页一致。
- 设置页「插件」tab 的入口（可选，v2）：顶部一行「插件更新」跳转；行内版本徽标显示「有新版」。
- 深色/浅色、`--launcher-motion-*` 令牌、`@launcher/ui` 组件 —— 与其他 view 插件同规范。

### 5.5 不做（v1）

- 不做「浏览未安装插件并安装」（那是商店 v2 的活；本方案只解决「已装插件的更新」）。
- 不做自动后台检查（打开页面时检查 + 手动按钮足够；v2 再加启动后延迟检查）。
- 不做「忽略此版本」的完整实现（v2；`storage` 能力先留着）。

---

## 6. 安全与信任模型

| 面 | 措施 |
|---|---|
| 更新源固定 | registry URL 是**编译期常量**；`download` 命令**不接受 URL 参数**（只接受 id，URL 由命令内部从索引取）——杜绝「被诱导下载任意包」 |
| 传输 | 仅 HTTPS；域名为固定集合（github.com / objects.githubusercontent.com / 选定的镜像域），命令内二次白名单校验 |
| 完整性 | 下载后强制 sha256 校验：不匹配 ⇒ 删除文件 + 报错，不进入安装 |
| 完整性（防源被篡改） | 单源（仅 GitHub）时接受「GitHub 账号 + TLS」信任模型；**一旦引入国内镜像/加速代理（§3.6），该模型失效** ⇒ 必须上签名：`sig` 用 minisign/ed25519（公钥编译进 `internal-store`；私钥签在本机，避免 CI secrets） |
| 权限最小化 | 安装动作仅 `internal-` 前缀可达（既有 guard，零新增）；`installZip` 的路径来自插件自己的 dataPath，用户不可注入 |
| essential 保护 | 更新器跳过 + 内核 M2 二次拒绝（双保险）；`is_essential` 查出厂身份表（防权限提升，§4.1） |
| 回滚 | 自动（load 失败）+ 手动（「恢复出厂版本」M3）；备份只保留最近 1 份 |
| 审计 | 安装/恢复动作走 `pluginAction`（internal 插件调用**不进审计**——等价底座自身行为，符合既有豁免口径）；`internal-store` 自己的网络与下载行为在插件内 `host.log` 记录（进审计） |
| 数据 | 只替换安装目录；用户数据按 id 寻址天然保留（§4.2） |
| 供应链 | zip 解压防护沿用 `install_from_zip`（绝对路径 / `..` / 符号链接 / 大小上限） |

---

## 7. 失败模式与回滚矩阵

| 步骤失败 | 磁盘状态 | 用户可见 | 恢复 |
|---|---|---|---|
| 拉索引失败（网络 / 404 / schema 未知） | 无变化 | 「无法检查更新，请稍后重试」 | 重试按钮 |
| 下载中断 | 无变化（临时文件删除） | 「下载失败」 | 重试 |
| sha256 不匹配 | 无变化（坏文件删除） | 「文件校验失败」（记 host.log） | 重试 / 换源 |
| 解压失败 / 清单非法 / apiVersion 不支持 / platforms 不匹配 | 无变化（staging 删除） | 「此版本与当前底座不兼容」 | 该条不显示更新 |
| 替换失败（rename 重试后仍失败，Windows 文件占用） | **旧版本原样** | 「安装失败，已保留旧版本」 | 关闭占用进程后重试 |
| 替换成功但 load 失败 | 自动回滚到旧版本 | 「新版本加载失败，已回滚」+ 错误原因 | 用「恢复出厂版本」或等修复版 |
| 更新途中断电 / 进程被杀（⑥⑦ 之间） | `.staging-*` 残留；插件可能在也可能不在 | 下次启动 scan 时若 extensions 无该 id ⇒ 回落 bundle；若有半成品 ⇒ 以清单校验兜底 | 下次启动自动可用；`.failed`/`.staging` 由下次安装清理 |

原则：**任何失败路径都不允许「插件彻底消失」** —— 最坏情况是回落到 App 自带的出厂版本。

---

## 8. 测试计划

| 层 | 用例 |
|---|---|
| Rust 单测（M1） | §4.1 的四条（覆盖生效 / essential 被忽略 / 坏清单回落 / essential 防伪） |
| Rust 单测（M2） | 首次安装与覆盖安装行为不变；覆盖保留 `plugin-settings` / `overrides`；mock load 失败 → 断言目录回滚、旧版本仍可加载；`.backup` 只留 1 份；覆盖目标为 essential ⇒ `ESSENTIAL_PROTECTED` |
| Rust 单测（M3） | 无覆盖 ⇒ 提示；有覆盖 ⇒ 删除后回落 bundle；`.backup` 一并清理 |
| 契约测试（TS） | `installZip` + `overwrite:true` ⇒ 收到 `plugin/reloaded`、`/api/plugins` 版本变化；`revertToBuiltin` 后版本回落 |
| 冒烟（真内核） | 假 registry（本地 http 服务 / `file://`）+ 两个版本的 demo 插件：check → download → installZip → 版本生效 → revertToBuiltin |
| `internal-store` 单测 | 修复版本比较 / 索引解析 / sha256 校验（fixture 向量）/ 未知 schema 拒绝 / essential 过滤 |
| 实机（macOS + Windows） | 真 GitHub Release 走一遍完整链路；Windows 专项：插件进程被杀后 rename 重试、更新正在使用的插件、更新 `internal-store` 自身 |
| 回归门 | `cargo test --workspace && pnpm typecheck && pnpm test && pnpm build && pnpm spec-check`（既有矩阵，全绿） |

---

## 9. 落地顺序与工作量

| 批次 | 内容 | 前置 | AI 实现 | 人工实现 |
|---|---|---|---|---|
| P1 | 内核 M1 + M2 + M3（含单测；不改协议） | 无 | 3–4 h | 1–1.5 周 |
| P2 | 分发链路：zip 命名 + `gen-plugin-registry.mjs` + `plugins-release.yml` + 真发一版 | P1 无依赖，可并行 | 1–2 h | 2–3 天 |
| P3 | `internal-store`（命令 + view + 设置页入口） | P1（installZip 原子化） | 3–5 h | 1–1.5 周 |
| P4 | （可选）签名、自动检查、商店页、国内通道 | P3 | 2–3 h | 1 周 |
| 合计 | | | **7–11 h（不含 P4）** | **2.5–3.5 周** |

里程碑卡点（每个可独立验收）：

1. **M7.1 内核可覆盖**：手工把新版本 zip 装进 extensions → 重启内核即生效；essential 覆盖被拒。（P1）
2. **M7.2 通道可发**：GitHub 固定 tag 上出现 registry.json + `<id>-<ver>.zip`，sha256 正确。（P2）
3. **M7.3 一键更新**：在 `internal-store` 页点更新 → 不重启 App → 新版本生效；断网/坏包/失败回滚各走一遍。（P3）

---

## 10. 实施时必须先改的文档（spec-first）

以下改动**在实施 P1 之前**完成（本文件只是规划，不构成契约）：

| 文档 | 改动 |
|---|---|
| `docs/plugin-spec.md` | §2.3 命名改为 `<id>-<version>.zip`；§6 生命周期补「更新」语义（disable(Reload) → 替换 → reload）；新增附录「更新源（registry.json）格式」，声明 schema 稳定性与 `sig` 预留 |
| `docs/launcher-requirements.md` | §9 供应链补「插件更新」条目（来源固定 / sha256 / essential 保护 / 回滚）；§13 里程碑新增 M7 |
| `docs/decisions/ADR-0006-plugin-remote-update.md`（新） | 记录：内核不联网 ⇒ 下载在插件；安装由 view 发起（自更新可行性）；essential 不参与；不拆仓库的决策与理由；多源与签名的关系（§3.6） |
| 规则 `.codebuddy/rules/chassis-core.md` | 补「extensions 可覆盖非 essential 出厂插件」这条**例外**（否则后人不知道这是有意为之）与 essential 身份表的判定点 |
| `README.md`（开源后） | 补「插件更新」说明段（更新源、信任模型、如何发版） |

---

## 11. 拍板结果（2026-09-18）

| # | 问题 | 结论 |
|---|---|---|
| 1 | `internal-store` 形态 | **独立插件**（职责单一、商店页有成长空间） |
| 2 | 签名是否进 v1 | **不进**：v1 只走 GitHub 官方源，信任模型 = 固定仓库 + HTTPS + sha256 |
| 3 | 固定 tag 名 | `plugins-latest` |
| 4 | 自动检查 | 接受「打开页面即检查 + 手动按钮」，不做后台轮询 |
| 5 | 更新范围 | 仅「已装的非 essential 出厂插件」，第三方插件不参与 |
| 6 | `minKernel` 来源 | 发布时 workflow 人工输入（`--min-kernel`），不新增清单字段 |
| 7 | 国内通道（§3.6） | v1 不做（多源与签名一起后置） |
| 8 | App 包分发同策 | 待定（App 分发仍走 `release.yml` 的 GitHub Release） |
| 9 | 仓库地址 | 先用占位 `triple3h/Chassis`（`plugins/internal-store/src/lib.rs` 的 `REGISTRY_URL` 一处常量 + CI 的 `--repo`） |

---

## 12. 实现状态（2026-09-18）

| 批次 | 内容 | 落点 |
|---|---|---|
| P1 内核 | 出厂身份表 + extensions 覆盖非 essential；原子安装（备份 / 回滚 / `UPDATE_FAILED` / `ESSENTIAL_PROTECTED`）；`revertToBuiltin` | `apps/kernel/src/plugin/manager.rs`（含 8 条新单测）、`plugin/admin.rs` |
| P2 分发 | zip 命名 `<id>-<version>-<platform>-<arch>.zip` + 分片；`gen-plugin-registry.mjs`；`plugins-release.yml`（macOS / Windows 双平台原生构建 → 汇总 → 发固定 tag） | `scripts/pack-plugins.mjs`、`scripts/gen-plugin-registry.mjs`、`.github/workflows/plugins-release.yml` |
| P3 更新器 | `internal-store`（`updates` view + `update` script），索引解析 / semver / 平台挑选 / sha256 全部在 `lib.rs` 可单测 | `plugins/internal-store/`（8 条 Rust 单测） |

**与原方案的偏差（有意为之）**：

1. **索引按平台分产物**（`assets[]`，不是扁平的 `url`）：逻辑层是 Rust 可执行产物，一份 zip 不可能跨平台；分片由各平台 runner 产出、汇总 job 合并。
2. **check 的「已装插件」由 view 传进来**（`args.installed`）：逻辑层不调 `ctx.settings`，少一次往返也让「只更新已装非 essential 出厂插件」的过滤发生在能拿到 `essential` 标记的地方。
3. **UI 加了「恢复出厂版本」区**：M3 的 `revertToBuiltin` 不能只存在于 API 里，否则用户没有入口。

**未完成（需实机 / 仓库就绪）**：真 GitHub Release 走一遍完整链路（M7.2 / M7.3 验收）、Windows 上的 rename 重试与「更新正在使用的插件」、自动检查与商店页（v2）。
