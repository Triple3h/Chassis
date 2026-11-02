#!/usr/bin/env node
/**
 * 变更记录（Keep a Changelog 格式，按通道分文件）：
 *   App    → CHANGELOG.md
 *   内核   → CHANGELOG-kernel.md
 *   插件   → plugins/<id>/CHANGELOG.md
 *
 * 条目来自 Conventional Commits（docs/chore/test/ci/build/style 不进）：
 *   feat → Added，fix → Fixed，perf/refactor/revert → Changed，`!` 标 BREAKING。
 *
 * 用法：
 *   node scripts/changelog.mjs write --channel plugin --id json-tools --version 0.4.2
 *   node scripts/changelog.mjs notes --channel kernel [--version 0.1.9] [--github-output notes]
 *   [--root <dir>]   # 测试用，也可以用 LAUNCHER_REPO_ROOT
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATEGORY = { feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', revert: 'Changed' }
const ORDER = ['Added', 'Changed', 'Fixed']
const CONVENTIONAL = /^(feat|fix|perf|refactor|revert|docs|test|ci|chore|build|style)(?:\(([^)]+)\))?(!)?: (.+)$/
const KEEP_A_CHANGELOG = 'https://keepachangelog.com/zh-CN/1.1.0/'

const argv = process.argv.slice(2)
const positional = []
const options = {}
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${arg} 缺少值`)
  options[arg.slice(2)] = value
  index += 1
}

const command = positional[0]
const channel = options.channel
const pluginId = options.id
const root = path.resolve(options.root ?? process.env.LAUNCHER_REPO_ROOT ?? DEFAULT_ROOT)

if (!['write', 'notes'].includes(command)) fail('用法：changelog.mjs <write|notes> --channel <app|kernel|plugin> [--id <插件>] ...')
if (!['app', 'kernel', 'plugin'].includes(channel)) fail('--channel 必须是 app / kernel / plugin')
if (channel === 'plugin' && !pluginId) fail('--channel plugin 需要 --id <插件 id>')

const version = options.version ?? readVersion()
const file = changelogFile()
if (command === 'write') {
  writeChangelog()
} else {
  emitNotes()
}

function writeChangelog() {
  const section = buildSection()
  if (!section) {
    console.log('· 没有可写入的变更（docs/chore/test/ci/build/style 不计）')
    process.exit(0)
  }
  const full = path.join(root, file)
  let text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : header()
  if (new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm').test(text)) {
    console.log(`· ${file} 已有 ${version}，跳过`)
    process.exit(0)
  }
  const first = text.search(/^## \[/m)
  text =
    first >= 0
      ? `${text.slice(0, first)}${section}\n\n${text.slice(first)}`
      : `${text.replace(/\s*$/, '')}\n\n${section}\n`
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
  console.log(`✓ ${file} ← ${version}`)
}

function emitNotes() {
  const full = path.join(root, file)
  const body = fs.existsSync(full) ? extractSection(fs.readFileSync(full, 'utf8')) : ''
  const outputName = options['github-output']
  if (!outputName) {
    if (body) console.log(body)
    return
  }
  const output = process.env.GITHUB_OUTPUT
  if (!output) fail('缺少 GITHUB_OUTPUT（--github-output 只给 GitHub Actions 用）')
  fs.appendFileSync(output, `${outputName}<<CHANGELOG_EOF\n${body}\nCHANGELOG_EOF\n`)
}

function buildSection() {
  if (options.notes) return render(['Changed'], new Map([['Changed', [options.notes.trim()]]]))

  const groups = new Map(ORDER.map((category) => [category, []]))
  for (const subject of commitSubjects()) {
    const match = subject.match(CONVENTIONAL)
    if (!match) continue
    const [, type, scope, bang, text] = match
    const category = CATEGORY[type]
    if (!category) continue
    const entry = `${bang ? '**BREAKING** ' : ''}${scope ? `**${scope}**: ` : ''}${text.trim()}`
    const list = groups.get(category)
    if (!list.includes(entry)) list.push(entry)
  }
  if (!ORDER.some((category) => groups.get(category).length)) return ''
  return render(ORDER, groups)
}

function render(categories, groups) {
  const lines = [`## [${version}] - ${today()}`, '']
  for (const category of categories) {
    const entries = groups.get(category) ?? []
    if (!entries.length) continue
    lines.push(`### ${category}`, '')
    for (const entry of entries) lines.push(`- ${entry}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function commitSubjects() {
  const baseline = releaseBaseline()
  const range = baseline ? `${baseline}..HEAD` : 'HEAD'
  return git(['log', '--no-merges', '--format=%s', range, '--', ...channelPaths()]).split('\n').filter(Boolean)
}

/** 上一次发布：优先用该通道的最后一个 tag；没有 tag 时退回「版本位点文件的上一次改动」。 */
function releaseBaseline() {
  const pattern = channel === 'plugin' ? `plugins/${pluginId}/*` : `${channel}/*`
  const tag = git(['describe', '--tags', '--abbrev=0', '--match', pattern], { allowFail: true })
  if (tag) return tag
  return git(['log', '--format=%H', '-1', '--', versionFile()], { allowFail: true }) || null
}

function channelPaths() {
  if (channel === 'app') return ['apps/shell', 'apps/launcher-ui', 'packages/ui']
  if (channel === 'kernel') return ['apps/kernel']
  return [`plugins/${pluginId}`]
}

function versionFile() {
  if (channel === 'app') return 'apps/shell/tauri.conf.json'
  if (channel === 'kernel') return 'apps/kernel/Cargo.toml'
  return `plugins/${pluginId}/package.json`
}

function changelogFile() {
  if (channel === 'app') return 'CHANGELOG.md'
  if (channel === 'kernel') return 'CHANGELOG-kernel.md'
  return `plugins/${pluginId}/CHANGELOG.md`
}

function readVersion() {
  if (channel === 'app' || channel === 'kernel') {
    return JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'))[channel]
  }
  return JSON.parse(fs.readFileSync(path.join(root, 'plugins', pluginId, 'package.json'), 'utf8')).version
}

function extractSection(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start < 0) return ''
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end).join('\n').trim()
}

function header() {
  const title = channel === 'plugin' ? `# Changelog — ${pluginId}` : '# Changelog'
  return `${title}\n\n本文件由 \`pnpm ship\` 维护，格式遵循 [Keep a Changelog](${KEEP_A_CHANGELOG})。\n\n`
}

function today() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  } catch (error) {
    if (allowFail) return ''
    throw error
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}
