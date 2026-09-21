#!/usr/bin/env node
/**
 * 壳 / 内核版本的**唯一维护点**：仓库根的 `version.json`。
 *
 * 为什么需要它：产品版本散在三个文件里（壳两处 + 内核一处），发版靠人记就会漏 ——
 * 漏改的后果是自更新链路**静默失效**（客户端永远判不出新版本，或装出对不上号的包）。
 * 现在改版本只动 `version.json`（或 `set` 一条命令），其余文件由本脚本同步，CI 再兜一道 check。
 *
 * 用法：
 *   node scripts/version.mjs check              # 校验位点与清单一致（CI / 发版前）
 *   node scripts/version.mjs sync               # 清单 → 位点文件
 *   node scripts/version.mjs set app 0.1.5      # 改清单 + 自动 sync（应用/壳版本）
 *   node scripts/version.mjs set kernel 0.1.1   # 改清单 + 自动 sync（内核版本）
 *   [--root <dir>]                              # 指定仓库根（默认脚本上级目录；测试用）
 *
 * 位点（都由本脚本写，别手改这些文件里的 version）：
 *   app    → apps/shell/tauri.conf.json 的顶层 version（build.rs 注入 SHELL_VERSION = `--hot-probe` 自报；pack-local 写 Info.plist）
 *   app    → apps/shell/Cargo.toml 的 [package] version
 *   app    → apps/shell/Cargo.lock 的 launcher-shell 包版本（cargo 构建时也会写，但那次写在提交之后 ⇒ 每次都留一个未提交改动，交给本脚本一次到位）
 *   kernel → apps/kernel/Cargo.toml 的 [package] version（pack-kernel 打包 / 内核 host_info 上报）
 *   kernel → 根 Cargo.lock 的 launcher-kernel 包版本（同上）
 *
 * 刻意**不在**这里的版本（各自独立演进，别往清单里塞）：
 *   - 机制版本 `SHELL_HOT_VERSION` / `HOT_UPDATE_VERSION`：自更新机制自身的版本，只在机制变化时单独 bump；
 *   - 插件版本（`plugins/<id>/package.json`）：走 plugins-latest 通道，各插件独立；
 *   - 内部包版本（根 `package.json` / `packages/*`）：不发布，无意义。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 位点表：manifest 的键 → 要同步的文件与读写方式（`lock` 要额外给包名 pkg） */
const SITES = {
  app: [
    { file: 'apps/shell/tauri.conf.json', label: '壳（tauri.conf.json）', kind: 'json' },
    { file: 'apps/shell/Cargo.toml', label: '壳（Cargo.toml）', kind: 'toml' },
    { file: 'apps/shell/Cargo.lock', label: '壳（Cargo.lock）', kind: 'lock', pkg: 'launcher-shell' },
  ],
  kernel: [
    { file: 'apps/kernel/Cargo.toml', label: '内核（Cargo.toml）', kind: 'toml' },
    { file: 'Cargo.lock', label: '内核（Cargo.lock）', kind: 'lock', pkg: 'launcher-kernel' },
  ],
}

const SEMVER = /^\d+\.\d+\.\d+$/

// ── 清单读写 ─────────────────────────────────────────────────

function manifestPath(root) {
  return path.join(root, 'version.json')
}

function readManifest(root) {
  const raw = fs.readFileSync(manifestPath(root), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    fail(`version.json 不是合法 JSON：${err.message}`)
  }
  for (const key of Object.keys(SITES)) {
    const value = parsed[key]
    if (typeof value !== 'string' || !SEMVER.test(value)) {
      fail(`version.json 的 ${key} 必须是 x.y.z 形式（现在是 ${JSON.stringify(value)}）`)
    }
  }
  return parsed
}

function writeManifest(root, manifest) {
  // 字段顺序固定 app → kernel：清单是给人看的，保持稳定
  const next = { app: manifest.app, kernel: manifest.kernel }
  fs.writeFileSync(manifestPath(root), `${JSON.stringify(next, null, 2)}\n`)
}

// ── 位点读写 ─────────────────────────────────────────────────

/** 读位点文件（读不到就红：宁可失败，也不静默跳过一个位点） */
function readFileOrFail(root, file) {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8')
  } catch (err) {
    fail(`读不到位点文件：${file}（${err.message}）`)
  }
}

/**
 * `Cargo.lock` 里某个包的 `[[package]]` 段：`name` 与 `version` 各占一行、紧挨着。
 * 包名在 lock 里唯一，且 dependencies 列表里只出现 `"名字",` 形式 ⇒ 不会误伤。
 */
