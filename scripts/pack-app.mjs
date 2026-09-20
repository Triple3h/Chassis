#!/usr/bin/env node
/**
 * 应用（壳）自更新通道：把各平台的壳产物打成可分发 zip + 写分片，供 `app-release.yml` 汇总成 `app-registry.json`。
 *
 * 用法：node scripts/pack-app.mjs [--platform macos|windows]
 *   （缺省按当前系统推断：macOS 跑 macOS 分支、Windows 跑 Windows 分支；CI 上两个平台各跑一次）
 *
 * 产物（都在 app/release/）：
 *   Chassis-<版本>-macos-<架构>.zip   解压结构 = Chassis.app/Contents/…（先跑 pack-local-app.mjs：组装 + 签名在那边）
 *   Chassis-<版本>-win-<架构>.zip     解压结构 = Chassis.exe + resources/（先跑 pack-win.mjs：绿色版一条命令）
 *   app-shard-<平台>-<架构>.json      分片（给 gen-app-registry.mjs 汇总）
 *
 * 版本从**根 `version.json`**（唯一维护点，由 `scripts/version.mjs` 同步）读；macOS 分支再校验一次
 * 「Info.plist 与它一致」，把「版本源分叉」这类事故拦在发版之前
 * （否则客户端要么判不出新版本、要么装出对不上号的包）。
 *
 * 两条分支的差别只在「怎么打包」，都在同一个索引里，而且**两端都会自动替换**：
 * macOS 换 `.app`、Windows 换绿色版目录（`Chassis.exe` + `resources/`，`swap.ps1` 在壳退出后整目录 rename）；
 * 装到只读位置 / NSIS 安装版才降级为「提示手动更新」（边界见 docs/architecture.md §11）。
 *
 * 签名是 macOS 自更新的硬前提：新包必须与当前包**同一签名身份**，否则每次更新 TCC 授权（辅助功能 /
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

const platform = resolvePlatform()
if (platform === 'windows') packWindows()
else packMacos()

/** macOS：把签名好的 `.app` 压成 zip（`ditto` 保留 unix 权限位与资源分叉，解压侧会恢复可执行位） */
function packMacos() {
  if (process.platform !== 'darwin') {
    fail('macOS 分支要在 macOS 上跑（需要 ditto / plutil / codesign）')
  }
  if (!fs.existsSync(appPath)) {
    fail(`找不到 ${path.relative(repoRoot, appPath)}：先跑 node scripts/pack-local-app.mjs`)
  }

  const version = manifestAppVersion()
  const tauriVersion = shellVersion()
  if (tauriVersion !== version) {
    fail(`版本不一致：apps/shell/tauri.conf.json = ${tauriVersion}，version.json = ${version}（跑 node scripts/version.mjs sync）`)
  }
  const plistVersion = readPlistVersion(appPath)
  if (plistVersion !== version) {
    fail(`版本不一致：Info.plist = ${plistVersion}，version.json = ${version}（重新跑 node scripts/pack-local-app.mjs）`)
  }

  fs.mkdirSync(releaseDir, { recursive: true })
  const arch = currentArch()
  const file = `${APP_NAME}-${version}-macos-${arch}.zip`
  const zipPath = path.join(releaseDir, file)
  fs.rmSync(zipPath, { force: true })
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

  writeShard({ version, platform: 'macos', arch, file, zipPath })
  const identity = signingIdentity()
  console.log(`  签名身份：${identity}`)
  if (identity.startsWith('ad-hoc')) {
    // 这是自更新用户 TCC 全部重弹的前兆：channels / secrets / 证书信任三处任一出问题都会落到这里
    console.warn('  ⚠️ ad-hoc 签名：客户端每次自更新后都要重新授权（辅助功能 / 屏幕录制）——查 MACOS_SIGN_P12 secrets 与证书信任')
  }
}

/**
 * Windows：把 `pack-win.mjs` 打好的绿色版 zip 搬进更新通道产物目录并算哈希。
 *
 * **不在这里重新压缩**：绿色版的组装与压缩只有 `scripts/pack-win.mjs` 一份（解压结构 = `Chassis.exe` + `resources/`）。
 * Authenticode 签名暂不参与 —— 整目录替换不涉签名身份（不像 macOS 的 TCC 按签名记账）。
 */
function packWindows() {
  const version = manifestAppVersion()
  const arch = currentArch()
  const file = `${APP_NAME}-${version}-win-${arch}.zip`
  const source = path.join(repoRoot, 'dist-app', file)
  if (!fs.existsSync(source)) {
    fail(`找不到 ${path.relative(repoRoot, source)}：先在 Windows 上跑 node scripts/pack-win.mjs`)
  }
  fs.mkdirSync(releaseDir, { recursive: true })
  const zipPath = path.join(releaseDir, file)
  fs.rmSync(zipPath, { force: true })
  fs.copyFileSync(source, zipPath)
  writeShard({ version, platform: 'windows', arch, file, zipPath })
}

/** 写分片（两个平台共用）：gen-app-registry.mjs 只认 `app-shard-*.json` */
function writeShard({ version, platform, arch, file, zipPath }) {
  const bytes = fs.readFileSync(zipPath)
  const shard = {
    version,
    shellHotVersion: shellHotVersion(),
    platform,
    arch,
    file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
  const shardPath = path.join(releaseDir, `app-shard-${platform}-${arch}.json`)
  fs.writeFileSync(shardPath, `${JSON.stringify(shard, null, 2)}\n`)
  console.log(`✓ ${path.relative(repoRoot, zipPath)}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`)
  console.log(`✓ ${path.relative(repoRoot, shardPath)}（app ${version}，shellHotVersion ${shard.shellHotVersion}）`)
}

/** 目标平台：显式 `--platform` 优先，否则按当前系统推断 */
function resolvePlatform() {
  const index = process.argv.indexOf('--platform')
  const flag = index >= 0 ? process.argv[index + 1] : undefined
  if (flag) {
    if (flag !== 'macos' && flag !== 'windows') fail(`不支持的平台：${flag}（可选 macos / windows）`)
    return flag
  }
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  fail('只在 macOS / Windows 上有产物（或显式给 --platform macos|windows 只为写分片）')
}

function currentArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/** 壳版本（唯一源：根 `version.json` 的 `app`） */
function manifestAppVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'))
  if (!manifest.app) fail('version.json 里没有 app 版本')
  return manifest.app
}

/** 壳版本位点之一（`apps/shell/tauri.conf.json`，由 version.mjs sync 写入）—— 用来交叉校验清单 */
function shellVersion() {
  const text = fs.readFileSync(path.join(shellDir, 'tauri.conf.json'), 'utf8')
  const match = text.match(/"version"\s*:\s*"([^"]+)"/)
  if (!match) fail('读不到壳版本（apps/shell/tauri.conf.json 的 version）')
  return match[1]
}

/** 壳自更新机制版本（唯一源：apps/shell/src/update.rs 的 SHELL_HOT_VERSION） */
function shellHotVersion() {
  const text = fs.readFileSync(path.join(shellDir, 'src', 'update.rs'), 'utf8')
  const match = text.match(/SHELL_HOT_VERSION:\s*&str\s*=\s*"([^"]+)"/)
  if (!match) fail('读不到 SHELL_HOT_VERSION（apps/shell/src/update.rs）')
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
    fail(`读不到 Info.plist 的版本：${err.message}`)
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

function fail(message) {
  console.error(message)
  process.exit(1)
}
