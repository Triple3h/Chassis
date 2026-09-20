# 应用（壳）自更新 · 集成说明（v0.1.0）

> 状态：**已实现**（2026-09-19）｜机制版本 **0.1.0**（`SHELL_HOT_VERSION`，随索引发布）
> 相关：`docs/kernel-hot-update.md`（内核通道，与本通道同构）｜`docs/permissions.md`（签名与 TCC）

壳（`Chassis.app`）是**唯一不能由内核替换的一层** —— 它就是应用本体。这条通道让它在
GitHub Action 发版后**自动检查并提示新版本**（托盘常驻「检查更新…」入口 +「关于」页更新卡片）；
下载 / 替换 / 重启只在用户确认后发生（**更新绝不自动执行**）。

---

## 1. 通道与产物

第四个独立通道（与另外三条互不顶替）：

| 通道 | tag | 产物 | 谁在用 |
|---|---|---|---|
| App 换包（给人） | `v*` | `Chassis-macos-arm64.zip` | 新机器安装 / 手动换包 |
| 插件 | `plugins-latest` | `registry.json` + 插件 zip | 「更新」页 → 插件 |
| 内核 | `kernel-latest` | `kernel-registry.json` + 内核 zip | 「更新」页 → 内核 |
| **应用（壳）** | **`app-latest`** | **`app-registry.json` + `Chassis-<版本>-macos-<架构>.zip`** | **自动检查 → 托盘「检查更新…」/「关于」页提示 → 「更新」页 → 应用** |

> 三条固定 tag 通道（`app-latest` / `kernel-latest` / `plugins-latest`）发布时会**只保留索引指向的资产**：
> 工作流在 `action-gh-release` 之后跑 `scripts/prune-release-assets.mjs`，清掉同名覆盖没带走的旧 `.zip`
> （不清理会无限积累孤儿；单 Release 上限 1000 个资产，攒满 = 发布中断）。

索引（schema 1）与内核那份同形：

```json
{
  "schema": 1,
  "app": {
    "version": "0.1.1",
    "shellHotVersion": "0.1.0",
    "minShellHotVersion": "0.1.0",
    "notes": "…",
    "assets": [
      { "platforms": ["macos"], "arch": ["arm64"], "url": "…", "sha256": "…", "bytes": 123 },
      { "platforms": ["windows"], "arch": ["x64"], "url": "…", "sha256": "…", "bytes": 456 }
    ]
  }
}
```

- 更新包（两种形态，由 `pack-app.mjs` 按平台产出）：
  - macOS：完整 `.app` 的 zip（解压结构 `Chassis.app/Contents/…`），`ditto --keepParent` 打的，保留 unix 权限位；
  - Windows：绿色版目录的 zip（解压结构 = `Chassis.exe` + `resources/`，与 `pnpm app:win` 同源，
    由 `pack-win.mjs` 打的）。

**两种安装形态（其余机制完全共用）**：

| 形态 | 安装位置 | 候选包结构 | helper | 替换动作 |
|---|---|---|---|---|
| macOS | `X.app`（`/Applications/Chassis.app`） | `Contents/MacOS/launcher-shell` + `Info.plist` | `swap.sh`（`/bin/sh`） | 同卷 rename 整个 bundle |
| Windows | 绿色版目录（`Chassis.exe` + `resources/`） | 同左（zip 根就是该目录） | `swap.ps1`（PowerShell 5.1，脚本带 BOM） | 同卷 rename 整个目录 |

两端的共同硬前提：**替换必须发生在进程完全退出之后**（Windows 连运行中的 exe 与它所在目录都锁）。

## 2. 全自动链路

```
app-release.yml（CI 双平台：macos = build-all → pack-local-app（**签名**）→ pack-app；windows = pack-win → pack-app --platform windows → 发 app-latest）
        ▼
内核守护（启动 90s 后 + 每 6h）：问壳版本 → exec.run('internal-store', update, check-app)
        ▼ 有新版
   download-app（下载 → sha256 → 解压 → 结构校验）
        ▼ 等窗口收起（最多 120s，给「正在输入」让路）
   applyShellUpdate → shell.applyUpdate（原语）
        ▼
壳：候选包自检（--hot-probe）→ 写台账 pending.json → 生成 helper → 退出（连带停掉内核）
        ▼
helper（脱离壳进程树：macOS /bin/sh、Windows PowerShell）：等壳退出 → 备份旧安装 → 落新包 → 重新启动
        ▼
新壳启动：boot_guard 记 attempts → 走到「内核就绪」⇒ mark_boot_success
        ▼ 连续两次没走到就绪
   boot_guard 交 helper restore：备份换回 → 重新 open（下次启动即回到旧版本）
```

## 3. 分工（谁做什么，不越界）

| 环节 | 归谁 | 落点 |
|---|---|---|
| 检查 / 下载 / 解压 | 内核 → `internal-store` 的 `update` 命令（同一套代理降级 / 域名白名单 / sha256） | `plugins/internal-store/src/bin/update.rs`（`check-app` / `download-app`） |
| 检查与提示 | 内核守护（`spawn_app_update_check`）：启动 90s 后 / 每 6h **只检查**；托盘菜单第一项（`tray_items`）**常驻** —— 无新版是「检查更新…」、有新版带版本号，点击一律**打开更新页**（`handle_tray_menu("app-update")`，托盘自己不执行更新）；「关于」页另有更新卡片 | `apps/kernel/src/kernel.rs` |
| 候选包校验 / 台账 / 替换 / 重启 | 壳（**用户确认后**才走到这里） | `apps/shell/src/update.rs` |
| 界面（提示 + 手动更新） | 「关于」页更新卡片（`checkAppUpdate` / `applyAppUpdate`）与更新页「应用」区块 | `plugins/internal-settings/src/view/main.ts`、`plugins/internal-store/src/App.vue` |