function lockPackagePattern(pkg) {
  return new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${pkg}"\\r?\\nversion = ")([^"]+)(")`)
}

/** 读位点当前值 */
function readSite(root, site) {
  const text = readFileOrFail(root, site.file)
  if (site.kind === 'json') {
    const match = text.match(/"version"\s*:\s*"([^"]*)"/)
    if (!match) fail(`读不到顶层 version：${site.file}`)
    return match[1]
  }
  if (site.kind === 'lock') {
    const match = text.match(lockPackagePattern(site.pkg))
    if (!match) fail(`Cargo.lock 里找不到包 ${site.pkg}：${site.file}`)
    return match[2]
  }
  const block = tomlPackageBlock(text, site.file)
  const match = block.match(/^version\s*=\s*"([^"]*)"/m)
  if (!match) fail(`读不到 [package] 段里的 version：${site.file}`)
  return match[1]
}

/** 写位点（值没变则不动文件：避免无意义的 diff 与 mtime 抖动）。返回是否真的改了 */
function writeSite(root, site, value) {
  const full = path.join(root, site.file)
  const text = readFileOrFail(root, site.file)
  let next
  if (site.kind === 'json') {
    next = text.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${value}"`)
  } else if (site.kind === 'lock') {
    const pattern = lockPackagePattern(site.pkg)
    if (!pattern.test(text)) fail(`Cargo.lock 里找不到包 ${site.pkg}：${site.file}`)
    next = text.replace(pattern, `$1${value}$3`)
  } else {
    // 只动 [package] 段里的 version —— 依赖声明里的 version（`serde = { version = "1" }`）绝不能碰
    const parts = text.split(/^\[/m)
    const index = parts.findIndex((chunk) => chunk.startsWith('package]'))
    if (index < 0) fail(`找不到 [package] 段：${site.file}`)
    parts[index] = parts[index].replace(/^(version\s*=\s*")[^"]*(")/m, `$1${value}$2`)
    next = parts.join('[')
  }
  if (next === text) return false
  fs.writeFileSync(full, next)
  return true
}

/** `[package]` 段的文本（split 会吃掉 `[`，join 时补回 —— 与 pack-kernel.mjs 的读法同一思路） */
function tomlPackageBlock(text, file) {
  const block = text.split(/^\[/m).find((chunk) => chunk.startsWith('package]'))
  if (!block) fail(`找不到 [package] 段：${file}`)
  return block
}

// ── 三个命令 ─────────────────────────────────────────────────

function check(root) {
  const manifest = readManifest(root)
  let issues = 0
  for (const [key, sites] of Object.entries(SITES)) {
    for (const site of sites) {
      const actual = readSite(root, site)
      if (actual === manifest[key]) {
        console.log(`  ✓ ${site.label}  ${actual}`)
      } else {
        issues += 1
        console.error(`  ✗ ${site.label} = ${actual}，version.json = ${manifest[key]}`)
      }
    }
  }
  if (issues > 0) {
    console.error(`\n版本漂移 ${issues} 处：跑 node scripts/version.mjs sync 同步（真相在根 version.json）`)
    process.exit(1)
  }
  console.log(`\n版本一致：app ${manifest.app} / kernel ${manifest.kernel}`)
}

function sync(root) {
  const manifest = readManifest(root)
  let changed = 0
  for (const [key, sites] of Object.entries(SITES)) {
    for (const site of sites) {
      if (writeSite(root, site, manifest[key])) {
        changed += 1
        console.log(`  ✎ ${site.label} → ${manifest[key]}`)
      } else {
        console.log(`  ✓ ${site.label} 已是 ${manifest[key]}`)
      }
    }
  }
  console.log(changed > 0 ? `\n已同步 ${changed} 处（版本真相：根 version.json）` : '\n无需同步（全部一致）')
}

function set(root, key, value) {
  if (!(key in SITES)) fail(`未知的版本键：${JSON.stringify(key)}（可选：${Object.keys(SITES).join(' / ')}）`)
  if (!SEMVER.test(value)) fail(`版本号必须是 x.y.z 形式：${JSON.stringify(value)}`)
  const manifest = readManifest(root)
  manifest[key] = value
  writeManifest(root, manifest)
  console.log(`version.json：${key} → ${value}`)
  sync(root)
}

// ── CLI ─────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  let root = DEFAULT_ROOT
  const rootIndex = argv.indexOf('--root')
  if (rootIndex >= 0) {
    root = path.resolve(argv[rootIndex + 1] ?? '')
    argv.splice(rootIndex, 2)
  }
  const [command = 'check', ...rest] = argv
  if (command === 'check') check(root)
  else if (command === 'sync') sync(root)
  else if (command === 'set') set(root, rest[0] ?? '', rest[1] ?? '')
  else {
    console.error(`未知命令：${command}（可用：check / sync / set <app|kernel> <x.y.z>）`)
    process.exit(1)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

main()
