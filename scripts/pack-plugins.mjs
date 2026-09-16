#!/usr/bin/env node
/**
 * 把已构建的插件打成 zip（zip 根 = 插件目录内容，宿主可直接当「目录插件」安装）。
 *
 * 用法：node scripts/pack-plugins.mjs [插件名...]
 * 产物：plugins/release/<name>.zip
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'plugins')
const releaseDir = path.join(pluginsRoot, 'release')
const wanted = process.argv.slice(2)

const names = fs
  .readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(pluginsRoot, name, 'dist', 'package.json')))
  .filter((name) => !wanted.length || wanted.includes(name))

if (!names.length) {
  console.error('没有可打包的插件（先跑 npm run build）')
  process.exit(1)
}
fs.mkdirSync(releaseDir, { recursive: true })

let failed = 0
for (const name of names) {
  const dist = path.join(pluginsRoot, name, 'dist')
  const zipPath = path.join(releaseDir, `${name}.zip`)
  try {
    fs.rmSync(zipPath, { force: true })
    execFileSync('zip', ['-rq', zipPath, '.'], { cwd: dist })
    console.log(`✓ ${path.relative(repoRoot, zipPath)}`)
  } catch (err) {
    failed += 1
    console.error(`✗ ${name}：${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`\n发布目录：${path.relative(repoRoot, releaseDir)}`)
process.exit(failed ? 1 : 0)
