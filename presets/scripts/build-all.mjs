#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * 构建 `presets/` 下的全部预置插件（逐插件跑它自己的 `build`）。
 *
 * 依赖由仓库根的 `pnpm install` 统一安装 —— 预置插件是 pnpm workspace 成员，
 * 所以这里不再有 `npm install` / 逐插件的 node_modules。
 *
 * 用法（仓库根或本目录都能跑）：
 *   node presets/scripts/build-all.mjs                    # 构建全部
 *   node presets/scripts/build-all.mjs --pack             # 额外打 zip 到 presets/release/（如快侧安装用）
 *   node presets/scripts/build-all.mjs --only=sofast-totp # 只构建指定插件
 */

const presetsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(presetsRoot, '..')
const pack = process.argv.includes('--pack')
const only = process.argv.filter((arg) => arg.startsWith('--only=')).map((arg) => arg.slice('--only='.length))

/** presets/ 下不是插件的目录 */
const NON_PLUGIN_DIRS = new Set(['shared', 'scripts', 'tests', 'docs', 'release', 'node_modules'])

const plugins = readdirSync(presetsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NON_PLUGIN_DIRS.has(entry.name))
  .map((entry) => entry.name)
  .filter((name) => existsSync(path.join(presetsRoot, name, 'package.json')))
  .filter((name) => !only.length || only.includes(name))

if (!plugins.length) {
  console.error('没有可构建的预置插件')
  process.exit(1)
}

const releaseDir = path.join(presetsRoot, 'release')
if (pack) mkdirSync(releaseDir, { recursive: true })

let failed = 0
for (const name of plugins) {
  const dir = path.join(presetsRoot, name)
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  try {
    console.log(`[${name}] 构建…`)
    // 用 pnpm filter 走工作区依赖（自动带上插件的 devDependencies 解析）
    execFileSync('pnpm', ['--filter', pkg.name, 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' })

    const dist = path.join(dir, 'dist')
    if (!existsSync(path.join(dist, 'package.json'))) {
      console.error(`[${name}] ✗ 产物缺少 package.json（插件清单）`)
      failed += 1
      continue
    }
    console.log(`[${name}] ✓ 产物 dist/`)

    if (pack) {
      const zipPath = path.join(releaseDir, `${name}.zip`)
      rmSync(zipPath, { force: true })
      // zip 根 = 插件目录内容（如快安装目录形态）
      execFileSync('zip', ['-rq', zipPath, '.'], { cwd: dist })
      console.log(`[${name}] ✓ 打包 presets/release/${name}.zip`)
    }
  } catch (err) {
    failed += 1
    console.error(`[${name}] ✗ 失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

if (pack) console.log(`\n发布目录：${path.relative(repoRoot, releaseDir)}`)
process.exit(failed ? 1 : 0)
