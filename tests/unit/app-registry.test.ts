/**
 * 应用更新索引（scripts/gen-app-registry.mjs）：多个平台的分片 → 一份 `app-registry.json`。
 *
 * 索引是客户端判「有没有新版 / 该拉哪个包」的唯一依据，守四件事：
 * ① macOS 与 Windows 的分片都要进索引，`platforms` 必须是客户端口径（`windows` 而非 `win`）；
 * ② 版本以首个分片为准，不一致要告警；③ `shellHotVersion` 两端不一致要告警
 * （机制版本不同 = 有一个平台的包打晚了，客户端会被 `minShellHotVersion` 挡下）；
 * ④ `--min-shell-hot-version` 要落进索引。
 *
 * 用 `--release-dir` 喂临时目录，全程不碰仓库里的 `app/release/`。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'gen-app-registry.mjs')

/** 一个分片：文件名按 pack-app.mjs 的真实约定（Windows 用 `win`，`platforms` 用 `windows`） */
function shard(platform: string, arch: string, extra: Record<string, unknown> = {}) {
  const tag = platform === 'windows' ? 'win' : platform
  return {
    version: '0.1.5',
    shellHotVersion: '0.1.0',
    platform,
    arch,
    file: `Chassis-0.1.5-${tag}-${arch}.zip`,
    sha256: platform === 'windows' ? 'bb' : 'aa',
    bytes: platform === 'windows' ? 2 : 1,
    ...extra,
  }
}

/** 跑一次索引生成（临时目录），返回退出码 / 输出 / 产物 */
function runGen(
  shards: Array<Record<string, unknown>>,
  args: string[] = [],
): { status: number; output: string; registry: any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-registry-'))
  for (const item of shards) {
    const name = `app-shard-${item.platform}-${item.arch}.json`
    fs.writeFileSync(path.join(dir, name), JSON.stringify(item))
  }
  // spawnSync（而不是 execFileSync）：成功时也要拿到 stderr —— 告警走的就是 stderr
  const result = spawnSync(process.execPath, [script, '--release-dir', dir, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const status = result.status ?? 1
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const registryPath = path.join(dir, 'app-registry.json')
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { status, output, registry }
}

test('macOS 与 Windows 分片都进索引：平台口径与文件名各自正确', () => {
  const { status, output, registry } = runGen([shard('macos', 'arm64'), shard('windows', 'x64')])
  assertEqual(status, 0, `应成功。输出：${output}`)
  assertEqual(registry.app.version, '0.1.5', '版本取自分片')
  assertEqual(registry.app.assets.length, 2, `两个平台都要在索引里：${JSON.stringify(registry.app.assets)}`)

  const mac = registry.app.assets.find((asset: { platforms: string[] }) => asset.platforms[0] === 'macos')
  const win = registry.app.assets.find((asset: { platforms: string[] }) => asset.platforms[0] === 'windows')
  assert(mac && win, 'macos 与 windows 资产都要有')
  assertEqual(mac.arch[0], 'arm64', 'macOS 架构')
  assertEqual(win.arch[0], 'x64', 'Windows 架构')
  // 客户端按 `platforms` 过滤（current_platform() = "windows"），文件名里的 `win` 只影响下载链接
  assert(win.url.endsWith('Chassis-0.1.5-win-x64.zip'), `URL 要指向分片里的文件：${win.url}`)
  assertEqual(win.sha256, 'bb', '哈希来自分片')
  assertEqual(win.bytes, 2, '字节数来自分片')
})

test('分片版本不一致：以首个分片为准并告警（不失败）', () => {
  const { status, output, registry } = runGen([shard('macos', 'arm64'), shard('windows', 'x64', { version: '0.1.4' })])
  assertEqual(status, 0, `应成功（只告警）。输出：${output}`)
  assert(output.includes('分片版本不一致'), `要告警。输出：${output}`)
  assertEqual(registry.app.version, '0.1.5', '以首个分片为准')
})

test('shellHotVersion 两端不一致：告警（否则客户端会被 minShellHotVersion 挡下）', () => {
  const { status, output } = runGen([shard('macos', 'arm64'), shard('windows', 'x64', { shellHotVersion: '0.9.9' })])
  assertEqual(status, 0, `应成功（只告警）。输出：${output}`)
  assert(output.includes('shellHotVersion 与首个分片不一致'), `要告警。输出：${output}`)
})

test('--min-shell-hot-version 落进索引（客户端据此挡旧机制）', () => {
  const { registry } = runGen([shard('macos', 'arm64'), shard('windows', 'x64')], ['--min-shell-hot-version', '0.2.0'])
  assertEqual(registry.app.minShellHotVersion, '0.2.0', '门槛要落进索引')
})

test('没有分片：明确失败（不能生成一份空索引）', () => {
  const { status, output } = runGen([])
  assert(status !== 0, '应失败')
  assert(output.includes('没有分片'), `报错应说清原因，实际输出：${output}`)
})

const failed = await run('应用更新索引')
if (failed > 0) process.exit(1)
