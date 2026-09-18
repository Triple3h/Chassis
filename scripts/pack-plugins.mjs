#!/usr/bin/env node
/**
 * 把已构建的插件打成 zip（zip 根 = 插件目录内容，宿主可直接当「目录插件」安装）。
 *
 * 用法：node scripts/pack-plugins.mjs [插件名...]
 *
 * 产物：
 *   plugins/release/<id>-<version>-<platform>-<arch>.zip   插件包（逻辑层是原生产物 ⇒ 必须按平台分）
 *   plugins/release/shard-<platform>-<arch>.json            分片（sha256 等元数据，给 gen-plugin-registry.mjs 汇总）
 *
 * essential 出厂插件不产出（它们随 App 包发布，不参与远程更新）。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'plugins')
const releaseDir = path.join(pluginsRoot, 'release')
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))

const platform = platformName(process.platform)
const arch = archName(process.arch)

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

const shard = { platform, arch, plugins: {} }
let failed = 0
let skipped = 0

for (const name of names) {
  const dist = path.join(pluginsRoot, name, 'dist')
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8'))
  const id = typeof manifest.name === 'string' && manifest.name ? manifest.name : name
  const version = typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0'
  if (manifest.essential === true) {
    skipped += 1
    console.log(`- ${id}：出厂基础插件，不参与远程更新（随 App 包发布）`)
    continue
  }
  const file = `${id}-${version}-${platform}-${arch}.zip`
  const zipPath = path.join(releaseDir, file)
  try {
    fs.rmSync(zipPath, { force: true })
    zipDirectory(dist, zipPath)
    const bytes = fs.readFileSync(zipPath)
    shard.plugins[id] = {
      title: typeof manifest.title === 'string' ? manifest.title : id,
      version,
      apiVersion: typeof manifest.apiVersion === 'string' ? manifest.apiVersion : String(manifest.apiVersion ?? '2'),
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    }
    console.log(`✓ ${path.relative(repoRoot, zipPath)}`)
  } catch (err) {
    failed += 1
    console.error(`✗ ${id}：${err instanceof Error ? err.message : String(err)}`)
  }
}

const shardPath = path.join(releaseDir, `shard-${platform}-${arch}.json`)
fs.writeFileSync(shardPath, `${JSON.stringify(shard, null, 2)}\n`)
console.log(`✓ ${path.relative(repoRoot, shardPath)}（${Object.keys(shard.plugins).length} 个插件）`)
if (skipped) console.log(`\n跳过 ${skipped} 个出厂基础插件`)
console.log(`\n发布目录：${path.relative(repoRoot, releaseDir)}`)
process.exit(failed ? 1 : 0)

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
    // Windows  runner 没有 `zip`：用自带的 PowerShell（与 pack-win.mjs 同一选择）
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path .\\* -DestinationPath '${zipPath}' -Force`],
      { cwd },
    )
    return
  }
  execFileSync('zip', ['-rq', zipPath, '.'], { cwd })
}
