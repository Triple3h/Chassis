#!/usr/bin/env node
/**
 * 构建：kernel（自包含 mjs）→ launcher-ui（vite）→ plugins（全部出厂插件）。
 *
 * 插件工具链有两套（内置 esbuild 无框架 / 移植件 Vite + Vue），统一由 buildPluginRoot
 * 按各插件 package.json 里的 build:view / build:scripts 驱动，产物形态一致。
 * 用法：node scripts/build-all.mjs [kernel|ui|plugins|all]
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scope = process.argv[2] ?? 'all'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: { ...process.env } })
  if (result.status !== 0) {
    console.error(`✗ 命令失败：${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

async function buildKernel() {
  const outfile = path.join(repoRoot, 'apps', 'kernel', 'dist', 'kernel.mjs')
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await build({
    entryPoints: [path.join(repoRoot, 'apps', 'kernel', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    // sidecar 必须自包含：第三方依赖全部打进来
    logLevel: 'warning',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  console.log(`✓ kernel → ${path.relative(repoRoot, outfile)}`)
}

function buildUi() {
  const dir = path.join(repoRoot, 'apps', 'launcher-ui')
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    console.log('· 跳过 UI（未初始化）')
    return
  }
  run(pnpmCmd, ['--filter', 'launcher-ui', 'run', 'build'], repoRoot)
  console.log('✓ launcher-ui → apps/launcher-ui/dist')
}

function buildPlugins() {
  const roots = [path.join(repoRoot, 'plugins'), path.join(repoRoot, 'tests', 'fixtures')]
  for (const root of roots) buildPluginRoot(root)
}

function buildPluginRoot(root) {
  if (!fs.existsSync(root)) return
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name)
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) continue
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const hasView = (pkg.commands ?? []).some((c) => c.mode === 'view')
    const hasScripts = (pkg.commands ?? []).some((c) => c.mode !== 'view')
    if (hasView) {
      if (fs.existsSync(path.join(dir, 'index.html'))) {
        run(pnpmCmd, ['--filter', pkg.name, 'run', 'build:view'], repoRoot)
      }
    }
    if (hasScripts) {
      run(pnpmCmd, ['--filter', pkg.name, 'run', 'build:scripts'], repoRoot)
    }
    console.log(`✓ plugin ${name}`)
  }
}

if (scope === 'all' || scope === 'kernel') await buildKernel()
if (scope === 'all' || scope === 'ui') buildUi()
if (scope === 'all' || scope === 'plugins') buildPlugins()
console.log('构建完成')
