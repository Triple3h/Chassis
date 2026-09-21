/**
 * Gitee 镜像同步（scripts/sync-release-to-gitee.mjs）：待删 = 本次同名覆盖 + 不在索引里的旧 `.zip`。
 *
 * 关键回归：plugins 通道支持**增量发布**（`-f plugins=<id>`，索引经 `--merge-registry` 合并成
 * 全量），所以**绝不能**「全删再传」—— 那会把本次没重发的插件包一起删掉（其他插件的更新立刻 404）。
 * 用 `--remote-list` 喂远程附件名，全程不碰网络。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'sync-release-to-gitee.mjs')

/** 搭一个临时产物目录（+ 索引）与远程清单跑脚本；返回（退出码，stdout+stderr）。 */
function runSync(input: {
  files: string[]
  registry?: unknown
  remote?: string[]
  env?: Record<string, string>
}): { status: number; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitee-sync-'))
  const out = path.join(root, 'out')
  fs.mkdirSync(out)
  for (const name of input.files) fs.writeFileSync(path.join(out, name), 'x')
  if (input.registry) {
    // 索引就是产物目录里的那个文件（app-registry.json / kernel-registry.json / registry.json），别另造一份
    const registryName = input.files.find((name) => name === 'registry.json' || name.endsWith('-registry.json')) ?? 'registry.json'
    fs.writeFileSync(path.join(out, registryName), JSON.stringify(input.registry))
  }
  const args = [script, '--tag', 'plugins-latest', '--dir', out]
  if (input.remote) {
    const remotePath = path.join(root, 'remote.txt')
    fs.writeFileSync(remotePath, input.remote.join('\n'))
    args.push('--remote-list', remotePath)
  }
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, GITEE_TOKEN: '', ...(input.env ?? {}) },
    })
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  fs.rmSync(root, { recursive: true, force: true })
  return { status, output }
}

/** 脚本输出里以 `- ` 开头的行（删除计划）与 `+ ` 开头的行（上传计划）。 */
function planLines(output: string, marker: '+' | '-'): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${marker} `))
    .map((line) => line.slice(2))
}

test('增量发布：只删本次同名与旧版本，其他插件包必须保留', () => {
  const url = (file: string) => `https://github.com/triple3h/Chassis/releases/download/plugins-latest/${file}`
  const { status, output } = runSync({
    files: ['json-tools-0.4.0-macos-arm64.zip', 'registry.json'],
    // 合并后的全量索引：本次只重发了 json-tools，totp 仍指向旧版本
    registry: {
      plugins: {
        'json-tools': { assets: [{ url: url('json-tools-0.4.0-macos-arm64.zip') }] },
        totp: { assets: [{ url: url('totp-0.5.0-macos-arm64.zip') }] },
      },
    },
    remote: ['json-tools-0.3.0-macos-arm64.zip', 'totp-0.5.0-macos-arm64.zip', 'registry.json'],
  })
  assertEqual(status, 0, `离线预览应成功。输出：${output}`)
  const doomed = planLines(output, '-')
  assert(doomed.includes('json-tools-0.3.0-macos-arm64.zip'), `旧版本应进删除计划。输出：${output}`)
  assert(doomed.includes('registry.json'), `本次要覆盖的索引应先进删除计划（避免同名冲突）。输出：${output}`)
  assert(!doomed.includes('totp-0.5.0-macos-arm64.zip'), `本次没重发的插件包不得被删（404 风险）。输出：${output}`)
  assertEqual(doomed.length, 2, `应只删 2 个。输出：${output}`)
})

test('全量发布（app 索引结构）：旧包与同名覆盖进计划，索引保留集生效', () => {
  const { status, output } = runSync({
    files: ['Chassis-0.1.1-macos-arm64.zip', 'app-registry.json'],
    registry: {
      app: { version: '0.1.1', assets: [{ url: 'https://github.com/x/y/releases/download/app-latest/Chassis-0.1.1-macos-arm64.zip' }] },
    },
    remote: ['Chassis-0.1.0-macos-arm64.zip', 'Chassis-0.1.1-macos-arm64.zip', 'app-registry.json'],
  })
  assertEqual(status, 0, `离线预览应成功。输出：${output}`)
  const doomed = planLines(output, '-')
  assert(doomed.includes('Chassis-0.1.0-macos-arm64.zip'), `旧包应进删除计划。输出：${output}`)
  assert(doomed.includes('Chassis-0.1.1-macos-arm64.zip'), `同名覆盖对象应先进删除计划。输出：${output}`)
  assertEqual(doomed.length, 3, `应删 3 个（含索引）。输出：${output}`)
  // 索引自动探测（app-registry.json 也是 *-registry.json）；保留集 = 本次文件 ∪ 索引指向的资产 = 2 项
  assert(output.includes('保留集 2 项'), `保留集应含索引指向的包 + 本次文件。输出：${output}`)
})

