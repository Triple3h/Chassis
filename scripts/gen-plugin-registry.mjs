#!/usr/bin/env node
/**
 * 汇总各平台的打包分片 → `registry.json`（插件远程更新的索引，schema 1）。
 *
 * 用法：node scripts/gen-plugin-registry.mjs [选项]
 *   --repo <owner/repo>       Release 所在仓库（默认 triple3h/Chassis）
 *   --tag <tag>               固定发布 tag（默认 plugins-latest）
 *   --min-kernel <version>    可选：低于此内核版本不提示更新
 *   --notes <文本>            可选：更新说明（展示在更新页）
 *   --release-dir <路径>      分片与索引所在目录（默认 plugins/release；测试用）
 *   --merge-registry <路径>   可选：上一版 registry.json，与本次索引**合并**（见下）
 *
 * **为什么必须能合并**：只发布部分插件时（`pack-plugins.mjs <id>`，或 workflow 的 `plugins`
 * 输入）分片里只有那几个插件 —— 直接汇总会生成一份「只含这几个插件」的索引，其余插件当场
 * 从索引里消失，客户端静默不再提示更新（`internal-store` 的 `collect_updates` 对着 installed
 * 查索引，查不到就跳过）。合并规则：
 *   - 本次没打包的插件：整条沿用上一版（版本 / 说明 / 门槛 / 资产都不动）；
 *   - 本次打包的插件：版本 / 说明 / 门槛取本次，资产按平台替换；未重建的平台资产只在
 *     版本一致时沿用（版本变了就丢弃并告警 —— 宁可客户端报「无此平台产物」，也不让它按
 *     旧版本安装）；同理，上一版里**不存在**的插件（首次发布的插件）不受影响。
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

const options = readOptions(process.argv.slice(2))
const repo = options.repo ?? 'triple3h/Chassis'
const tag = options.tag ?? 'plugins-latest'
const minKernel = options['min-kernel'] ?? null
const notes = options.notes ?? null
const releaseDir = options['release-dir']
  ? path.resolve(options['release-dir'])
  : path.join(repoRoot, 'plugins', 'release')
const mergePath = options['merge-registry'] ? path.resolve(options['merge-registry']) : null

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

let resumed = 0
if (mergePath) {
  if (!fs.existsSync(mergePath)) {
    console.error(`没有上一版索引：${mergePath}（首次发布请去掉 --merge-registry）`)
    process.exit(1)
  }
  const previous = JSON.parse(fs.readFileSync(mergePath, 'utf8'))
  if (previous.schema !== 1) {
    console.error(`上一版索引 schema 不是 1：${previous.schema}`)
    process.exit(1)
  }
  for (const [id, entry] of Object.entries(previous.plugins ?? {})) {
    const fresh = plugins[id]
    if (!fresh) {
      plugins[id] = entry
      resumed += 1
      continue
    }
    const rebuilt = new Set(fresh.assets.map((asset) => asset.platforms[0]))
    const kept = (entry.assets ?? []).filter((asset) => !rebuilt.has(asset.platforms[0]))
    if (entry.version === fresh.version) {
      fresh.assets = [...fresh.assets, ...kept].sort((a, b) => a.platforms[0].localeCompare(b.platforms[0]))
    } else if (kept.length) {
      console.warn(`! ${id}：版本 ${entry.version} → ${fresh.version}，未随本次重建的平台资产已丢弃（避免客户端装到旧版本）`)
    }
  }
} else {
  console.log('说明：未合并上一版索引（--merge-registry）；全量发布可忽略，只发部分插件时必须带上')
}

const registry = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  plugins,
}
const outFile = path.join(releaseDir, 'registry.json')
fs.writeFileSync(outFile, `${JSON.stringify(registry, null, 2)}\n`)

const ids = Object.keys(plugins).sort()
const merged = mergePath ? `，沿用上一版 ${resumed} 个` : ''
console.log(`✓ ${path.relative(repoRoot, outFile)}（${ids.length} 个插件 / ${shards.length} 个平台分片${merged}）`)
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
