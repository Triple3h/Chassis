#!/usr/bin/env node
/**
 * 开发模式：不起壳，浏览器里就能用（内核 standalone + 启动台 UI 的 vite dev server）。
 *
 *   node scripts/dev.mjs          内核 + UI（缺省）
 *   node scripts/dev.mjs kernel   只起内核
 *   node scripts/dev.mjs ui       只起 UI
 *
 * 约定：
 * - 内核数据落在仓库根的 `.dev-data/`（已 gitignore），不碰真实用户数据；
 * - UI 走 vite dev（127.0.0.1:3333，HMR）；内核 `--ui-dev` 放开该 origin 的 CORS，
 *   并把静态请求 302 到 vite。页面首次打开要带 `?kernel=` 指向内核（之后记在 localStorage）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scope = process.argv[2] ?? 'all'
if (!['all', 'kernel', 'ui'].includes(scope)) {
  console.error(`✗ 未知参数：${scope}（可用：kernel / ui；缺省 = 两个都起）`)
  process.exit(1)
}
const withKernel = scope === 'all' || scope === 'kernel'
const withUi = scope === 'all' || scope === 'ui'

const UI_PORT = 3333
// v2：内核是 Rust 二进制（`target/release/launcher-kernel`）
const kernelBin = path.join(repoRoot, 'target', 'release', process.platform === 'win32' ? 'launcher-kernel.exe' : 'launcher-kernel')
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const children = []

function shutdown(code = 0) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function ensureKernelBuilt() {
  if (fs.existsSync(kernelBin)) return
  console.log('· 内核产物不存在，先构建一次（cargo build --release -p launcher-kernel）')
  const result = spawnSync('cargo', ['build', '--release', '-p', 'launcher-kernel'], { stdio: 'inherit', cwd: repoRoot })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** 插件逻辑层是 Rust 产物（`dist/<name>`）：没有就先整包构建一次，否则内核会报 ENTRY_MISSING */
function ensurePluginsBuilt() {
  const sentinel = path.join(repoRoot, 'plugins', 'web-open', 'dist', 'web')
  if (fs.existsSync(sentinel)) return
  console.log('· 插件逻辑层产物不存在，先构建一次（pnpm build:plugins）')
  const result = spawnSync(pnpmCmd, ['build:plugins'], { stdio: 'inherit', cwd: repoRoot })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function startKernel() {
  ensureKernelBuilt()
  ensurePluginsBuilt()
  const args = [
    '--standalone',
    '--data-root',
    path.join(repoRoot, '.dev-data'),
    '--builtin-plugins',
    path.join(repoRoot, 'plugins'),
  ]
  if (withUi) args.push('--ui-dev', `http://127.0.0.1:${UI_PORT}`)

  // stdout 是壳的协议通道：standalone 下没有意义，直接丢掉，只看 stderr
  const child = spawn(kernelBin, args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(child)

  let announced = false
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    if (announced) return
    const match = /内核就绪：UI http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk)
    if (!match) return
    announced = true
    const port = match[1]
    console.log(`\n内核就绪 → http://127.0.0.1:${port}（API：/api，SSE：/api/events）`)
    if (withUi) console.log(`在浏览器打开 → http://127.0.0.1:${UI_PORT}/?kernel=http://127.0.0.1:${port}\n`)
    else console.log('UI 由内核托管构建产物（先 pnpm build:ui）；要热更新就用 pnpm dev\n')
  })
  child.on('exit', (code) => {
    console.error(`✗ 内核退出（code ${code ?? 'signal'}）`)
    shutdown(code ?? 0)
  })
}

function startUi() {
  const child = spawn('pnpm', ['--filter', 'launcher-ui', 'run', 'dev'], { cwd: repoRoot, stdio: 'inherit' })
  children.push(child)
  child.on('exit', (code) => {
    if (code) console.error(`✗ UI dev server 退出（code ${code}）`)
    shutdown(code ?? 0)
  })
}

if (withKernel) startKernel()
if (withUi) startUi()
