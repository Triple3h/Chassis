#!/usr/bin/env node
/**
 * 一键发版：bump → verify → commit → tag → 推送（默认走 SSH）。
 * tag 触发对应的发布 workflow，客户端仍从固定 tag 直链读取 —— 全程不经过 GitHub API / token。
 *
 *   pnpm ship kernel [--version x.y.z] [--skip-verify] [--dry-run]
 *   pnpm ship app    [--version x.y.z] [...]
 *   pnpm ship plugin <id> [--version x.y.z] [...]
 *
 * tag 约定见 docs/release-channels.md §1。版本已经是目标值时只打 tag、不再 bump，
 * 所以「提交已就位、只差发布」也可以用同一条命令。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tagFor } from './lib/release-tag.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+$/
const FLAGS = new Set(['--skip-verify', '--dry-run'])

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot })
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: repoRoot }).trim()
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const positional = []
let versionArg = null
let remoteArg = null
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--version') {
    versionArg = argv[++index]
    if (!versionArg) fail('--version 缺少值')
    continue
  }
  if (arg === '--remote') {
    remoteArg = argv[++index]
    if (!remoteArg) fail('--remote 缺少值')
    continue
  }
  if (arg.startsWith('--')) {
    if (!FLAGS.has(arg)) fail(`未知参数：${arg}`)
    continue
  }
  positional.push(arg)
}

const [target, pluginId] = positional
if (!['kernel', 'app', 'plugin'].includes(target)) {
  fail('用法：pnpm ship <kernel|app|plugin <id>> [--version x.y.z] [--skip-verify] [--dry-run]')
}
if (target === 'plugin' && !pluginId) fail('plugin 需要插件 id：pnpm ship plugin json-tools')

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') fail(`发布只能从 main 发（当前 ${branch}）`)

const dirty = capture('git', ['status', '--porcelain']).split('\n').filter(Boolean)
if (dirty.length) {
  console.warn(`! 工作区有 ${dirty.length} 项未提交改动，不会进入这次发布：`)
  for (const line of dirty.slice(0, 5)) console.warn(`  ${line}`)
  if (dirty.length > 5) console.warn('  …')
}

const versionFile =
  target === 'plugin' ? path.join(repoRoot, 'plugins', pluginId, 'package.json') : path.join(repoRoot, 'version.json')
if (!fs.existsSync(versionFile)) fail(`找不到 ${path.relative(repoRoot, versionFile)}`)
const manifest = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
const current = target === 'plugin' ? manifest.version : manifest[target]
if (!SEMVER.test(current ?? '')) fail(`${path.relative(repoRoot, versionFile)} 里的版本不是 x.y.z：${current}`)

const next = versionArg ?? bumpPatch(current)
if (!SEMVER.test(next)) fail(`版本必须是 x.y.z：${next}`)
const bumped = next !== current
const tag = tagFor(target === 'plugin' ? 'plugins' : target, next, pluginId)
const workflow =
  target === 'kernel' ? 'kernel-release.yml' : target === 'app' ? 'app-release.yml' : 'plugins-release.yml'
const files =
  target === 'kernel'
    ? ['version.json', 'apps/kernel/Cargo.toml', 'Cargo.lock']
    : target === 'app'
      ? ['version.json', 'apps/shell/tauri.conf.json', 'apps/shell/Cargo.toml', 'apps/shell/Cargo.lock']
      : [`plugins/${pluginId}/package.json`]

const remote = remoteArg ?? process.env.SHIP_REMOTE ?? sshRemote(capture('git', ['remote', 'get-url', 'origin']))
const actionsUrl = workflowUrl(remote, workflow)

if (FLAGS.has('--dry-run')) {
  console.log(`计划：${tag} → ${workflow}`)
  console.log(`  版本：${current}${bumped ? ` → ${next}` : '（已就位，只打 tag）'}`)
  console.log(`  远程：${remote}`)
  process.exit(0)
}

if (!FLAGS.has('--skip-verify')) {
  console.log('▶ 本地验证')
  if (target !== 'plugin') run('cargo', ['test', '--workspace'])
  run('pnpm', ['typecheck'])
  run('pnpm', ['test'])
}

if (bumped) {
  if (target === 'plugin') {
    const raw = fs.readFileSync(versionFile, 'utf8')
    fs.writeFileSync(versionFile, raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`))
  } else {
    run('node', ['scripts/version.mjs', 'set', target, next])
    run('node', ['scripts/version.mjs', 'check'])
  }
  const message =
    target === 'kernel'
      ? `chore: 版本升到 kernel ${next}`
      : target === 'app'
        ? `chore: 版本升到 app ${next}`
        : `chore: ${pluginId} 升到 ${next}`
  run('git', ['commit', '--only', '-m', message, '--', ...files])
} else {
  console.log(`· 版本已是 ${next}，跳过 bump`)
}

const existing = capture('git', ['tag', '-l', tag])
if (existing) {
  // 上次推到一半失败：只要 tag 还指向 HEAD 就复用它，方便原样重试
  if (capture('git', ['rev-list', '-n', '1', tag]) !== capture('git', ['rev-parse', 'HEAD'])) {
    fail(`tag 已存在且不指向 HEAD：${tag}`)
  }
  console.log(`· 复用本地 tag ${tag}`)
} else {
  run('git', ['tag', tag])
}

run('git', ['push', remote, 'HEAD:main'])
run('git', ['push', remote, `refs/tags/${tag}`])
console.log(`✓ 已推送 ${tag}`)
if (actionsUrl) console.log(`  workflow：${actionsUrl}`)

function bumpPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

/** 本机 HTTPS 到 GitHub 会被系统层拦截（connect: bad file descriptor），SSH 正常。 */
function sshRemote(url) {
  const match = url.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
  return match ? `git@github.com:${match[1].replace(/\.git$/, '')}.git` : url
}

function workflowUrl(url, name) {
  const match = url.match(/^(?:git@github\.com:|https?:\/\/github\.com\/)(.+?)(?:\.git)?$/)
  return match ? `https://github.com/${match[1].replace(/\.git$/, '')}/actions/workflows/${name}` : ''
}
