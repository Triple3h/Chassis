#!/usr/bin/env node
/**
 * 汇总各平台的打包分片 → `registry.json`（插件远程更新的索引，schema 1）。
 *
 * 用法：node scripts/gen-plugin-registry.mjs [选项]
 *   --repo <owner/repo>     Release 所在仓库（默认 triple3h/Chassis）
 *   --tag <tag>             固定发布 tag（默认 plugins-latest）
 *   --min-kernel <version>  可选：低于此内核版本不提示更新
 *   --notes <文本>          可选：更新说明（展示在更新页）
 *
 * 输入：plugins/release/shard-<platform>-<arch>.json（各平台由 pack-plugins.mjs 产出）
 * 输出：plugins/release/registry.json
 *
 * 索引里**不含** essential 出厂插件（pack-plugins 已跳过），也不含任何签名 —— v1 的信任模型是
 * 「固定仓库 + HTTPS + sha256」（见 docs/plugin-spec.md 附录 C）；`sig` 字段是后续版本的预留位。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(repoRoot, 'plugins', 'release')

const options = readOptions(process.argv.slice(2))
const repo = options.repo ?? 'triple3h/Chassis'
const tag = options.tag ?? 'plugins-latest'
const minKernel = options['min-kernel'] ?? null
const notes = options.notes ?? null

const shards = fs
  .readdirSync(releaseDir)
  .filter((name) => name.startsWith('shard-') && name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(releaseDir, name), 'utf8')))

if (!shards.length) {
  console.error('没有分片（先跑 node scripts/pack-plugins.mjs）')
  process.exit(1)
}

/** @type {Record<string, any>} */
const plugins = {}
for (const shard of shards) {
  for (const [id, entry] of Object.entries(shard.plugins ?? {})) {
    const existing = plugins[id]
    const asset = {
      platforms: [shard.platform],
      arch: [shard.arch],
      url: `https://github.com/${repo}/releases/download/${tag}/${entry.file}`,
      sha256: entry.sha256,
      bytes: entry.bytes,
    }
    if (!existing) {
      plugins[id] = {
        title: entry.title,
        version: entry.version,
        apiVersion: entry.apiVersion,
        minKernel,
        notes,
        assets: [asset],
      }
      continue
    }
    if (existing.version !== entry.version) {
      console.warn(`! ${id}：分片版本不一致（${existing.version} vs ${entry.version}），以 ${existing.version} 为准`)
    }
    existing.assets.push(asset)
  }
}

const registry = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  plugins,
}
const outFile = path.join(releaseDir, 'registry.json')
fs.writeFileSync(outFile, `${JSON.stringify(registry, null, 2)}\n`)

const ids = Object.keys(plugins).sort()
console.log(`✓ ${path.relative(repoRoot, outFile)}（${ids.length} 个插件 / ${shards.length} 个平台分片）`)
for (const id of ids) {
  console.log(`  ${id} ${plugins[id].version} → ${plugins[id].assets.map((asset) => asset.platforms[0]).join(', ')}`)
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
