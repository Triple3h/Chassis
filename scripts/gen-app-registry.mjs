#!/usr/bin/env node
/**
 * 汇总各平台的应用打包分片 → `app-registry.json`（应用自更新的索引，schema 1）。
 *
 * 用法：node scripts/gen-app-registry.mjs [选项]
 *   --repo <owner/repo>              Release 所在仓库（默认 triple3h/Chassis）
 *   --tag <tag>                      固定发布 tag（默认 app-latest）
 *   --min-shell-hot-version <版本>   可选：客户端壳自更新机制低于此版本不提示（默认取产物自报）
 *   --notes <文本>                   可选：更新说明
 *   --release-dir <目录>             分片与索引所在目录（默认 app/release；测试用临时目录）
 *
 * 输入：<release-dir>/app-shard-<平台>-<架构>.json（pack-app.mjs 产出；当前平台集 = macos / windows）
 * 输出：<release-dir>/app-registry.json
 *
 * 与另外两条通道**完全独立**：App 的 `v*` 是给人下载的换包通道、插件用 `plugins-latest`、
 * 内核用 `kernel-latest`、应用自更新用 `app-latest` —— 四个 tag 互不干扰。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const options = readOptions(process.argv.slice(2))
const repo = options.repo ?? 'triple3h/Chassis'
const tag = options.tag ?? 'app-latest'
const releaseDir = path.resolve(repoRoot, options['release-dir'] ?? path.join('app', 'release'))

const shards = fs
  .readdirSync(releaseDir)
  .filter((name) => name.startsWith('app-shard-') && name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(releaseDir, name), 'utf8')))

if (!shards.length) {
  console.error('没有分片（先跑 node scripts/pack-app.mjs）')
  process.exit(1)
}

const version = shards[0].version
for (const shard of shards) {
  if (shard.version !== version) {
    console.warn(`! 分片版本不一致（${version} vs ${shard.version}），以 ${version} 为准`)
  }
  // 机制版本两端必须一样（同一份壳代码）：不一致 = 有一个平台的包打晚了，客户端会被 minShellHotVersion 挡下
  if (shard.shellHotVersion !== shards[0].shellHotVersion) {
    console.warn(`! ${shard.platform} 分片的 shellHotVersion 与首个分片不一致（${shards[0].shellHotVersion} vs ${shard.shellHotVersion}）`)
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
  app: {
    version,
    shellHotVersion: shards[0].shellHotVersion,
    minShellHotVersion: options['min-shell-hot-version'] ?? shards[0].shellHotVersion,
    notes: options.notes ?? null,
    assets,
  },
}
const outFile = path.join(releaseDir, 'app-registry.json')
fs.writeFileSync(outFile, `${JSON.stringify(registry, null, 2)}\n`)

console.log(`✓ ${path.relative(repoRoot, outFile)}（app ${version}，${assets.length} 个平台产物）`)
for (const asset of assets) {
  console.log(
    `  ${asset.platforms[0]}-${asset.arch[0]} → ${asset.url.split('/').pop()}（${(asset.bytes / 1024 / 1024).toFixed(1)} MB）`,
  )
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
