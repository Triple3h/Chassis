#!/usr/bin/env node
/**
 * 把一条自更新通道的产物 + 签名索引发布到 npm（客户端从 registry.npmmirror.com 读取）。
 *
 * 用法：node scripts/publish-npm.mjs --channel app|kernel|plugins --dir <产物目录> [选项]
 *
 *   --channel <通道>          app / kernel / plugins（必填）
 *   --dir <目录>              产物目录（默认 app/release | kernel/release | plugins/release）
 *   --registry <文件>         索引文件（默认在 --dir 里按通道找）
 *   --dry-run                 只准备与打印，不调用 npm（也不查 npm 上是否已有版本）
 *   --staging <目录>          暂存目录（默认系统临时目录，成功后删除）
 *   --index-version <x.y.z>   索引包版本（默认 0.<yyyymmdd>.<epoch 秒>）
 *   --configure-trust         只配置 npm trusted publishing（npm trust github），不发布
 *   --repo <owner/repo>       GitHub 仓库（默认 Triple3h/Chassis）
 *   --workflow <文件>         workflow 文件名（按通道默认）
 *
 * 环境变量：
 *   NODE_AUTH_TOKEN / NPM_TOKEN   npmjs 发布令牌（bootstrap 阶段；配好 trusted publishing 后可去掉）
 *   INDEX_SIGNING_KEY             ed25519 私钥（base64 PKCS#8），用 scripts/make-index-key.mjs 生成
 *
 * 顺序固定：**产物包先、索引最后** —— 索引一落地，它指向的包就必须已经存在。
 * 索引是第三方通道（npmmirror）的信任根，必须签名；详见 docs/plugin-spec.md 附录 C。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildArtifactManifest,
  buildIndexManifest,
  indexPackageName,
  indexVersion,
  loadSigningKey,
  NPM_PUBLISH_REGISTRY,
  planRegistryForNpm,
  signRegistry,
  tarballUrl,
} from './lib/npm-packages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = readOptions(process.argv.slice(2))
const channel = options.channel
const dryRun = options['dry-run'] === 'true'
const configureTrust = options['configure-trust'] === 'true'
const repo = options.repo ?? 'Triple3h/Chassis'

if (!['app', 'kernel', 'plugins'].includes(channel)) {
  fail('用法：node scripts/publish-npm.mjs --channel app|kernel|plugins --dir <产物目录> [--dry-run]')
}

const defaultDirs = { app: 'app/release', kernel: 'kernel/release', plugins: 'plugins/release' }
const defaultWorkflows = {
  app: 'app-release.yml',
  kernel: 'kernel-release.yml',
  plugins: 'plugins-release.yml',
}
const dir = path.resolve(repoRoot, options.dir ?? defaultDirs[channel])
const workflow = options.workflow ?? defaultWorkflows[channel]
const registryPath = options.registry ? path.resolve(options.registry) : findRegistry(dir, channel)

if (!fs.existsSync(registryPath)) fail(`找不到索引：${registryPath}`)

let registry
try {
  registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
} catch (err) {
  fail(`索引无法解析：${registryPath}（${err instanceof Error ? err.message : err}）`)
}
if (registry.schema !== 1) fail(`索引 schema 不是 1：${registry.schema}`)

let plan
try {
  plan = planRegistryForNpm(channel, registry)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

if (configureTrust) {
  configureTrustedPublishing()
  process.exit(0)
}

let signingKey
try {
  signingKey = loadSigningKey(process.env.INDEX_SIGNING_KEY)
} catch (err) {
  fail(`${err instanceof Error ? err.message : err}（用 node scripts/make-index-key.mjs 生成，存成仓库 secret INDEX_SIGNING_KEY）`)
}
const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || ''
const temporaryStaging = !options.staging
const staging = options.staging ? path.resolve(options.staging) : fs.mkdtempSync(path.join(os.tmpdir(), 'chassis-npm-'))
fs.mkdirSync(staging, { recursive: true })
const authConfig = writeAuthConfig(staging, token)

try {
  const tasks = planArtifacts(plan.packages)
  const indexVersionValue = options['index-version'] ?? indexVersion()

  console.log(`npm 通道：${channel} → ${indexPackageName(channel)}`)
  console.log(`  索引：${path.relative(repoRoot, registryPath)}`)
  console.log(`  本地产物：${tasks.length} 个包，${tasks.reduce((sum, task) => sum + task.files.length, 0)} 个 zip`)
  if (dryRun) console.log('  dry-run：不调用 npm、不检查远端版本')

  // 1) 产物包：版本已存在则跳过（幂等重跑）；存在但本地 zip 变了只能升版本，不能覆盖 npm 版本
  for (const task of tasks) {
    if (!dryRun && npmVersionExists(task.packageName, task.version)) {
      console.log(`  - 跳过 ${task.packageName}@${task.version}（npm 上已存在；产物有变请升版本）`)
      continue
    }
    const packageDir = stageArtifact(task)
    if (dryRun) {
      console.log(`  [dry-run] ${task.packageName}@${task.version} ← ${task.files.join(', ')}`)
      continue
    }
    publishPackage(packageDir)
    console.log(`  ✓ ${task.packageName}@${task.version}（${task.files.length} 个文件）`)
  }

  // 2) 索引包：永远是一个新版本（索引本身就是「最新指向」）
  const registryText = JSON.stringify(plan.registry, null, 2)
  const { sig, keyId } = signRegistry(registryText, signingKey)
  const indexManifest = buildIndexManifest({
    channel,
    version: indexVersionValue,
    registryText,
    signature: sig,
    keyId,
  })
  if (!dryRun && npmVersionExists(indexManifest.name, indexManifest.version)) {
    fail(`索引版本已存在：${indexManifest.name}@${indexManifest.version}（换一个 --index-version 或等下一秒重试）`)
  }
  const indexDir = stagePackage(indexManifest.name, indexManifest, [])
  if (dryRun) {
    console.log(`  [dry-run] ${indexManifest.name}@${indexManifest.version}（sig ${sig.slice(0, 12)}…，keyId ${keyId}）`)
  } else {
    publishPackage(indexDir)
    console.log(`  ✓ ${indexManifest.name}@${indexManifest.version}（sig keyId ${keyId}）`)
  }

  console.log('\n客户端读取地址：')
  for (const pkg of plan.packages) {
    console.log(`  ${tarballUrl(pkg.packageName, pkg.version)}`)
  }
  console.log(`  ${indexPackageName(channel)}/latest → chassis.registry（验签后使用）`)
  if (dryRun) console.log(`\n暂存目录：${staging}`)
} finally {
  if (authConfig) fs.rmSync(authConfig, { force: true })
  if (temporaryStaging) fs.rmSync(staging, { recursive: true, force: true })
}

/** 本地产物 → 要发布的包。索引里有、本地没有的包跳过（增量发布时未重建的插件）；只补一半平台则拒绝。 */
function planArtifacts(packages) {
  const localZips = new Set(
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.zip'))
      .filter((name) => fs.statSync(path.join(dir, name)).isFile()),
  )

  if (channel === 'app' || channel === 'kernel') {
    const tasks = []
    for (const pkg of packages) {
      const missing = pkg.assets.map((asset) => asset.file).filter((file) => !localZips.has(file))
      if (missing.length) fail(`${pkg.packageName} 缺少本地产物：${missing.join(', ')}（两个平台必须一起发）`)
      tasks.push({
        packageName: pkg.packageName,
        version: pkg.version,
        files: pkg.assets.map((asset) => asset.file),
        os: pkg.assets[0].platform,
        arch: pkg.assets[0].arch,
      })
    }
    return tasks
  }

  const tasks = []
  const used = new Set()
  for (const pkg of packages) {
    const present = pkg.assets.filter((asset) => localZips.has(asset.file))
    if (!present.length) continue
    if (present.length !== pkg.assets.length) {
      fail(
        `${pkg.packageName}：索引里有 ${pkg.assets.length} 个平台资产，本地只有 ${present.length} 个` +
          '（npm 版本不能补平台，请升版本后全平台重发）',
      )
    }
    for (const asset of present) used.add(asset.file)
    tasks.push({ packageName: pkg.packageName, version: pkg.version, files: present.map((asset) => asset.file) })
  }

  // 首次发布 npm 插件索引必须全量：未重建的插件此前没进过 npm，索引会指向不存在的包
  if (!dryRun && !npmVersionExists(indexPackageName('plugins'), null, { anyVersion: true })) {
    const missing = packages.filter((pkg) => !tasks.some((task) => task.packageName === pkg.packageName))
    if (missing.length) {
      fail(
        `首次发布 npm 插件索引必须全量：缺 ${missing.map((pkg) => pkg.packageName).join(', ')} 的本地产物` +
          '（先发一次 plugins/all）',
      )
    }
  }

  const unused = [...localZips].filter((file) => !used.has(file))
  if (unused.length) console.warn(`  ! 有 ${unused.length} 个本地 zip 不在索引里，已忽略：${unused.join(', ')}`)
  return tasks
}

