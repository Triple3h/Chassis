/**
 * 发布 tag 解析（scripts/lib/release-tag.mjs + scripts/release-tag.mjs）。
 *
 * 两个用途：
 *   ① `plugins-release.yml` 在 tag 触发时靠它决定打包哪些插件；
 *   ② `pnpm ship` 用同一套约定拼 tag —— 两边写歪一边，客户端就会收不到更新。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'release-tag.mjs')

function parse(tag: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, '--tag', tag, '--print'], { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

function githubOutput(tag: string): { status: number; output: string; stderr: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'))
  const file = path.join(root, 'out')
  fs.writeFileSync(file, '')
  const result = spawnSync(process.execPath, [script, '--github-output'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: file },
  })
  return { status: result.status ?? 1, output: fs.readFileSync(file, 'utf8'), stderr: result.stderr }
}

test('tag 形状：kernel / app 带版本', () => {
  const kernel = parse('kernel/0.1.9')
  assertEqual(kernel.status, 0, kernel.stderr)
  assertEqual(JSON.parse(kernel.stdout).channel, 'kernel')
  assertEqual(JSON.parse(kernel.stdout).version, '0.1.9')

  const app = parse('app/0.1.12')
  assertEqual(JSON.parse(app.stdout).channel, 'app')
  assertEqual(JSON.parse(app.stdout).version, '0.1.12')
})

test('tag 形状：插件增量发布与全量发布', () => {
  const single = parse('plugins/json-tools/0.4.1')
  assertEqual(single.status, 0, single.stderr)
  assertEqual(JSON.parse(single.stdout).plugins.join(' '), 'json-tools')

  const all = parse('plugins/all/2026-11-02')
  assertEqual(all.status, 0, all.stderr)
  assertEqual(JSON.parse(all.stdout).plugins.length, 0, 'plugins/all ⇒ 空列表 = 全部')
})

test('tag 不合法：缺版本 / 未知前缀 / 非法插件 id', () => {
  assert(parse('plugins/json-tools').status !== 0, '缺版本必须拒绝')
  assert(parse('v0.1.0').status !== 0, '未知前缀必须拒绝')
  assert(parse('plugins/../x/0.1.0').status !== 0, '带路径的插件 id 必须拒绝')
})

test('--github-output：版本与仓库一致时写出插件名', () => {
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugins', 'json-tools', 'package.json'), 'utf8')).version
  const result = githubOutput(`plugins/json-tools/${version}`)
  assertEqual(result.status, 0, result.stderr)
  assertEqual(result.output.trim(), 'plugins=json-tools')
})

test('--github-output：tag 版本与 package.json 不一致时明确报错', () => {
  const result = githubOutput('plugins/json-tools/9.9.9')
  assert(result.status !== 0, '版本不一致必须拒绝')
  assert(result.stderr.includes('不一致'), `应提示版本不一致：${result.stderr}`)
})

run()
