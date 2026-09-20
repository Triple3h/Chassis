---
name: chassis-release
description: 打包自用版应用、发版（App / 应用自更新 / 内核 / 插件四条通道）、换图标、换包安装、应用改名时使用。触发场景：打包、出个新包、重新打包、发布、单独发内核、单独发插件、发个应用更新、自动更新、app:local、换图标、图标不好看、更新 .app、安装新版本、Chassis.app 打不开、权限老是重弹。关键词：打包、发布、发版、app-latest、app-release、kernel-latest、plugins-latest、plugins-release、kernel-release、gh workflow run、icon、icns、tray、代码签名、签名证书、MACOS_SIGN_P12、ad-hoc 签名、TCC 授权、换包、dist-app。
allowed-tools:
disable: false
---

# 打包自用版（dist-app/Chassis.app）

本项目**当前自用分发**：macOS 不走 tauri-cli / 不公证 / 不打 dmg，产物 `dist-app/Chassis.app` 拖进 /Applications 即可用。
**已落地**：内核与逻辑层插件都是随包内置的 Rust 二进制（运行时**零 Node**）；仓库已公开（MIT）+ GitHub Actions 双平台构建 + Releases 分发。**不要**在 CI 里跑 `make-icon.mjs`（依赖 `rsvg-convert`/`iconutil`，图标产物一律入库）。
装配细节在 `scripts/pack-local-app.mjs`；发布通道见文末「发布通道」；数据目录与迁移见规则 `chassis-core`。

## 全量打包

```bash
pnpm app:local                # build-all → 组装资源 → cargo build --release → 组装 .app → 签名（固定证书优先，回落 ad-hoc）
pnpm app:local --skip-build   # 前端产物没变时：跳过前端构建，只重编 Rust / 重新组装
```

首次 release 编译较久（壳 + 内核 + 5 个插件 crate 全量编译；后续增量快）。脚本依次做：

1. `build-all.mjs` 构建 kernel / ui / 插件（`--skip-build` 时跳过）；
2. 收集 `apps/shell/resources/{kernel,ui,builtin-plugins}`；
3. `cargo build --release`（产物 `apps/shell/target/release/launcher-shell`）；
4. 组装 `.app`（Info.plist + `MacOS/` + `Resources/`）；
5. 签名（必须：Apple Silicon 上未签名会被系统直接杀掉）—— 优先用本机自签名证书（`security find-identity -p codesigning` 里找 `Chassis Local Signing`，也可用 `LAUNCHER_SIGN_IDENTITY` 指定别的），找不到则回落 `codesign --force --deep --sign -`（ad-hoc）；
6. 清 quarantine + `lsregister -f` 刷新 LaunchServices（换图标后不刷新，Dock / Finder 会一直显示旧图标）。

## 签名证书（一次性，TCC 授权稳定的前提）

ad-hoc 签名的身份 = 二进制哈希，每次重新打包都变 ⇒ 「辅助功能 / 屏幕录制 / 通知 / 自动化」这类 TCC 授权会被系统当成新应用，**换包后又弹**（典型症状：系统设置里明明勾着，实际不生效 —— TCC 日志里是 `Failed to match existing code requirement`）。建一次固定证书即可根治：

```bash
node scripts/make-signing-cert.mjs          # 幂等：已有则跳过；--force 重建（等于换身份，授权要重给一次）
```

- 做三件事：生成自签名证书（10 年、codeSigning 扩展，走配置文件写法 —— 系统自带 openssl 是 LibreSSL，不认 `-addext`）→ **分开导入**证书与私钥到登录钥匙串（`-T /usr/bin/codesign` 预授权；**别用 p12**：LibreSSL 导出的 p12 在 macOS 上必然报 `MAC verification failed`，空密码 / 3DES / AES 都不行）→ `security add-trusted-cert -p codeSign` 设为信任根（**这一步弹系统授权框**，输密码 / Touch ID）。
- 签名后 DR 形如 `identifier "app.launcher.desktop" and certificate root = H"…"` ⇒ **不含 cdhash**，重新打包不再失配。
- 从 ad-hoc 切到证书（或 `--force` 重建）之后：去 系统设置 → 隐私与安全性 把**旧条目删掉**、重新授权一次；之后换包不再弹。
- CI（M6）不建证书：公开仓库继续「零 secrets」，CI 产物回落 ad-hoc（只影响下载者本机的授权体验）。

