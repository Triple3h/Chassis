/**
 * 壳 / 内核版本的唯一维护点：根 `version.json`（`scripts/version.mjs` 同步与校验）。
 *
 * 为什么值得一个用例：版本漂移的后果**全是静默的** —— 客户端判不出新版本（自更新永不触发）、
 * 或装出「Info.plist 与 tauri.conf.json 对不上号」的包。三道防线：
 *   1. 人只改 `version.json`（`pnpm version:set app x.y.z`）；
 *   2. `pnpm version:check` 在本地与发版 workflow 里拦漂移；
 *   3. 本用例把「直接手改位点文件」也拦在 PR 里。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { repoRoot } from '../helpers/harness'

const script = path.join(repoRoot, 'scripts', 'version.mjs')

function cli(root: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 最小仓库骨架：五个位点 + version.json */
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-sync-'))
  fs.mkdirSync(path.join(dir, 'apps', 'shell'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'apps', 'kernel'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'apps', 'shell', 'tauri.conf.json'),
    `{\n  "productName": "Chassis",\n  "version": "0.1.3"\n}\n`,
  )
  fs.writeFileSync(
    path.join(dir, 'apps', 'shell', 'Cargo.toml'),
    `[package]\nname = "launcher-shell"\nversion = "0.1.3"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n`,
  )
  fs.writeFileSync(
    path.join(dir, 'apps', 'shell', 'Cargo.lock'),
    `version = 4\n\n[[package]]\nname = "launcher-shell"\nversion = "0.1.3"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\n`,
  )
  fs.writeFileSync(path.join(dir, 'apps', 'kernel', 'Cargo.toml'), `[package]\nname = "launcher-kernel"\nversion = "0.1.0"\n`)
  fs.writeFileSync(
    path.join(dir, 'Cargo.lock'),
    `version = 4\n\n[[package]]\nname = "launcher-kernel"\nversion = "0.1.0"\ndependencies = [\n "launcher-shell",\n]\n`,
  )
  fs.writeFileSync(path.join(dir, 'version.json'), `{\n  "app": "0.1.3",\n  "kernel": "0.1.0"\n}\n`)
  return dir
}

test('check：一致时通过；任何一处漂移都点名文件并给实际值 vs 期望值', () => {
  const dir = makeFixture()
  assertEqual(cli(dir, 'check').code, 0, '初始应一致')

  const target = path.join(dir, 'apps', 'shell', 'Cargo.toml')
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('0.1.3', '0.1.2'))
  const drifted = cli(dir, 'check')
  assertEqual(drifted.code, 1, '漂移必须非零退出')
  assert(drifted.out.includes('Cargo.toml'), `错误要点名漂移文件：${drifted.out}`)
  assert(drifted.out.includes('0.1.2') && drifted.out.includes('0.1.3'), `要同时给出实际值与期望值：${drifted.out}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('sync：清单写进五处；只动 [package] 的 version，不碰依赖声明', () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(dir, 'version.json'), `{\n  "app": "0.2.0",\n  "kernel": "0.2.0"\n}\n`)
  assertEqual(cli(dir, 'sync').code, 0)
  assertEqual(cli(dir, 'check').code, 0, 'sync 后必须一致')

  const conf = fs.readFileSync(path.join(dir, 'apps', 'shell', 'tauri.conf.json'), 'utf8')
  assert(conf.includes('"version": "0.2.0"'), conf)
  const shellCargo = fs.readFileSync(path.join(dir, 'apps', 'shell', 'Cargo.toml'), 'utf8')
  assert(shellCargo.includes('version = "0.2.0"'), shellCargo)
  assert(shellCargo.includes('serde = { version = "1" }'), `依赖声明不许被动：${shellCargo}`)
  const kernelCargo = fs.readFileSync(path.join(dir, 'apps', 'kernel', 'Cargo.toml'), 'utf8')
  assert(kernelCargo.includes('version = "0.2.0"'), kernelCargo)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('lock 位点：包版本跟着走，别的包与依赖列表都不许被碰', () => {
  const dir = makeFixture()
  assertEqual(cli(dir, 'set', 'app', '0.4.0').code, 0)
  assertEqual(cli(dir, 'set', 'kernel', '0.4.0').code, 0)

  const shellLock = fs.readFileSync(path.join(dir, 'apps', 'shell', 'Cargo.lock'), 'utf8')
  assert(shellLock.includes('name = "launcher-shell"\nversion = "0.4.0"'), `壳 lock 的包版本要跟上：${shellLock}`)
  assert(shellLock.includes('name = "serde"\nversion = "1.0.200"'), `别的包不许动：${shellLock}`)

  const rootLock = fs.readFileSync(path.join(dir, 'Cargo.lock'), 'utf8')
  assert(rootLock.includes('name = "launcher-kernel"\nversion = "0.4.0"'), `根 lock 的包版本要跟上：${rootLock}`)
  // 名字出现在别人的 dependencies 列表里（`"launcher-shell",`）不算位点，别被一起改掉
  assert(rootLock.includes('"launcher-shell",'), `依赖列表不许动：${rootLock}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('lock 里没有那个包：明确报红（不静默跳过）', () => {
  const dir = makeFixture()
  const lock = path.join(dir, 'apps', 'shell', 'Cargo.lock')
  fs.writeFileSync(lock, `version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\n`)
  const result = cli(dir, 'check')
  assertEqual(result.code, 1, '找不到包必须红')
  assert(result.out.includes('launcher-shell'), `报错要点名包：${result.out}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('set：改清单 + 自动同步；非法版本号与未知键一律拒绝', () => {
  const dir = makeFixture()
  assertEqual(cli(dir, 'set', 'app', '0.3.1').code, 0)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')) as { app: string; kernel: string }
  assertEqual(manifest.app, '0.3.1')
  assertEqual(manifest.kernel, '0.1.0', '另一个键不许被动')
  assertEqual(cli(dir, 'check').code, 0, 'set 应自动同步')
  assertEqual(cli(dir, 'set', 'app', 'v0.3').code, 1, '非法版本号必须拒绝')
  assertEqual(cli(dir, 'set', 'ui', '0.3.1').code, 1, '未知键必须拒绝')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('位点文件缺失：check 明确报红（不静默跳过）', () => {
  const dir = makeFixture()
  fs.rmSync(path.join(dir, 'apps', 'kernel', 'Cargo.toml'))
  const result = cli(dir, 'check')
  assertEqual(result.code, 1, '缺文件必须红')
  assert(result.out.includes('Cargo.toml'), `报错要指名文件：${result.out}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('真实仓库：五处位点与根 version.json 一致（手改位点文件被拦下）', () => {
  const result = cli(repoRoot, 'check')
  assertEqual(result.code, 0, `版本漂移（跑 pnpm version:sync 同步）：\n${result.out}`)
})

const failed = await run('版本唯一维护点（version.json）')
if (failed > 0) process.exit(1)
