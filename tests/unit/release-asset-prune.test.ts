/**
 * 发布后清理（scripts/prune-release-assets.mjs）：固定 tag 的 release 里只保留**索引指向的最新 zip**。
 *
 * 背景：zip 文件名带版本号、`action-gh-release` 只覆盖同名文件 ⇒ 每发一版都会留下孤儿旧资产
 * （单 release 上限 1000 assets，攒满 = 发布中断）。守四件事：
 * ① 索引指向的新包不动、旧版本 zip 进清理计划；② 只碰 `.zip`（索引自身与将来可能加的
 * `.sig` 等一律不删）；③ 索引里没有任何资产 URL 时拒绝清理；④ 没有旧资产时幂等成功。
 *
 * 用 `--remote-list` 喂远程资产名 + `--dry-run`，全程不碰网络与真实 release。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'prune-release-assets.mjs')

/** 搭一个临时索引 + 远程清单跑脚本（dry-run）；返回值（退出码，stdout+stderr）。 */
function runPrune(input: { registry: unknown; remote: string[] }): { status: number; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prune-'))
  const registryPath = path.join(root, 'registry.json')
  fs.writeFileSync(registryPath, JSON.stringify(input.registry))
  const remotePath = path.join(root, 'remote.txt')
  fs.writeFileSync(remotePath, input.remote.join('\n'))
  const args = [
    script,
    '--tag',
    'plugins-latest',
    '--registry',
    registryPath,
    '--remote-list',
    remotePath,
    '--dry-run',
  ]
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  fs.rmSync(root, { recursive: true, force: true })
  return { status, output }
}

test('旧版本 zip 进清理计划，索引指向的最新包不动', () => {
  const url = (file: string) => `https://github.com/triple3h/Chassis/releases/download/plugins-latest/${file}`
  const { status, output } = runPrune({
    registry: {
      schema: 1,
      plugins: {
        todo: { assets: [{ url: url('todo-0.1.1-macos-arm64.zip') }, { url: url('todo-0.1.1-windows-x64.zip') }] },
      },
    },
    remote: [
      'registry.json',
      'todo-0.1.0-macos-arm64.zip',
      'todo-0.1.1-macos-arm64.zip',
      'todo-0.1.0-windows-x64.zip',
      'todo-0.1.1-windows-x64.zip',
      'snips-0.1.0-macos-arm64.zip', // 孤儿：已从索引里消失的插件
    ],
  })
  assertEqual(status, 0, `dry-run 应成功。输出：${output}`)
  for (const doomed of ['todo-0.1.0-macos-arm64.zip', 'todo-0.1.0-windows-x64.zip', 'snips-0.1.0-macos-arm64.zip']) {
    assert(output.includes(doomed), `待清理清单应含 ${doomed}。输出：${output}`)
  }
  for (const kept of ['todo-0.1.1-macos-arm64.zip', 'todo-0.1.1-windows-x64.zip']) {
    const lines = output.split('\n').filter((line) => line.trim().startsWith('- '))
    assert(!lines.some((line) => line.includes(kept)), `索引指向的 ${kept} 不得在待清理清单里。输出：${output}`)
  }
  assert(output.includes('待清理 3 个'), `应统计为 3 个。输出：${output}`)
})

test('app / kernel 索引结构（顶层 assets）：同样只清旧 zip', () => {
  const { status, output } = runPrune({
    registry: {
      schema: 1,
      app: {
        version: '0.1.3',
        assets: [{ url: 'https://github.com/triple3h/Chassis/releases/download/app-latest/Chassis-0.1.3-macos-arm64.zip' }],
      },
    },
    remote: ['app-registry.json', 'Chassis-0.1.2-macos-arm64.zip', 'Chassis-0.1.3-macos-arm64.zip'],
  })
  assertEqual(status, 0, `dry-run 应成功。输出：${output}`)
  assert(output.includes('Chassis-0.1.2-macos-arm64.zip'), `旧包应进清理计划。输出：${output}`)
  assert(!output.includes('- Chassis-0.1.3-macos-arm64.zip'), `最新包不得进清理计划。输出：${output}`)
  assert(output.includes('待清理 1 个'), `应统计为 1 个。输出：${output}`)
})

test('只碰 .zip：索引文件与其它扩展名资产一律不动', () => {
  const { status, output } = runPrune({
    registry: {
      schema: 1,
      plugins: {
        todo: { assets: [{ url: 'https://github.com/x/y/releases/download/plugins-latest/todo-0.1.1-macos-arm64.zip' }] },
      },
    },
    remote: ['registry.json', 'todo-0.1.1-macos-arm64.zip', 'todo-0.1.1-macos-arm64.zip.sig', 'sha256sums.txt'],
  })
  assertEqual(status, 0, `应成功。输出：${output}`)
  assert(output.includes('没有旧资产需要清理'), `非 zip 不该被清理。输出：${output}`)
})

test('没有旧资产：幂等成功', () => {
  const { status, output } = runPrune({
    registry: {
      schema: 1,
      kernel: {
        version: '0.1.1',
        assets: [{ url: 'https://github.com/x/y/releases/download/kernel-latest/launcher-kernel-0.1.1-macos-arm64.zip' }],
      },
    },
    remote: ['kernel-registry.json', 'launcher-kernel-0.1.1-macos-arm64.zip'],
  })
  assertEqual(status, 0, `应成功。输出：${output}`)
  assert(output.includes('没有旧资产需要清理'), `输出：${output}`)
})

test('索引里没有任何资产 URL：拒绝清理（防止把整条 release 清空）', () => {
  const { status, output } = runPrune({
    registry: { schema: 1, plugins: {} },
    remote: ['registry.json', 'todo-0.1.0-macos-arm64.zip'],
  })
  assert(status !== 0, '应失败')
  assert(output.includes('拒绝清理'), `报错应说清原因，实际输出：${output}`)
})

test('索引文件不存在：明确报错（清理不能凭空猜保留名单）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prune-'))
  let status = 0
  let output = ''
  try {
    output = execFileSync(
      process.execPath,
      [script, '--tag', 'plugins-latest', '--registry', path.join(root, 'missing.json'), '--dry-run'],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
    )
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  fs.rmSync(root, { recursive: true, force: true })
  assert(status !== 0, '应失败')
  assert(output.includes('找不到索引'), `报错应说清原因，实际输出：${output}`)
})

const failed = await run('发布后清理旧资产')
if (failed > 0) process.exit(1)