## 换图标

```bash
# 1. 设计改动在 scripts/make-icon.mjs 顶部（PALETTE / MARK / MAGNIFIER），或直接改矢量源
pnpm icon        # 需 rsvg-convert（brew install librsvg）→ icon.png / icon.icns / tray.png
pnpm app:local   # 2. 重新打包（tray.png 走 include_bytes! ⇒ 换图标必须重编壳）
```

- 应用图标与菜单栏图标是**两个字形**（输入框 / 放大镜）：18pt 下输入框内里会糊，菜单栏刻意用放大镜。
- 只改 `apps/shell/icons/*.svg` 不重编壳 = 图标不生效。

## 应用名与数据目录

- 应用显示名 = `scripts/pack-local-app.mjs` 顶部 `APP_NAME`（一处改全跟：产物名、Info.plist、壳窗口标题）。
- 数据目录 `~/Library/Application Support/Chassis`（名字在壳 `sidecar.rs::APP_DATA_DIR_NAME`）；老目录 `Launcher/` 由壳启动时**一次性复制接手**，换包不用手动拷数据。
- **刻意不动**：`CFBundleIdentifier`（`app.launcher.desktop`，牵 TCC 授权与 single-instance 互斥判定）、crate 名 `launcher-shell`、环境变量 `LAUNCHER_*`、workspace 包名。

## 换包（安装新版本）

1. **先退出旧实例**：同 bundle id 下旧实例不退时双击新包会被互斥接管（表现为「打不开」）。
2. 拖 `dist-app/Chassis.app` 进 /Applications 覆盖旧的。
3. 首次运行按提示授权「辅助功能 / 通知」；数据在数据目录原地保留。
4. 遇到「明明授权过、换包后又弹」：系统设置 → 隐私与安全性 → 对应分类里**删掉旧条目**再重新授权 —— 旧条目对应旧签名身份，勾着也不生效（换过证书 / 用过 ad-hoc 时必然碰到一次）。

## 打包后验证

- `codesign --verify --verbose=1 dist-app/Chassis.app`；再看身份对不对：`codesign -dv --verbose=4 dist-app/Chassis.app | grep -E "Authority|Signature"`（应为 `Authority=Chassis Local Signing`，不能是 `Signature=adhoc`）。
- 关键一条：`codesign -d -r- dist-app/Chassis.app` 的 DR 里**不应出现 cdhash**（含 cdhash ⇒ 换包必失效，说明回落到了 ad-hoc）。
- 双击启动：托盘图标出现 → 热键唤出窗口 → 搜一个应用能启动。
- **零 Node 物证**：`find dist-app/Chassis.app/Contents/Resources -name '*.mjs'` 应为空；`Resources/kernel/launcher-kernel` 与各逻辑层插件的 `dist/<命令名>` 都是可执行文件（Rust 产物，0755）。
- 改过插件：确认插件随包（`Contents/Resources/builtin-plugins/`）；需要单独分发的插件走 `pnpm pack:plugins`（zip → `plugins/release/`）。
- 逻辑层改动的实机验证**必须重打包**（`pnpm app:local --skip-build` 也会重编 Rust 并重新组装）；只跑 `pnpm build` 只更新开发产物与 `dist/`，`.app` 里还是旧的。

## 环境依赖

- `.app` **运行时零 Node**：内核与逻辑层插件都是随包内置的二进制（`Contents/Resources/kernel/launcher-kernel` + 各插件的 `dist/<命令名>`）；Node 只在**开发期**需要（pnpm / Vite 工具链）。未签名会被 macOS 杀掉 ⇒ 必须签名（固定证书优先，脚本已做）。
- 缺 rsvg-convert 时 `pnpm icon` 会明确报错（`brew install librsvg`）。

## 发布通道（App / 应用自更新 / 内核 / 插件，四条独立）

