#!/usr/bin/env node
/**
 * Gitee 镜像同步：把本次发布的「索引 + zip」同步到 Gitee 固定 tag 的 Release（国内下载源）。
 *
 * 用法：
 *   node scripts/sync-release-to-gitee.mjs --tag <tag> --dir <目录> [选项]
 *   node scripts/sync-release-to-gitee.mjs --tag <tag> --dir <目录> --remote-list <清单>   # 离线预览删除计划
 *
 *   --tag <tag>          固定发布 tag（app-latest / kernel-latest / plugins-latest；与 GitHub 同名）
 *   --dir <path>         本次产物目录（app/release / kernel/release / plugins/release）
 *   --registry <path>    本次索引（默认在 --dir 里找 registry.json / *-registry.json）
 *   --repo <owner/repo>  Gitee 仓库（默认 $GITEE_REPO，回落 triple3h/Chassis）
 *   --token <token>      Gitee 私人令牌（默认 $GITEE_TOKEN）；**都没有则跳过，不算失败**
 *   --remote-list <path> 离线预览：用本地清单（JSON 数组或每行一个名字）代替远程附件表
 *   --dry-run            只打印计划，不碰 Gitee
 *
 * 为什么：客户端内置源指向 GitHub，国内直连慢 / 不通。Gitee 的 Release 附件**免登录直链**，
 * 且 URL 形态与 GitHub 完全一致（`releases/download/<tag>/<file>`，2026-09-20 实测）——
 * 客户端只需把下载域名换成 gitee.com 即可命中同名文件。
 *
 * 删除策略与 GitHub 侧 prune 同构（**按索引保留**，不是「全删再传」）：
 *   待删 = 远程附件中「本次要上传的同名文件（覆盖对象）」或「`.zip` 且不在索引保留集里」。
 * 为什么不全删：plugins 通道支持**增量发布**（`-f plugins=<id>`，索引经 `--merge-registry`
 * 合并成全量）—— 全删会把本次没重发的插件包一起删掉（其他插件的更新立刻 404）。
 * 为什么必须删：Gitee 普通仓库附件总量 1GB（仓库附件 + 发行版附件共用），zip 文件名带版本号，
 * 不清理每发一版都净增一份（与 GitHub 侧同一个理由）。
 *
 * 失败不阻塞发布：workflow 里这步 continue-on-error —— Gitee 挂了主通道仍然可用。
 */
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://gitee.com/api/v5'
/// 匿名限流实测存在（连续请求会 403 Rate Limit Exceeded）⇒ 串行 + 固定间隔 + 退避重试
const REQUEST_INTERVAL_MS = 800
const RETRY_DELAYS_MS = [2000, 5000, 10000]

const options = readOptions(process.argv.slice(2))
const tag = options.tag
const dir = options.dir
if (!tag || !dir) {
  console.error(
    '用法：node scripts/sync-release-to-gitee.mjs --tag <tag> --dir <目录> [--registry <索引>] [--repo <owner/repo>] [--token <令牌>] [--remote-list <清单>] [--dry-run]'
  )
  process.exit(1)
}
if (!fs.existsSync(dir)) {
  console.error(`找不到产物目录：${dir}`)
  process.exit(1)
}

const repo = options.repo ?? process.env.GITEE_REPO ?? 'triple3h/Chassis'
const token = options.token ?? process.env.GITEE_TOKEN ?? ''
const files = collectFiles(dir)
if (!files.length) {
  console.error(`产物目录里没有可同步的文件：${dir}`)
  process.exit(1)
}

// 保留集 = 本次文件 ∪ 索引指向的资产（索引合并过上一版 ⇒ 未重发的插件也在里面）
const registryPath = options.registry ?? findRegistry(dir)
const keep = new Set(files)
if (registryPath) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  for (const name of collectKeepNames(registry)) keep.add(name)
} else {
  console.warn(`目录里没有索引文件（${dir}），按「只保留本次文件」处理`)
}

console.log(`Gitee 镜像同步：${repo} → tag ${tag}`)
console.log(`  索引 ${registryPath ?? '（未找到）'}：保留集 ${keep.size} 项，待上传 ${files.length} 个文件`)
for (const name of files) console.log(`  + ${name}`)

if (options['remote-list']) {
  const remote = readRemoteList(options['remote-list'])
  const doomed = planDelete(files, keep, remote)
  console.log(`（离线预览：远程 ${remote.length} 个附件，待删除 ${doomed.length} 个，保留 ${remote.length - doomed.length} 个）`)
  for (const name of doomed) console.log(`  - ${name}`)
  process.exit(0)
}

if (options['dry-run']) {
  console.log('（dry-run：未实际同步）')
  process.exit(0)
}
if (!token) {
  console.log('未配置 GITEE_TOKEN（仓库 secret 或 --token），跳过 Gitee 同步')
  process.exit(0)
}