function stageArtifact(task) {
  const manifest = buildArtifactManifest({
    channel,
    packageName: task.packageName,
    version: task.version,
    platform: task.os,
    arch: task.arch,
  })
  return stagePackage(task.packageName, manifest, task.files)
}

/** 暂存目录名去掉 `@` 与 `/`，保持可读（`@triple3h/x` → `triple3h-x`）。 */
function stagePackage(packageName, manifest, files) {
  const target = path.join(staging, packageName.replace(/^@/, '').replace(/[\\/]/g, '-'))
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const file of files) {
    fs.copyFileSync(path.join(dir, file), path.join(target, file))
  }
  return target
}

function publishPackage(packageDir) {
  const args = ['publish', '--registry', NPM_PUBLISH_REGISTRY, '--access', 'public']
  if (authConfig) args.push('--userconfig', authConfig)
  execFileSync('npm', args, {
    cwd: packageDir,
    stdio: 'inherit',
    env: { ...process.env, ...(token ? { NODE_AUTH_TOKEN: token } : {}) },
  })
}

/** npm 上是否有这个版本。`anyVersion` 时只看包是否存在。 */
function npmVersionExists(packageName, version, { anyVersion = false } = {}) {
  const spec = anyVersion ? packageName : `${packageName}@${version}`
  try {
    execFileSync('npm', ['view', spec, 'version', '--registry', NPM_PUBLISH_REGISTRY], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return true
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`
    if (/E404|404 Not Found|No matching version|is not in this registry|not found/i.test(output)) return false
    throw new Error(`查询 npm 失败（${spec}）：${output.trim().slice(0, 400)}`)
  }
}

function writeAuthConfig(stagingDir, tokenValue) {
  if (!tokenValue) return null
  const file = path.join(stagingDir, '.npmrc')
  fs.writeFileSync(file, `//registry.npmjs.org/:_authToken=${tokenValue}\n`, { mode: 0o600 })
  return file
}

/** bootstrap 之后一次性把每个包绑定到本仓库的 workflow，随后即可删掉 NPM_TOKEN 改走 OIDC。 */
function configureTrustedPublishing() {
  const packageNames = [...plan.packages.map((pkg) => pkg.packageName), indexPackageName(channel)]
  const failures = []
  for (const packageName of packageNames) {
    const args = [
      'trust',
      'github',
      packageName,
      '--file',
      workflow,
      '--repo',
      repo,
      '--allow-publish',
      '-y',
    ]
    if (dryRun) {
      console.log(`npm ${args.join(' ')}`)
      continue
    }
    try {
      execFileSync('npm', args, { stdio: 'inherit' })
      console.log(`  ✓ ${packageName}`)
    } catch {
      failures.push(packageName)
    }
  }
  if (failures.length) {
    console.error(`\n✗ ${failures.length} 个包配置失败（包必须先发布过一次）：${failures.join(', ')}`)
    process.exit(1)
  }
  console.log(`\n✓ ${packageNames.length} 个包已绑定 ${repo} / ${workflow}`)
}

function findRegistry(directory, targetChannel) {
  const names =
    targetChannel === 'plugins' ? ['registry.json'] : [`${targetChannel}-registry.json`]
  for (const name of names) {
    const candidate = path.join(directory, name)
    if (fs.existsSync(candidate)) return candidate
  }
  fail(`在 ${directory} 里找不到 ${names.join(' / ')}`)
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

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}