/**
 * 回归（2026-09-21 翻车）：**索引最后传，旧版本包在索引之后才清理**。
 * 原来的顺序是「先删光待删项 → 按目录顺序传」，跨境链路上一挂就留下**空壳** Gitee release
 * （索引与两个包都被删、新的还没传上去）——谁把下载域名切到 gitee 谁就 404。
 */
test('同步顺序：zip 先传、索引最后，旧版本包留到索引替换之后再清理', () => {
  const url = (file: string) => `https://github.com/x/y/releases/download/app-latest/${file}`
  const { status, output } = runSync({
    files: ['Chassis-0.1.2-macos-arm64.zip', 'app-registry.json'],
    registry: { app: { version: '0.1.2', assets: [{ url: url('Chassis-0.1.2-macos-arm64.zip') }] } },
    remote: ['Chassis-0.1.1-macos-arm64.zip', 'Chassis-0.1.2-macos-arm64.zip', 'app-registry.json'],
  })
  assertEqual(status, 0, `离线预览应成功。输出：${output}`)

  const uploads = planLines(output, '+')
  assertEqual(uploads[uploads.length - 1], 'app-registry.json', `索引必须最后上传（包先落地）。输出：${output}`)

  const conflicts = section(output, '同名覆盖（先删，否则传不上去）：', '索引替换后清理')
  const stale = section(output, '索引替换后清理（旧版本包，半路失败时它们还在）：')
  assert(conflicts.includes('app-registry.json'), `同名索引要先删（否则传不上去）。输出：${output}`)
  assert(conflicts.includes('Chassis-0.1.2-macos-arm64.zip'), `同名包要先删。输出：${output}`)
  assertEqual(conflicts.main.length, 2, `同名覆盖应只含本次文件。输出：${output}`)
  assertEqual(stale.main.join(','), 'Chassis-0.1.1-macos-arm64.zip', `旧版本包只在最后清理。输出：${output}`)
})

/** 取输出里某一段（header 到下一个 header / 结尾）以及该段的 `- ` 行；`.includes` 查整段原文。 */
function section(output: string, from: string, to?: string): { raw: string; main: string[] } & { includes(value: string): boolean } {
  const rest = output.split(from)[1] ?? ''
  const raw = to ? (rest.split(to)[0] ?? '') : rest
  return {
    raw,
    main: planLines(raw, '-'),
    includes: (value: string) => raw.includes(value),
  }
}

test('分片与隐藏文件不上传', () => {
  const { status, output } = runSync({
    files: ['todo-0.1.1-macos-arm64.zip', 'registry.json', 'shard-1.json', '.DS_Store'],
    registry: { plugins: {} },
    remote: [],
  })
  assertEqual(status, 0, `离线预览应成功。输出：${output}`)
  const uploads = planLines(output, '+')
  assertEqual(uploads.length, 2, `只应上传 zip 与索引。输出：${output}`)
  assert(!uploads.includes('shard-1.json'), `分片不得上传。输出：${output}`)
  assert(!uploads.includes('.DS_Store'), `隐藏文件不得上传。输出：${output}`)
})

test('未配置 GITEE_TOKEN：跳过本步且不算失败', () => {
  const { status, output } = runSync({ files: ['todo-0.1.1-macos-arm64.zip'] })
  assertEqual(status, 0, `跳过不应失败。输出：${output}`)
  assert(output.includes('跳过 Gitee 同步'), `应明确说明跳过。输出：${output}`)
})

test('产物目录不存在：明确报错', () => {
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [script, '--tag', 'plugins-latest', '--dir', '/nonexistent-gitee-sync'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  assert(status !== 0, '应失败')
  assert(output.includes('找不到产物目录'), `报错应说清原因，实际输出：${output}`)
})

const failed = await run('Gitee 镜像同步')
if (failed > 0) process.exit(1)