互不干扰：App `v*`、应用自更新 `app-latest`、内核 `kernel-latest`、插件 `plugins-latest`（客户端走 `releases/download/<tag>/…` 直链，不调 GitHub API）。**CI 不监控 main**（`verify.yml` 的 push 忽略 main），发版一律显式触发；`workflow_dispatch` 取**默认分支代码** ⇒ 先合并 main 再触发。

**版本只改一处**：根 `version.json`（`app` = 应用/壳、`kernel` = 内核）——

```bash
pnpm version:set app 0.1.4      # 同步 tauri.conf.json + shell/Cargo.toml
pnpm version:set kernel 0.1.4   # 同步 kernel/Cargo.toml（整包发布时一般同号）
pnpm version:check              # 校验三处位点一致（发版 workflow 里也会跑）
```

**别手改** `tauri.conf.json` / `Cargo.toml` 里的 version 字段（漂移 ⇒ 客户端判不出新版本，自更新静默失效）；
机制版本（`SHELL_HOT_VERSION` / `HOT_UPDATE_VERSION`）与插件版本**不在**清单里，各自独立演进。

| 只发什么 | 怎么做 | 客户端怎么拿到 |
|---|---|---|
| App（壳）手动换包 | `git tag v0.2.0 && git push origin v0.2.0` → `release.yml` | 用户手动换包（新机器 / 关掉自动检查时用） |
| App（壳）自更新 | `pnpm version:set app 0.1.4` → `gh workflow run app-release.yml --ref main -f notes="…"`（或推 tag `app/*`） | **检查并提示**：内核守护（启动 90s 后 / 每 6h）只检查；托盘第一项**常驻**（无新版「检查更新…」/ 有新版带版本号）**点击打开更新页**（托盘自己不执行更新），「关于」页有同一份提示 → 用户在更新页 / 关于页确认后下载、替换、整体重启。**macOS 与 Windows 都能自动安装**（macOS 换 `.app`、Windows 换绿色版目录，helper 在进程退出后执行） |
| 内核 | `pnpm version:set kernel 0.1.4` → `gh workflow run kernel-release.yml --ref main -f notes="…" [-f min_hot_version=…]`（或推 tag `kernel/*`） | 更新页「内核」区 → 更新内核（热替换 + 优雅重启内核，不动 App） |
| 插件 | bump 插件 `package.json` 版本 → `gh workflow run plugins-release.yml --ref main [-f plugins="<id>"]`（或推 tag `plugins/*`） | 更新页插件列表 → 更新（热重载，不动 App） |

四条硬规矩：

- **发布即对所有装机客户端可见**（更新源是编译期常量，无灰度通道）；门闩只有 `minHotVersion`（内核包 × 客户端机制版本）、`minShellHotVersion`（应用包 × 壳自更新机制）与 `minKernel`（插件 × 当前内核）。
- **应用自更新必须同一签名身份**：`app-release.yml` 从 secrets `MACOS_SIGN_P12` / `MACOS_SIGN_P12_PASSWORD` 导入本机固定证书（`node scripts/export-signing-cert.mjs` 一次性导出）；没配就回落 ad-hoc —— 包照发，但**每次更新后用户都要重新授权 TCC**（辅助功能 / 屏幕录制），日志里有 warning。
- **插件索引必须整份**：单独发某些插件时工作流先取回上一版 `registry.json` 再合并（`--merge-registry`），取不到索引直接红 —— 不发残缺索引。本地手工重放同理，否则其余插件会从索引里消失、客户端静默不再提示更新（守 `tests/unit/plugin-registry-merge.test.ts`）。
- **App 升级重置内核**：包内内核会被重投到 `<dataRoot>/kernel/`（台账 `sourceAppVersion`），内核热更新只是两次 App 发版之间的「领先」；同版本号重打包不会重投，本地想立刻生效要删 `<dataRoot>/kernel/`。

发版后自查：`gh release view kernel-latest` / `gh release view plugins-latest`（看资产 + `*-registry.json`）；客户端最真实的验证是打开「更新」页点一次检查更新。
