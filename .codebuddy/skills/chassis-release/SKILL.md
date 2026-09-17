---
name: chassis-release
description: 打包自用版应用、换图标、换包安装、应用改名时使用。触发场景：打包、出个新包、重新打包、发布、app:local、换图标、图标不好看、更新 .app、安装新版本、Chassis.app 打不开。关键词：打包、发布、icon、icns、tray、ad-hoc 签名、换包、dist-app。
allowed-tools:
disable: false
---

# 打包自用版（dist-app/Chassis.app）

本项目**当前自用分发**：macOS 不走 tauri-cli / 不公证 / 不打 dmg，产物 `dist-app/Chassis.app` 拖进 /Applications 即可用。
**M5 已落地**：内核与逻辑层插件都是随包内置的 Rust 二进制（运行时**零 Node**）；**规划中（M6，见 `docs/m5-rust-and-windows.md`）**：GitHub Actions 双平台构建（`macos-latest` + `windows-latest`）与 GitHub Releases 分发；仓库届时公开（MIT）⇒ Actions 免费无额度限制，且**不要**在 CI 里跑 `make-icon.mjs`（依赖 `rsvg-convert`/`iconutil`，图标产物一律入库）。
装配细节在 `scripts/pack-local-app.mjs`；数据目录与迁移见规则 `chassis-core`。

## 全量打包

```bash
pnpm app:local                # build-all → 组装资源 → cargo build --release → 组装 .app → ad-hoc 签名
pnpm app:local --skip-build   # 前端产物没变时：跳过前端构建，只重编 Rust / 重新组装
```

首次 cargo release 约 5–15 分钟。脚本依次做：

1. `build-all.mjs` 构建 kernel / ui / 插件（`--skip-build` 时跳过）；
2. 收集 `apps/shell/resources/{kernel,ui,builtin-plugins}`；
3. `cargo build --release`（产物 `apps/shell/target/release/launcher-shell`）；
4. 组装 `.app`（Info.plist + `MacOS/` + `Resources/`）；
5. `codesign --force --deep --sign -`（**ad-hoc 必需**：Apple Silicon 上未签名会被系统直接杀掉）；
6. 清 quarantine + `lsregister -f` 刷新 LaunchServices（换图标后不刷新，Dock / Finder 会一直显示旧图标）。

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

## 打包后验证

- `codesign --verify --verbose=1 dist-app/Chassis.app`（ad-hoc 会有告警，正常）。
- 双击启动：托盘图标出现 → 热键唤出窗口 → 搜一个应用能启动。
- 改过插件：确认插件随包（`Contents/Resources/builtin-plugins/`）；需要单独分发的插件走 `pnpm pack:plugins`（zip → `plugins/release/`）。

## 环境依赖

- `.app` **运行时零 Node**：内核与逻辑层插件都是随包内置的二进制（`Contents/Resources/kernel/launcher-kernel` + 各插件的 `dist/<命令名>`）；Node 只在**开发期**需要（pnpm / Vite 工具链）。未签名会被 macOS 杀掉 ⇒ 必须 ad-hoc（脚本已做）。
- 缺 rsvg-convert 时 `pnpm icon` 会明确报错（`brew install librsvg`）。
