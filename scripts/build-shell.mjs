#!/usr/bin/env node
/**
 * 打包 macOS .app / .dmg（requirements §6.3 / M4）：
 *   1. 构建 kernel（自包含 mjs）
 *   2. 构建 launcher-ui 静态产物
 *   3. 构建出厂插件（plugins/*，dist/ 形态）
 *   4. 拷进 apps/shell/resources/（sidecar 运行时按 resource_dir 查找）
 *   5. cargo tauri build
 *
 * 用法：node scripts/build-shell.mjs [--debug] [--no-bundle]
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { assembleResources } from './lib/resources.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = path.join(repoRoot, 'apps', 'shell')

function run(cmd, args, cwd = repoRoot) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// 1) 内核 + UI + 插件
run(process.execPath, [path.join(repoRoot, 'scripts', 'build-all.mjs')])

// 2) 资源落位（与自用打包共用同一份实现）
const { pluginCount } = assembleResources(repoRoot)
console.log(`✓ 资源已就位：resources/{kernel,ui,builtin-plugins}（内置插件 ${pluginCount} 个）`)

// 3) Tauri 打包
const debug = process.argv.includes('--debug')
const noBundle = process.argv.includes('--no-bundle')
const args = ['tauri', 'build']
if (debug) args.push('--debug')
if (noBundle) args.push('--no-bundle')
run('npx', args, shellDir)
