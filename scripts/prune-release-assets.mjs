#!/usr/bin/env node
/**
 * 发布后清理：同一个 Release 里只保留**索引指向的最新资产**，删掉旧版本的 zip。
 *
 * 用法：node scripts/prune-release-assets.mjs --tag <tag> --registry <索引路径> [选项]
 *   --tag <tag>           固定发布 tag（app-latest / kernel-latest / plugins-latest）
 *   --registry <path>     本次刚生成的索引（app-registry.json / kernel-registry.json / registry.json）
 *   --repo <owner/repo>   Release 所在仓库（默认 $GITHUB_REPOSITORY，回落 triple3h/Chassis）
 *   --remote-list <path>  可选：用本地文件代替 `gh` 拉取远程资产名（每行一个；测试 / 离线预览用）
 *   --dry-run             只打印待清理清单，不实际删除
 *
 * 为什么必须清理：产物文件名带版本号（`<id>-<版本>-<平台>-<架构>.zip`），而
 * `action-gh-release` 的 `overwrite_files` 只覆盖**同名**文件、不删旧文件 ⇒ 每个新版本都会在
 * 同一 release 里留下一份新 zip，旧 zip 变成孤儿（索引不再指向它，但文件一直在）。
 * 单 release 上限 1000 assets（GitHub Docs），攒满后资产上传失败 = 发布中断。
 *
 * 为什么可以安全删：客户端的下载 URL 全部来自索引（每次检查更新都会重新拉取），
 * 索引里没有的 zip 没有合法消费方。
 *
 * 顺序：必须在 `action-gh-release` **之后**跑（先传新资产、再删旧资产）——反过来的话，
 * 上传失败就会把还在服务的旧资产先删掉（客户端全 404）。
 *
 * 只删 `.zip`：索引文件自身、将来可能加的 `.sig` 等其它资产一律不碰（宁愿少清、不可误删）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const options = readOptions(process.argv.slice(2))
const tag = options.tag
const registryPath = options.registry
if (!tag || !registryPath) {
  console.error('用法：node scripts/prune-release-assets.mjs --tag <tag> --registry <索引路径> [--repo <owner/repo>] [--remote-list <path>] [--dry-run]')
  process.exit(1)
}

if (!fs.existsSync(registryPath)) {
  console.error(`找不到索引：${registryPath}（先跑 gen-*-registry.mjs；清理必须依据本次索引，不能猜）`)
  process.exit(1)
}
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
const keep = collectKeepNames(registry)
if (!keep.size) {
  console.error(`索引里没有任何资产 URL（${registryPath}），拒绝清理（防止把整条 release 清空）`)
  process.exit(1)
}

const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? 'triple3h/Chassis'
const remote = options['remote-list'] ? readRemoteList(options['remote-list']) : ghAssetNames(repo, tag)
const doomed = planPrune(keep, remote)

console.log(`release ${tag}：远程资产 ${remote.length} 个，索引指向 ${keep.size} 个，待清理 ${doomed.length} 个`)
for (const name of doomed) console.log(`  - ${name}`)
if (!doomed.length) {
  console.log('✓ 没有旧资产需要清理')
  process.exit(0)
}
if (options['dry-run']) {
  console.log('（dry-run：未实际删除）')
  process.exit(0)
}

let failed = 0
for (const name of doomed) {
  try {
    execFileSync('gh', ['release', 'delete-asset', tag, name, '--repo', repo, '--yes'], { stdio: 'inherit' })
    console.log(`✓ 已删除 ${name}`)
  } catch (err) {
    failed += 1
    console.error(`✗ 删除失败 ${name}：${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(failed ? `✗ ${failed} 个旧资产删除失败` : `✓ 清理完成（删除 ${doomed.length} 个旧资产）`)
process.exit(failed ? 1 : 0)

/**
 * 索引里所有资产 URL 的文件名（保留集合）。
 * 递归收集任意层级的 `url` 字段，兼容三种索引结构：app / kernel / plugins。
 */
function collectKeepNames(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectKeepNames(item, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'url' && typeof value === 'string') {
      const name = baseName(value)
      if (name) out.add(name)
    } else {
      collectKeepNames(value, out)
    }
  }
  return out
}

/** 远程资产里该删的：`.zip` 且不在保留集合里。 */
function planPrune(keep, remoteNames) {
  return remoteNames.filter((name) => name.endsWith('.zip') && !keep.has(name))
}

function baseName(url) {
  const raw = url.split('/').pop() ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 远程资产名（两步：先取 release id，再分页拉 assets —— release 内嵌的 assets 数组可能被截断）。 */
function ghAssetNames(repo, tag) {
  const id = gh(['api', `repos/${repo}/releases/tags/${tag}`, '--jq', '.id']).trim()
  if (!id) {
    console.error(`取不到 release ${tag} 的 id（tag 不存在，或 gh 未登录 / token 无权限？）`)
    process.exit(1)
  }
  return gh(['api', '--paginate', `repos/${repo}/releases/${id}/assets?per_page=100`, '--jq', '.[].name'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const failure = err
    console.error(`gh ${args.join(' ')} 失败：${failure.stderr?.trim() ?? failure.message}`)
    process.exit(1)
  }
}

/** 本地远程资产清单：JSON 数组或每行一个名字。 */
function readRemoteList(file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text)
    return parsed.map((item) => String(item)).filter(Boolean)
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
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
