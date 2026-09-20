#!/usr/bin/env node
/**
 * 自用打包（不走 tauri-cli / 不公证 / 不打 dmg）：
 *   1. cargo build --release
 *   2. 手工组装 <APP_NAME>.app（Info.plist + MacOS/ + Resources/）
 *   3. ad-hoc 签名（Apple Silicon 上未签名会被内核杀掉）
 *
 * 产出：dist-app/<APP_NAME>.app —— 拖进 /Applications 即可双击运行。
 *
 * 用法：node scripts/pack-local-app.mjs [--skip-build]
 *   --skip-build  跳过前端产物构建（只重编 Rust / 重新组装）
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { assembleResources } from './lib/resources.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = path.join(repoRoot, 'apps', 'shell')

/**
 * 应用名 = 项目名（改这一处即可）。
 *
 * 刻意**不动** `CFBundleIdentifier`（仍是 `app.launcher.desktop`）：
 * 它牵着两件事 —— macOS 的 TCC 授权（辅助功能 / 通知按 bundle id 记账，改了就得重新授权）
 * 与 `tauri-plugin-single-instance` 的互斥判定（同 id 才认作「同一个应用」）。
 *
 * 数据目录跟着应用名走（`~/Library/Application Support/Chassis`，名字在壳的 `sidecar.rs::APP_DATA_DIR_NAME`）：
 * 老目录 `Launcher/` 由壳启动时**一次性接手（只复制不移动，老目录留着回退）**，换包即可，不用手动拷。
 */
const APP_NAME = 'Chassis'
const outApp = path.join(repoRoot, 'dist-app', `${APP_NAME}.app`)

/**
 * 壳版本从 `apps/shell/tauri.conf.json` 的 `version` 读 —— 它的**唯一维护点是根 `version.json`**
 * （`pnpm version:set app <x.y.z>` / `scripts/version.mjs sync` 写入，`version:check` 拦漂移）。
 * 这个值同时是 `build.rs` 注入 `SHELL_VERSION`（`--hot-probe` 自报）与 `pack-app.mjs` 校验的来源 ——
 * 分叉的后果是「客户端永远判不出新版本」或「更新到一个版本号对不上的包」。
 */
const shellVersion = readShellVersion()

const skipBuild = process.argv.includes('--skip-build')

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd })
}

function line(text) {
  process.stdout.write(`${text}\n`)
}

// 1) 前端产物
if (!skipBuild) {
  line('▶ 构建 kernel / ui / plugins')
  run(process.execPath, [path.join(repoRoot, 'scripts', 'build-all.mjs')])
}
const { pluginCount } = assembleResources(repoRoot)
line(`✓ 资源就位（内置插件 ${pluginCount} 个）`)

// 2) Rust release 编译
line('▶ cargo build --release（首次约 5–15 分钟）')
run('cargo', ['build', '--release', '--manifest-path', path.join(shellDir, 'Cargo.toml')])

const binary = path.join(shellDir, 'target', 'release', 'launcher-shell')
if (!fs.existsSync(binary)) {
  line(`✗ 找不到可执行文件：${binary}`)
  process.exit(1)
}

// 3) 组装 .app
const contents = path.join(outApp, 'Contents')
const macos = path.join(contents, 'MacOS')
const resourcesDst = path.join(contents, 'Resources')
fs.rmSync(outApp, { recursive: true, force: true })
fs.mkdirSync(macos, { recursive: true })
fs.mkdirSync(resourcesDst, { recursive: true })

fs.copyFileSync(binary, path.join(macos, 'launcher-shell'))
fs.chmodSync(path.join(macos, 'launcher-shell'), 0o755)

const iconSrc = path.join(shellDir, 'icons', 'icon.icns')
if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(resourcesDst, 'icon.icns'))
const pngSrc = path.join(shellDir, 'icons', 'icon.png')
if (fs.existsSync(pngSrc)) fs.copyFileSync(pngSrc, path.join(resourcesDst, 'icon.png'))

for (const name of ['kernel', 'ui', 'builtin-plugins']) {
  const from = path.join(shellDir, 'resources', name)
  if (fs.existsSync(from)) fs.cpSync(from, path.join(resourcesDst, name), { recursive: true })
}

fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist())
fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????')

// 4) 签名：优先用固定证书（TCC 授权可跨重新打包保留），没有则回落 ad-hoc
//    签名是必需的：Apple Silicon 上未签名会被内核直接杀掉。
//    ad-hoc 的身份 = 二进制哈希，每次打包都变 ⇒ 辅助功能 / 屏幕录制等 TCC 授权会失效重弹；
//    建一次固定证书即可：node scripts/make-signing-cert.mjs
//    可用 LAUNCHER_SIGN_IDENTITY 指定别的证书（CI / 换机器）。
const identity = process.env.LAUNCHER_SIGN_IDENTITY || detectSigningIdentity()
if (identity) {
  line(`▶ codesign --force --deep --sign "${identity}"`)
  run('codesign', ['--force', '--deep', '--sign', identity, outApp])
} else {
  line('▶ codesign --force --deep --sign -（ad-hoc）')
  line('  ⚠️ 没找到固定签名证书：ad-hoc 身份每次打包都变，TCC 授权（辅助功能等）会失效重弹')
  line('     建一次即可：node scripts/make-signing-cert.mjs')
  run('codesign', ['--force', '--deep', '--sign', '-', outApp])
}
try {
  run('codesign', ['--verify', '--verbose=1', outApp])
} catch {
  line('· 签名校验有告警（自签名证书的常见现象，能正常启动就行）')
}

// 5) 解除 quarantine（本地构建通常没有该属性，稳妥起见）
try {
  execFileSync('xattr', ['-dr', 'com.apple.quarantine', outApp], { stdio: 'ignore' })
} catch {
  /* 没有 quarantine 属性时会失败，忽略 */
}

// 6) 刷新 LaunchServices 缓存：换图标后不刷新的话 Dock/Finder 会一直显示旧图标
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', outApp],
    { stdio: 'ignore' },
  )
} catch {
  /* 非关键步骤 */
}

line('')
line(`✓ 打包完成：${path.relative(repoRoot, outApp)}（v${shellVersion}）`)
line(`  安装：把 ${APP_NAME}.app 拖进 /Applications，双击运行`)
line('  权限（都按需弹，不用到就不会问）：辅助功能=读选中文本；屏幕录制=截图；')
line('  自动化（"想控制此 Mac"）=只在 host-manager 写 hosts 时提权；通知=操作提示')
line('  出可自更新的通道包：node scripts/pack-app.mjs（压 zip + 写分片，CI 汇总成 app-registry.json）')

/** 壳版本（唯一源：tauri.conf.json） */
function readShellVersion() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(shellDir, 'tauri.conf.json'), 'utf8'))
    if (!conf.version) throw new Error('缺少 version 字段')
    return conf.version
  } catch (err) {
    line(`✗ 读不到壳版本（apps/shell/tauri.conf.json）：${err.message}`)
    process.exit(1)
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher-shell</string>
  <key>CFBundleIdentifier</key><string>app.launcher.desktop</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${shellVersion}</string>
  <key>CFBundleVersion</key><string>${shellVersion}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>仅在需要管理员权限写入 hosts 文件时使用（弹出系统提权对话框）</string>
</dict>
</plist>
`
}

/**
 * 找本机可用的固定签名身份（scripts/make-signing-cert.mjs 创建的证书）。
 * 找不到就返回 null —— 调用方回落到 ad-hoc，打包流程不因此中断。
 */
function detectSigningIdentity() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    const match = out.match(/"([^"]*Chassis Local Signing[^"]*)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}