自动检查可在 `config.json` 用 `autoUpdateCheck: false` 关掉（≤0.1.3 的旧键 `autoUpdateApp` 兼容）；
关掉后仍可在「关于」页 / 更新页手动检查。**更新（下载 / 替换 / 重启）只在用户确认后执行。**

## 4. 三重保险（失败不会让应用消失）

1. **候选包自检**（壳，`--hot-probe`）：结构 → `Info.plist` 版本与二进制自报版本**一致** → 自检能跑通；
   任一不过直接拒绝，当前安装一动不动。
2. **helper 的 8 秒窗口**：`open` 之后 8 秒内没看到新实例 ⇒ 判定坏包，**自动把备份换回来**。
3. **启动守卫**（`boot_guard`）：新版本启动时台账 attempts+1，连续两次没走到「内核就绪」⇒ 交 helper
   换回备份并重启；走到就绪则清台账。台账带**版本校验**（对不上即视为过期台账丢弃），且**只在打包态生效**
   （开发态与 `/Applications` 那份共用数据目录，dev 跑一遍绝不能去回滚生产安装）。

任何一步失败都停在「当前版本 + 台账清理」的状态，不需要人工修。

## 5. 签名是硬前提

macOS 的 TCC 授权（辅助功能 / 屏幕录制 / 自动化 / 通知）**按代码签名身份记账**。
CI 默认的 ad-hoc 签名身份 = 二进制哈希，每次构建都变 ⇒ 每次自更新后授权全部失配重弹。
所以：

```bash
# 一次性：把本机固定证书导出成 p12（写到系统临时目录，别放进仓库）
node scripts/export-signing-cert.mjs
# 配到仓库 secrets（app-release.yml 会用它签名）
gh secret set MACOS_SIGN_P12 < <导出的>.base64
gh secret set MACOS_SIGN_P12_PASSWORD --body '<导出时的密码>'
```

没配 secrets 时工作流回落 ad-hoc 并在日志里打 warning（包照发，但用户每次更新都要重新授权）。
`pack-app.mjs` 会把实际签名身份打印出来 —— CI 日志里应看到 `Authority=Chassis Local Signing`。

## 6. 数据布局

```
<dataRoot>/hot/shell/
├── pending.json    # 待验证台账（from/to/target/backup/attempts）
├── swap.sh         # macOS helper（由壳生成，唯一能在壳退出后动手的角色）
├── swap.ps1        # Windows helper（同上；脚本带 UTF-8 BOM，PS 5.1 才按 UTF-8 读）
└── swap.log        # 每次替换 / 回滚一行（排障入口）
```

备份落在安装位置旁边（失败时被换回来）：macOS `/Applications/Chassis.app.chassis-backup`、
Windows `<安装目录>.chassis-backup`（与安装目录同卷 ⇒ rename 即完成备份）。

## 7. 发版

版本只改**一处**：根 `version.json`（`app` = 应用/壳版本，`kernel` = 内核版本），
由 `scripts/version.mjs` 同步到三个位点（`tauri.conf.json`、`shell/Cargo.toml`、`kernel/Cargo.toml`），
`pnpm version:check`（本地与全部发版 workflow）拦漂移 —— 手改位点文件的后果是自更新**静默失效**。

```bash
pnpm version:set app 0.1.5      # 改版本（自动同步三处位点；内核同号时再 version:set kernel 0.1.5）
gh workflow run app-release.yml --ref main -f notes="…"     # 或推 app/* tag
```

客户端会在下一次守护轮次（启动 90s 后 / 每 6h）**检查**，新版本在托盘菜单（「检查更新…」→
「发现新版本 vX.Y.Z · 打开更新页…」）与「关于」页提示；下载 / 替换 / 重启只在用户在**更新页**或
「关于」页确认后发生（托盘只负责把用户送到更新页）。

> 管理面两个页面（`internal-store` 的更新页、`internal-settings` 的设置 / 插件管理）在清单里声明
> `hidden`：首页与搜索都不出现它们，固定入口是托盘（「检查更新…」「设置…」「插件管理…」）/ 搜索栏齿轮 / `⌘,`。

机制版本（`SHELL_HOT_VERSION` / `HOT_UPDATE_VERSION`）与插件版本**不在** `version.json` 里，各自独立演进。

## 8. 有意不做

- **自动应用更新**：更新只**检查 + 提示**（托盘常驻入口 / 「关于」页），下载 / 替换 / 重启一律等用户确认 ——
  不做静默下载与无人值守替换（更新时机由用户自己决定）。
- **Windows 的安装器（NSIS / MSIX）**：绿色版 + `swap.ps1` 已经够用（自用场景）；
  要装到 `Program Files` 得另立安装器通道（未做；Windows 的边界与不变量见 `docs/architecture.md` §11）。
- **Windows 的 Authenticode 签名**：替换不涉及签名身份（不像 macOS 的 TCC 按签名记账），暂不接。
- **增量包 / dmg / 公证**：整包替换足够（17 MB 级），公证与分发面的事随 `v*` 通道另议。
- **多版本回退历史**：只留 1 份备份（与内核 / 插件热更新同口径）。
- **壳内网络栈**：检查 / 下载仍在插件侧（`internal-store`），壳只做「校验 + 替换 + 重启」——
  壳要在内核起不来时也能更新自己，所以这条链路不依赖内核，但也不重复造一套网络代码。