const release = await ensureRelease()
const remote = await apiJson(`/repos/${repo}/releases/${release.id}/attach_files`)
const doomed = new Set(planDelete(files, keep, remote.map((file) => file.name)))
for (const file of remote) {
  if (!doomed.has(file.name)) continue
  await api(`/repos/${repo}/releases/${release.id}/attach_files/${file.id}`, { method: 'DELETE' })
  console.log(`✓ 已删除旧附件 ${file.name}`)
}
for (const name of files) {
  const local = path.join(dir, name)
  const uploaded = await upload(release.id, local, name)
  const size = fs.statSync(local).size
  if (uploaded?.size !== size) {
    console.error(`✗ 附件大小不符：${name} 本地 ${size} / 远端 ${uploaded?.size}`)
    process.exit(1)
  }
  console.log(`✓ 已上传 ${name}（${size} 字节）`)
}
console.log(`✓ Gitee 同步完成：https://gitee.com/${repo}/releases/tag/${tag}`)

/** 确保 release 存在（按 tag 找；找不到就建，tag 指向仓库默认分支）。 */
async function ensureRelease() {
  const list = await apiJson(`/repos/${repo}/releases?per_page=100`)
  const found = list.find((item) => item.tag_name === tag)
  if (found) return found
  const { default_branch: branch } = await apiJson(`/repos/${repo}`)
  console.log(`release ${tag} 不存在，创建（target_commitish=${branch}）`)
  return apiJson(`/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      target_commitish: branch,
      body: '国内下载镜像：内容由 GitHub Actions 自动同步，与 GitHub 侧同名同版本（客户端只需把下载域名换成 gitee.com）。',
    }),
  })
}

async function upload(releaseId, filePath, name) {
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(filePath)]), name)
  return apiJson(`/repos/${repo}/releases/${releaseId}/attach_files`, { method: 'POST', body: form })
}

/** 待删：本次要覆盖的同名文件 + 不在保留集里的 `.zip`（索引文件与将来可能的其它格式一律不碰）。 */
function planDelete(files, keep, remoteNames) {
  return remoteNames.filter((name) => files.includes(name) || (name.endsWith('.zip') && !keep.has(name)))
}

/** 索引里所有资产 URL 的文件名（与 prune-release-assets.mjs 同款递归，兼容三种索引结构）。 */
function collectKeepNames(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectKeepNames(item, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'url' && typeof value === 'string') {
      const raw = value.split('/').pop() ?? ''
      if (raw) out.add(decodeURIComponent(raw))
    } else {
      collectKeepNames(value, out)
    }
  }
  return out
}

/** 待同步文件：目录下的普通文件，跳过隐藏文件（.DS_Store）与分片（打包中间产物，索引生成后即作废）。 */
function collectFiles(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => !name.startsWith('.') && !name.includes('shard-'))
    .filter((name) => fs.statSync(path.join(directory, name)).isFile())
    .sort()
}

function findRegistry(directory) {
  const candidates = fs.readdirSync(directory).filter((name) => name === 'registry.json' || name.endsWith('-registry.json'))
  return candidates.length ? path.join(directory, candidates[0]) : null
}

/** 本地远程附件清单：JSON 数组或每行一个名字（离线预览 / 测试用）。 */
function readRemoteList(file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  if (text.startsWith('[')) return JSON.parse(text).map((item) => String(item))
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function apiJson(pathname, init = {}) {
  const res = await api(pathname, init)
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`响应不是 JSON（${pathname}）：${text.slice(0, 200)}`)
  }
}

async function api(pathname, init = {}, attempt = 0) {
  await sleep(REQUEST_INTERVAL_MS)
  let res
  try {
    res = await fetch(`${API}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(300_000),
    })
  } catch (err) {
    if (attempt < RETRY_DELAYS_MS.length) {
      const wait = RETRY_DELAYS_MS[attempt]
      console.warn(`网络错误，${wait}ms 后重试：${pathname}（${err instanceof Error ? err.message : err}）`)
      await sleep(wait)
      return api(pathname, init, attempt + 1)
    }
    throw err
  }
  if (res.ok) return res
  const body = await res.text().catch(() => '')
  // 403 在 Gitee 既可能是权限不足也可能是限流（实测 `403 Rate Limit Exceeded`），重试几次再放弃
  const retryable = res.status === 403 || res.status === 429 || res.status >= 500
  if (retryable && attempt < RETRY_DELAYS_MS.length) {
    const wait = RETRY_DELAYS_MS[attempt]
    console.warn(`HTTP ${res.status}（疑似限流），${wait}ms 后重试：${pathname}`)
    await sleep(wait)
    return api(pathname, init, attempt + 1)
  }
  throw new Error(`请求失败 HTTP ${res.status}：${pathname} ${body.slice(0, 300)}`)
}

/// 注意用函数声明：顶层 await 早于 `const` 初始化执行，箭头函数会撞 TDZ（实测踩过）
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
