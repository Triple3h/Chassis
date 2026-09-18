#!/usr/bin/env node
/**
 * 把内核（Rust release 产物）+ UI（vite 产物）打成**一个更新包**（内核热更新的分发单元）。
 *
 * 用法：node scripts/pack-kernel.mjs
 *
 * 产物：
 *   kernel/release/launcher-kernel-<版本>-<平台>-<架构>.zip   解压结构 = launcher-kernel(.exe) + ui/
 *   kernel/release/kernel-shard-<平台>-<架构>.json            分片（给 gen-kernel-registry.mjs 汇总）
 *
 * 为什么 UI 与内核同包：UI 由内核托管（`--ui-dist`），只换内核会出现「新内核 + 旧 UI」——
 * 一致性由内核侧**同一份 pending 台账**保证（apps/kernel/src/hot/binary.rs：一起换、一起回滚）。
 *
 * zip 内保留可执行权限位（macOS 的 `zip` 会记录 unix 权限；解压方 internal-store 显式恢复）。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(repoRoot, 'kernel', 'release')
const kernelExe = process.platform === 'win32' ? 'launcher-kernel.exe' : 'launcher-kernel'
const builtKernel = path.join(repoRoot, 'target', 'release', kernelExe)
const builtUi = path.join(repoRoot, 'apps', 'launcher-ui', 'dist')

const platform = platformName(process.platform)
const arch = archName(process.arch)
const version = kernelVersion()
const hotVersion = hotUpdateVersion()

if (!fs.existsSync(builtKernel)) {
  console.error('内核产物不存在（先跑 node scripts/build-all.mjs kernel）')
  process.exit(1)
}
if (!fs.existsSync(path.join(builtUi, 'index.html'))) {
  console.error('UI 产物不存在（先跑 node scripts/build-all.mjs ui）')
  process.exit(1)
}

fs.mkdirSync(releaseDir, { recursive: true })
const staging = path.join(releaseDir, `.staging-${platform}-${arch}`)
fs.rmSync(staging, { recursive: true, force: true })
fs.mkdirSync(staging, { recursive: true })
fs.copyFileSync(builtKernel, path.join(staging, kernelExe))
if (process.platform !== 'win32') fs.chmodSync(path.join(staging, kernelExe), 0o755)
copyTree(builtUi, path.join(staging, 'ui'))

const file = `launcher-kernel-${version}-${platform}-${arch}.zip`
const zipPath = path.join(releaseDir, file)
fs.rmSync(zipPath, { force: true })
zipDirectory(staging, zipPath)
fs.rmSync(staging, { recursive: true, force: true })

const bytes = fs.readFileSync(zipPath)
const shard = {
  version,
  hotVersion,
  platform,
  arch,
  file,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
}
const shardPath = path.join(releaseDir, `kernel-shard-${platform}-${arch}.json`)
fs.writeFileSync(shardPath, `${JSON.stringify(shard, null, 2)}\n`)

console.log(`✓ ${path.relative(repoRoot, zipPath)}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`)
console.log(`✓ ${path.relative(repoRoot, shardPath)}（kernel ${version}，hotVersion ${hotVersion}）`)

function kernelVersion() {
  const text = fs.readFileSync(path.join(repoRoot, 'apps', 'kernel', 'Cargo.toml'), 'utf8')
  const block = text.split(/^\[/m).find((part) => part.startsWith('package]'))
  const match = block?.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) {
    console.error('读不到内核版本（apps/kernel/Cargo.toml）')
    process.exit(1)
  }
  return match[1]
}

/** 热更新机制版本（唯一源是内核常量；索引里带给客户端做兼容判断） */
function hotUpdateVersion() {
  const text = fs.readFileSync(path.join(repoRoot, 'apps', 'kernel', 'src', 'hot', 'spec.rs'), 'utf8')
  const match = text.match(/HOT_UPDATE_VERSION:\s*&str\s*=\s*"([^"]+)"/)
  if (!match) {
    console.error('读不到 HOT_UPDATE_VERSION（apps/kernel/src/hot/spec.rs）')
    process.exit(1)
  }
  return match[1]
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) fs.copyFileSync(source, target)
  }
}

function platformName(value) {
  if (value === 'darwin') return 'macos'
  if (value === 'win32') return 'windows'
  return value
}

function archName(value) {
  return value === 'x86_64' ? 'x64' : value
}

function zipDirectory(cwd, zipPath) {
  if (process.platform === 'win32') {
    // Windows runner 没有 `zip`：用自带的 PowerShell（与 pack-plugins.mjs 同一选择）
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path .\\* -DestinationPath '${zipPath}' -Force`],
      { cwd },
    )
    return
  }
  execFileSync('zip', ['-rq', zipPath, '.'], { cwd })
}
