#!/usr/bin/env node
/**
 * 自用打包（不走 tauri-cli / 不公证 / 不打 dmg）：
 *   1. cargo build --release
 *   2. 手工组装 Launcher.app（Info.plist + MacOS/ + Resources/）
 *   3. ad-hoc 签名（Apple Silicon 上未签名会被内核杀掉）
 *
 * 产出：dist-app/Launcher.app —— 拖进 /Applications 即可双击运行。
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
const outApp = path.join(repoRoot, 'dist-app', 'Launcher.app')

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

// 4) ad-hoc 签名（必需：Apple Silicon 上未签名会被内核直接杀掉）
line('▶ codesign --force --deep --sign -（ad-hoc）')
run('codesign', ['--force', '--deep', '--sign', '-', outApp])
try {
  run('codesign', ['--verify', '--verbose=1', outApp])
} catch {
  line('· 签名校验有告警（ad-hoc 签名正常现象）')
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
line(`✓ 打包完成：${path.relative(repoRoot, outApp)}`)
line('  安装：把 Launcher.app 拖进 /Applications，双击运行')
line('  首次运行：系统会提示"辅助功能/通知"权限，按提示授权即可')

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher-shell</string>
  <key>CFBundleIdentifier</key><string>app.launcher.desktop</string>
  <key>CFBundleName</key><string>Launcher</string>
  <key>CFBundleDisplayName</key><string>Launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>用于打开应用、文件与网址</string>
</dict>
</plist>
`
}
