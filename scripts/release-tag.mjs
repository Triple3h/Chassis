#!/usr/bin/env node
/**
 * 发布 tag 解析（`plugins-release.yml` 在 tag 触发时用它决定打包哪些插件）。
 *
 *   node scripts/release-tag.mjs --tag plugins/json-tools/0.4.1 --print   # 只解析，给测试/排查用
 *   node scripts/release-tag.mjs --github-output                          # Actions：读 GITHUB_REF_NAME，
 *                                                                         # 校验版本后写 plugins=<列表>
 *
 * 版本必须与仓库里的一致：tag 写错时宁可红，也不要发出一个版本号对不上的包。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReleaseTag } from './lib/release-tag.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const tagIndex = args.indexOf('--tag')
const ref = tagIndex >= 0 ? args[tagIndex + 1] : process.env.GITHUB_REF_NAME ?? ''
const parsed = parseReleaseTag(ref)
if (parsed.error) fail(parsed.error)

if (args.includes('--print')) {
  console.log(JSON.stringify(parsed))
  process.exit(0)
}

if (parsed.channel !== 'plugins') fail(`plugins-release 只接受 plugins/* tag（收到 ${ref}）`)
const expected = expectedVersion(parsed)
if (parsed.version && expected && parsed.version !== expected) {
  fail(`tag 版本 ${parsed.version} 与仓库里的 ${expected} 不一致：先 bump 再打 tag`)
}

const output = process.env.GITHUB_OUTPUT
if (!output) fail('缺少 GITHUB_OUTPUT（--github-output 只给 GitHub Actions 用）')
fs.appendFileSync(output, `plugins=${(parsed.plugins ?? []).join(' ')}\n`)

function expectedVersion(tag) {
  if (tag.plugins?.length) {
    const file = path.join(repoRoot, 'plugins', tag.plugins[0], 'package.json')
    if (!fs.existsSync(file)) fail(`插件不存在：${tag.plugins[0]}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')).version
  }
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'))[tag.channel] ?? null
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}
