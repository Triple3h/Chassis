#!/usr/bin/env node
/**
 * 应用（壳）自更新通道：把 `.app` 压成 zip + 写分片，供 `app-release.yml` 汇总成 `app-registry.json`。
 *
 * 用法：node scripts/pack-app.mjs
 *   （先跑 node scripts/pack-local-app.mjs —— 组装 + 签名在那边，本脚本只管「打成可分发单元」）
 *
 * 产物：
 *   app/release/Chassis-<版本>-macos-<架构>.zip   解压结构 = Chassis.app/Contents/…
 *   app/release/app-shard-macos-<架构>.json       分片（给 gen-app-registry.mjs 汇总）
 *
 * 版本只有一个源：`apps/shell/tauri.conf.json` 的 `version`（`build.rs` 读它注入 `SHELL_VERSION`，
 * `pack-local-app.mjs` 读它写 Info.plist）——本脚本再校验一次「Info.plist 与它一致」，把
 * 「版本源分叉」这类事故拦在发版之前（否则客户端要么判不出新版本、要么装出对不上号的包）。
 *
 * 签名是自更新的硬前提：新包必须与当前包**同一签名身份**，否则每次更新 TCC 授权（辅助功能 /
 * 屏幕录制…）都会失配重弹。CI 上用 secrets 导入同一张证书（见 .github/workflows/app-release.yml）。
 */
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = path.join(repoRoot, 'apps', 'shell')
const releaseDir = path.join(repoRoot, 'app', 'release')
const APP_NAME = 'Chassis'
const appPath = path.join(repoRoot, 'dist-app', `${APP_NAME}.app`)

if (process.platform !== 'darwin') {
  console.error('应用自更新通道只在 macOS 上打包（Windows 的运行中 exe 无法替换，只能走安装器）')
  process.exit(1)
}
if (!fs.existsSync(appPath)) {
  console.error(`找不到 ${path.relative(repoRoot, appPath)}：先跑 node scripts/pack-local-app.mjs`)
  process.exit(1)
}

const version = shellVersion()
const hotVersion = shellHotVersion()
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const platform = 'macos'

const plistVersion = readPlistVersion(appPath)
if (plistVersion !== version) {
  console.error(`版本不一致：Info.plist = ${plistVersion}，tauri.conf.json = ${version}`)
  console.error('  重新跑 node scripts/pack-local-app.mjs（它会用 tauri.conf.json 的版本写 Info.plist）')
  process.exit(1)
}

fs.mkdirSync(releaseDir, { recursive: true })
const file = `${APP_NAME}-${version}-${platform}-${arch}.zip`
const zipPath = path.join(releaseDir, file)
fs.rmSync(zipPath, { force: true })
// ditto 保留 unix 权限位与资源分叉（解压侧 internal-store 会恢复可执行位）
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

const bytes = fs.readFileSync(zipPath)
const shard = {
  version,
  shellHotVersion: hotVersion,
  platform,
  arch,
  file,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
}
const shardPath = path.join(releaseDir, `app-shard-${platform}-${arch}.json`)
fs.writeFileSync(shardPath, `${JSON.stringify(shard, null, 2)}\n`)

console.log(`✓ ${path.relative(repoRoot, zipPath)}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`)
console.log(`✓ ${path.relative(repoRoot, shardPath)}（app ${version}，shellHotVersion ${hotVersion}）`)
const identity = signingIdentity()
console.log(`  签名身份：${identity}`)
if (identity.startsWith('ad-hoc')) {
  // 这是自更新用户 TCC 全部重弹的前兆：channels / secrets / 证书信任三处任一出问题都会落到这里
  console.warn('  ⚠️ ad-hoc 签名：客户端每次自更新后都要重新授权（辅助功能 / 屏幕录制）——查 MACOS_SIGN_P12 secrets 与证书信任')
}

/** 壳版本（唯一源：tauri.conf.json） */
function shellVersion() {
  const text = fs.readFileSync(path.join(shellDir, 'tauri.conf.json'), 'utf8')
  const match = text.match(/"version"\s*:\s*"([^"]+)"/)
  if (!match) {
    console.error('读不到壳版本（apps/shell/tauri.conf.json 的 version）')
    process.exit(1)
  }
  return match[1]
}

/** 壳自更新机制版本（唯一源：apps/shell/src/update.rs 的 SHELL_HOT_VERSION） */
function shellHotVersion() {
  const text = fs.readFileSync(path.join(shellDir, 'src', 'update.rs'), 'utf8')
  const match = text.match(/SHELL_HOT_VERSION:\s*&str\s*=\s*"([^"]+)"/)
  if (!match) {
    console.error('读不到 SHELL_HOT_VERSION（apps/shell/src/update.rs）')
    process.exit(1)
  }
  return match[1]
}

/** 包内 Info.plist 的 CFBundleShortVersionString（plutil 是 macOS 自带的，不用再写一个 plist 解析器） */
function readPlistVersion(bundle) {
  try {
    return execFileSync(
      'plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')],
      { encoding: 'utf8' },
    ).trim()
  } catch (err) {
    console.error(`读不到 Info.plist 的版本：${err.message}`)
    process.exit(1)
  }
}

/**
 * 当前包的签名身份（打印出来核对用）。
 * CI 上如果忘了导入证书，这里会显示「ad-hoc」—— 那是自更新用户 TCC 全部重弹的前兆。
 *
 * 注意：`codesign -dv` 把信息写在 **stderr**（退出码仍是 0），所以要合并两个流再解析。
 */
function signingIdentity() {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' })
  return authorityOf(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function authorityOf(text) {
  const match = text.match(/Authority=([^\n]+)/)
  if (!match) return 'ad-hoc（未找到固定证书：客户端自更新会让 TCC 授权重弹）'
  return match[1].trim()
}
