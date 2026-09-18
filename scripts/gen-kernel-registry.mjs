#!/usr/bin/env node
/**
 * 汇总各平台的内核打包分片 → `kernel-registry.json`（内核热更新的索引，schema 1）。
 *
 * 用法：node scripts/gen-kernel-registry.mjs [选项]
 *   --repo <owner/repo>         Release 所在仓库（默认 triple3h/Chassis）
 *   --tag <tag>                 固定发布 tag（默认 kernel-latest）
 *   --min-hot-version <版本>    可选：客户端热更新机制低于此版本不提示（默认取产物自报）
 *   --notes <文本>              可选：更新说明
 *
 * 输入：kernel/release/kernel-shard-<platform>-<arch>.json（pack-kernel.mjs 产出）
 * 输出：kernel/release/kernel-registry.json
 *
 * 与插件索引（plugins-latest）**完全独立**：App 用 `v*`、插件用 `plugins-latest`、
 * 内核用 `kernel-latest` —— 三个 tag 互不干扰，各自 `releases/download/<tag>/...` 直链稳定。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(repoRoot, 'kernel', 'release')

const options = readOptions(process.argv.slice(2))
const repo = options.repo ?? 'triple3h/Chassis'
const tag = options.tag ?? 'kernel-latest'

const shards = fs
  .readdirSync(releaseDir)
  .filter((name) => name.startsWith('kernel-shard-') && name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(releaseDir, name), 'utf8')))

if (!shards.length) {
  console.error('没有分片（先跑 node scripts/pack-kernel.mjs）')
  process.exit(1)
}

const version = shards[0].version
for (const shard of shards) {
  if (shard.version !== version) {
    console.warn(`! 分片版本不一致（${version} vs ${shard.version}），以 ${version} 为准`)
  }
}

const assets = shards.map((shard) => ({
  platforms: [shard.platform],
  arch: [shard.arch],
  url: `https://github.com/${repo}/releases/download/${tag}/${shard.file}`,
  sha256: shard.sha256,
  bytes: shard.bytes,
}))

const registry = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  kernel: {
    version,
    hotVersion: shards[0].hotVersion,
    minHotVersion: options['min-hot-version'] ?? shards[0].hotVersion,
    notes: options.notes ?? null,
    assets,
  },
}
const outFile = path.join(releaseDir, 'kernel-registry.json')
fs.writeFileSync(outFile, `${JSON.stringify(registry, null, 2)}\n`)

console.log(`✓ ${path.relative(repoRoot, outFile)}（kernel ${version}，${assets.length} 个平台产物）`)
for (const asset of assets) {
  console.log(`  ${asset.platforms[0]}-${asset.arch[0]} → ${asset.url.split('/').pop()}（${(asset.bytes / 1024 / 1024).toFixed(1)} MB）`)
}

function readOptions(argv) {
  /** @type {Record<string, string>} */
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      result[key] = 'true'
      continue
    }
    result[key] = next
    index += 1
  }
  return result
}
