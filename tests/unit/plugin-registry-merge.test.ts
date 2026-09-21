/**
 * 插件索引（registry.json）的**合并**守则（docs/plugin-spec.md 附录 C）：
 * 单独发布某个插件时，分片里只有它 —— 不合并就会生成一份「只含它」的索引，
 * 其余插件当场从索引里消失、客户端静默不再提示更新（`collect_plugins` 查不到就跳过）。
 *
 * 守四件事：① 没打包的插件整条沿用上一版；② 打包的插件版本变了则丢弃未重建平台的旧资产
 * （宁可客户端报「无此平台产物」，也不让它装到旧版本）；③ 取不到上一版索引就明确报错、不产出；
 * ④ 不合并时保持旧行为（只含本次分片），便于定位事故。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'gen-plugin-registry.mjs')

interface Asset {
  platforms: string[]
  url: string
  sha256: string
  bytes: number
}

function asset(platform: string, version: string): Asset {
  return {
    platforms: [platform],
    url: `https://github.com/triple3h/Chassis/releases/download/plugins-latest/demo-${version}-${platform}.zip`,
    sha256: `${platform}-${version}-sha`.padEnd(64, '0'),
    bytes: 100,
  }
}

function entry(version: string, assets: Asset[]) {
  return { title: version, version, apiVersion: '2', minKernel: null, notes: null, assets }
}

function shardPlugin(version: string, file: string) {
  return { title: version, version, apiVersion: '2', file, sha256: `${file}-sha`.padEnd(64, '0'), bytes: 100 }
}

/** 搭一个临时发布目录跑脚本；返回值（退出码，索引 or null，stdout）。 */
function runRegistry(options: {
  shards?: Record<string, unknown>
  previous?: Record<string, unknown>
  merge: boolean
}): { status: number; registry: { schema: number; plugins: Record<string, { version: string; assets: Asset[] }> } | null; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-'))
  const release = path.join(root, 'release')
  fs.mkdirSync(release, { recursive: true })
  for (const [name, body] of Object.entries(options.shards ?? {})) {
    fs.writeFileSync(path.join(release, `${name}.json`), JSON.stringify(body))
  }
  const args = ['--release-dir', release]
  if (options.merge) {
    const prevPath = path.join(root, 'prev-registry.json')
    if (options.previous) fs.writeFileSync(prevPath, JSON.stringify({ schema: 1, generatedAt: 'x', plugins: options.previous }))
    args.push('--merge-registry', prevPath)
  }
  const outFile = path.join(release, 'registry.json')
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  const registry = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null
  fs.rmSync(root, { recursive: true, force: true })
  return { status, registry, output }
}

const macosShard = { platform: 'macos', arch: 'arm64', plugins: { alpha: shardPlugin('1.1.0', 'alpha-macos.zip') } }

/** 取索引里的某个插件条目（缺失即失败，省得每个断言都写可选链）。 */
function plugin(
  registry: { plugins: Record<string, { version: string; assets: Asset[] }> } | null,
  id: string,
): { version: string; assets: Asset[] } {
  assert(registry, '应产出索引')
  const entry = registry.plugins[id]
  assert(entry, `索引里应有插件 ${id}`)
  return entry
}

test('单独发布一个插件：其余插件整条沿用上一版，索引不塌陷', () => {
  const { status, registry } = runRegistry({
    shards: { 'shard-macos-arm64': macosShard },
    previous: {
      alpha: entry('1.0.0', [asset('macos', '1.0.0'), asset('windows', '1.0.0')]),
      beta: entry('2.0.0', [asset('macos', '2.0.0'), asset('windows', '2.0.0')]),
      gamma: entry('3.0.0', [asset('macos', '3.0.0')]),
    },
    merge: true,
  })
  assertEqual(status, 0, '应成功')
  assert(registry, '应产出索引')
  assertDeepEqual(Object.keys(registry.plugins).sort(), ['alpha', 'beta', 'gamma'], '索引里一个插件都不能少')
  assertEqual(plugin(registry, 'alpha').version, '1.1.0', '本次打包的插件取新版本')
  assertDeepEqual(
    plugin(registry, 'alpha').assets.map((a) => a.platforms[0]),
    ['macos'],
    '版本变了：未重建平台的旧资产必须丢弃（否则 Windows 客户端装到 1.0.0）',
  )
  assertDeepEqual(plugin(registry, 'beta'), entry('2.0.0', [asset('macos', '2.0.0'), asset('windows', '2.0.0')]), '未打包的插件逐字段沿用')
  assertDeepEqual(plugin(registry, 'gamma').assets.map((a) => a.platforms[0]), ['macos'], '单平台插件同样沿用')
})

test('本次打包版本未变：未重建平台的资产原样沿用（两份资产都在）', () => {
  const { registry } = runRegistry({
    shards: { 'shard-macos-arm64': { platform: 'macos', arch: 'arm64', plugins: { alpha: shardPlugin('1.0.0', 'alpha-macos-new.zip') } } },
    previous: { alpha: entry('1.0.0', [asset('macos', '1.0.0'), asset('windows', '1.0.0')]) },
    merge: true,
  })
  assert(registry, '应产出索引')
  const assets = plugin(registry, 'alpha').assets
  assertDeepEqual(assets.map((a) => a.platforms[0]), ['macos', 'windows'], '两台平台的资产都该在')
  assertEqual(assets[0]?.sha256, 'alpha-macos-new.zip-sha'.padEnd(64, '0'), '重建平台用本次的 sha256')
  assertEqual(assets[1]?.sha256, 'windows-1.0.0-sha'.padEnd(64, '0'), '未重建平台沿用上一版 sha256')
})

test('取不到上一版索引：明确报错且不产出索引（不发残缺索引）', () => {
  const { status, registry, output } = runRegistry({
    shards: { 'shard-macos-arm64': macosShard },
    merge: true,
  })
  assert(status !== 0, '应失败')
  assertEqual(registry, null, '不得写出索引')
  assert(output.includes('没有上一版索引'), `报错应说清原因，实际输出：${output}`)
})

test('不合并（全量发布）：索引只含本次分片里的插件', () => {
  const { registry } = runRegistry({
    shards: { 'shard-macos-arm64': macosShard },
    previous: { beta: entry('2.0.0', [asset('macos', '2.0.0')]) },
    merge: false,
  })
  assert(registry, '应产出索引')
  assertDeepEqual(Object.keys(registry.plugins), ['alpha'], '不合并 = 上一版不参与（这正是必须显式合并的原因）')
})

const failed = await run('插件索引合并')
if (failed > 0) process.exit(1)
