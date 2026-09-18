#!/usr/bin/env node
/**
 * Windows 自用打包（绿色版目录 + zip，对齐 macOS 的 `app:local` 思路）：
 *   1. cargo build --release（壳；内核与插件由 build-all.mjs 编好）
 *   2. 组装 dist-app/Chassis-win/（Chassis.exe + resources/{kernel,ui,builtin-plugins}）
 *   3. 压成 dist-app/Chassis-<version>-win-<arch>.zip
 *
 * 为什么是绿色版而不是直接出 NSIS：自用优先「解压即用」；NSIS 安装器留给
 * `cargo tauri build --bundles nsis`（需要 tauri-cli）。
 *
 * 资源布局与**壳的查找顺序**一一对应（`apps/shell/src/sidecar.rs::kernel_entry`）：
 *   <exe 目录>/resources/kernel/launcher-kernel.exe
 * 未安装（绿色版）时 Tauri 的 `resource_dir()` 就是 exe 所在目录。
 *
 * 用法（Windows 主机）：node scripts/pack-win.mjs [--skip-build]
 *   --skip-build  跳过构建，只重新组装 / 重新压缩
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { assembleResources } from './lib/resources.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = path.join(repoRoot, 'apps', 'shell')
const APP_NAME = 'Chassis'
const outDir = path.join(repoRoot, 'dist-app', `${APP_NAME}-win`)
const skipBuild = process.argv.includes('--skip-build')

function line(text) {
  process.stdout.write(`${text}\n`)
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd })
}

function fail(message) {
  line(`✗ ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32') {
  fail('这个脚本要在 Windows 上跑（需要 .exe 产物与 Compress-Archive）；macOS 用 pnpm app:local')
}

// 1) 构建：内核 / UI / 插件（build-all）→ 资源就位；壳单独编（含 .exe 名称）
if (!skipBuild) {
  line('▶ 构建 kernel / ui / plugins')
  run(process.execPath, [path.join(repoRoot, 'scripts', 'build-all.mjs')])
}
const { pluginCount } = assembleResources(repoRoot)
line(`✓ 资源就位（内置插件 ${pluginCount} 个）`)

if (!skipBuild) {
  line('▶ cargo build --release（壳；首次约 5–15 分钟）')
  run('cargo', ['build', '--release', '--manifest-path', path.join(shellDir, 'Cargo.toml')])
}

const shellExe = path.join(shellDir, 'target', 'release', 'launcher-shell.exe')
if (!fs.existsSync(shellExe)) {
  fail(`找不到壳产物：${shellExe}（先跑 pnpm build 或去掉 --skip-build）`)
}

// 2) 组装绿色版目录
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(shellExe, path.join(outDir, `${APP_NAME}.exe`))

const iconSrc = path.join(shellDir, 'icons', 'icon.ico')
if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(outDir, 'icon.ico'))

for (const name of ['kernel', 'ui', 'builtin-plugins']) {
  const from = path.join(shellDir, 'resources', name)
  if (fs.existsSync(from)) fs.cpSync(from, path.join(outDir, 'resources', name), { recursive: true })
}
line(`✓ 组装完成：${path.relative(repoRoot, outDir)}`)

// 3) 压缩（PowerShell 自带 Compress-Archive，不引第三方依赖）
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
const zipPath = path.join(repoRoot, 'dist-app', `${APP_NAME}-${version}-win-${arch}.zip`)
fs.rmSync(zipPath, { force: true })
const compress = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${path.join(outDir, '*')}' -DestinationPath '${zipPath}' -Force`,
  ],
  { stdio: 'inherit' },
)
if (compress.status !== 0) fail('Compress-Archive 失败')

line('')
line(`✓ 打包完成：${path.relative(repoRoot, zipPath)}`)
line(`  使用：解压后双击 ${APP_NAME}.exe（首次会提示安装 WebView2，系统通常已自带）`)
line(`  数据目录：%APPDATA%\\${APP_NAME}`)
line('  权限：截取选中文本用 UI Automation（无需授权）；hosts 写入走 UAC 授权框')
