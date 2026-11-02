/**
 * CHANGELOG 生成（scripts/changelog.mjs）：按通道从 Conventional Commits 取条目，
 * `pnpm ship` 与发布 workflow 共用同一份文件。
 *
 * 用临时 git 仓库验证真实行为：tag 作为基线、chore/docs 过滤、notes 提取与幂等。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'changelog.mjs')

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
  }).trim()
}

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function commit(root: string, message: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content)
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', message])
}

function changelog(root: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

test('write：tag 之后按类型分组，chore / 路径外提交不进 changelog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-tag-'))
  git(root, ['init'])
  commit(root, 'chore: init', { 'plugins/demo/package.json': JSON.stringify({ version: '0.1.0' }) })
  git(root, ['tag', 'plugins/demo/0.1.0'])

  commit(root, 'feat(ui): 增加拖动', { 'plugins/demo/src/a.ts': 'a' })
  commit(root, 'fix: 修复边界', { 'plugins/demo/src/b.ts': 'b' })
  commit(root, 'chore: 杂项', { 'plugins/demo/src/c.ts': 'c' })
  commit(root, 'feat: 文档功能', { 'docs/readme.md': 'x' })

  const result = changelog(root, ['write', '--channel', 'plugin', '--id', 'demo', '--version', '0.2.0'])
  assertEqual(result.status, 0, result.stderr)

  const text = fs.readFileSync(path.join(root, 'plugins/demo/CHANGELOG.md'), 'utf8')
  assert(/^## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}$/m.test(text), text)
  assert(text.includes('### Added'), text)
  assert(text.includes('- **ui**: 增加拖动'), text)
  assert(text.includes('### Fixed'), text)
  assert(text.includes('- 修复边界'), text)
  assert(!text.includes('杂项'), 'chore 不应进 changelog')
  assert(!text.includes('文档功能'), '路径外的提交不应进 changelog')
  assert(text.indexOf('### Added') < text.indexOf('### Fixed'), '分组顺序应为 Added → Changed → Fixed')

  const again = changelog(root, ['write', '--channel', 'plugin', '--id', 'demo', '--version', '0.2.0'])
  assertEqual(again.status, 0, again.stderr)
  const after = fs.readFileSync(path.join(root, 'plugins/demo/CHANGELOG.md'), 'utf8')
  assertEqual(after.split('## [0.2.0]').length - 1, 1, '重复写入不应生成第二个段落')
})

test('write：没有 tag 时以上一次的版本位点改动为基线（首个版本）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-first-'))
  git(root, ['init'])
  commit(root, 'chore: init', { 'plugins/demo/package.json': JSON.stringify({ version: '0.1.0' }) })
  commit(root, 'feat: 初始功能', { 'plugins/demo/src/a.ts': 'a' })

  const result = changelog(root, ['write', '--channel', 'plugin', '--id', 'demo', '--version', '0.1.1'])
  assertEqual(result.status, 0, result.stderr)
  const text = fs.readFileSync(path.join(root, 'plugins/demo/CHANGELOG.md'), 'utf8')
  assert(text.includes('- 初始功能'), text)
})

test('notes：只输出该版本段落，并支持 --github-output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-notes-'))
  git(root, ['init'])
  commit(root, 'chore: init', { 'plugins/demo/package.json': JSON.stringify({ version: '0.1.0' }) })
  git(root, ['tag', 'plugins/demo/0.1.0'])
  commit(root, 'feat: 新能力', { 'plugins/demo/src/a.ts': 'a' })
  changelog(root, ['write', '--channel', 'plugin', '--id', 'demo', '--version', '0.2.0'])

  const plain = changelog(root, ['notes', '--channel', 'plugin', '--id', 'demo', '--version', '0.2.0'])
  assertEqual(plain.status, 0, plain.stderr)
  assert(plain.stdout.includes('- 新能力'), plain.stdout)
  assert(!plain.stdout.includes('## [0.2.0]'), 'notes 不应带版本标题')

  const output = path.join(root, 'github-output')
  fs.writeFileSync(output, '')
  const withOutput = changelog(
    root,
    ['notes', '--channel', 'plugin', '--id', 'demo', '--version', '0.2.0', '--github-output', 'notes'],
    { GITHUB_OUTPUT: output },
  )
  assertEqual(withOutput.status, 0, withOutput.stderr)
  const written = fs.readFileSync(output, 'utf8')
  assert(written.includes('notes<<CHANGELOG_EOF'), written)
  assert(written.includes('- 新能力'), written)
})

run()
