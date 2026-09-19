/**
 * 插件脚手架（`pnpm create:plugin`）的黑盒守护：
 *
 *  - 生成物要能过**真校验器**（`@launcher/plugin-manifest`）—— 生成器不许产出「装不上」的插件；
 *  - 含逻辑层时要登记根 Cargo.toml members（漏登记 = 产物静默缺失）且**幂等**；
 *  - 错误路径（保留前缀 / 目录已存在）必须拦住并给出人话。
 *
 * 全程用子进程跑真 CLI（带上假的「仓库根」布局），CLI 是 .mjs、不经 TS 编译。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateManifest } from '../../plugin-manifest/src/index'
import { assert, assertEqual, run, test } from '../../../tests/helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const CLI = path.join(repoRoot, 'packages', 'plugin-cli', 'create.mjs')

/** 造一个「像本仓库」的假根：findRepoRoot 只认 packages/plugin-sdk-rs/Cargo.toml */
function makeFakeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-'))
  fs.mkdirSync(path.join(dir, 'packages', 'plugin-sdk-rs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'packages', 'plugin-sdk-rs', 'Cargo.toml'), '[package]\nname = "launcher-plugin-sdk"\n')
  fs.writeFileSync(
    path.join(dir, 'Cargo.toml'),
    `[workspace]\nresolver = "2"\nmembers = [\n    "packages/plugin-sdk-rs",\n    "apps/kernel",\n    "plugins/web-open",\n]\n`,
  )
  return dir
}

function runCli(repo: string, args: string[]): { output: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { output: stdout, code: 0 }
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; status?: number }
    return { output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.status ?? 1 }
  }
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf-8'))

test('view 形态：文件齐全，清单过真校验器', () => {
  const repo = makeFakeRepo()
  const { output, code } = runCli(repo, ['demo-view', '--title', '示例视图'])
  assertEqual(code, 0, `应当成功：${output}`)

  const dir = path.join(repo, 'plugins', 'demo-view')
  for (const file of [
    'package.json',
    'vite.config.ts',
    'tsconfig.json',
    'index.html',
    'src/main.ts',
    'src/App.vue',
    'src/styles/app.css',
  ]) {
    assert(fs.existsSync(path.join(dir, file)), `缺少 ${file}`)
  }
  assert(!fs.existsSync(path.join(dir, 'Cargo.toml')), 'view 形态不该有 Cargo.toml')

  const validation = validateManifest(readJson(path.join(dir, 'package.json')))
  assert(validation.ok, `清单应当通过校验：${JSON.stringify(validation)}`)

  // 仓库内生成：模板里的相对引用按实际位置算（plugins/<id> → ../../scripts/lib）
  const vite = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf-8')
  assert(vite.includes("from '../../scripts/lib/manifest-plugin.mjs'"), `vite 配置的相对引用不对：${vite.slice(0, 400)}`)
  const css = fs.readFileSync(path.join(dir, 'src/styles/app.css'), 'utf-8')
  assert(css.includes('../../../../packages/ui/styles/theme.css'), 'app.css 的 theme.css 引用不对')
})

test('script 形态：bin 名 = 命令名，根 Cargo.toml 被登记（且幂等）', () => {
  const repo = makeFakeRepo()
  const first = runCli(repo, ['demo-tool', '--mode', 'script', '--command', 'scan'])
  assertEqual(first.code, 0, `应当成功：${first.output}`)

  const dir = path.join(repo, 'plugins', 'demo-tool')
  assert(fs.existsSync(path.join(dir, 'Cargo.toml')), 'script 形态应有 Cargo.toml')
  assert(fs.existsSync(path.join(dir, 'src', 'bin', 'scan.rs')), 'bin 文件名 = 命令名（产物名 = 命令名）')
  assert(!fs.existsSync(path.join(dir, 'src', 'App.vue')), 'script 形态不该有 view')

  const manifest = readJson(path.join(dir, 'package.json')) as { commands: Array<{ name: string; mode: string }> }
  assertEqual(manifest.commands.length, 1)
  assertEqual(manifest.commands[0]?.name, 'scan')
  assertEqual(manifest.commands[0]?.mode, 'script')
  const validation = validateManifest(manifest)
  assert(validation.ok, `清单应当通过校验：${JSON.stringify(validation)}`)

  const cargo = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf-8')
  assert(cargo.includes('name = "scan"') && cargo.includes('path = "src/bin/scan.rs"'), `bin 段不对：${cargo}`)

  const membersOf = (): string => fs.readFileSync(path.join(repo, 'Cargo.toml'), 'utf-8')
  assert(membersOf().includes('"plugins/demo-tool"'), `members 应当被登记：${membersOf()}`)
  assertEqual(membersOf().split('"plugins/demo-tool"').length - 1, 1, 'member 只登记一次')

  // 再跑一次（--force）不重复登记
  const second = runCli(repo, ['demo-tool', '--mode', 'script', '--command', 'scan', '--force'])
  assertEqual(second.code, 0, `覆盖应当成功：${second.output}`)
  assertEqual(membersOf().split('"plugins/demo-tool"').length - 1, 1, '幂等：member 仍只一次')
})

test('full 形态：view 命令用 id、逻辑层命令默认 <id>-run，两条都在清单里', () => {
  const repo = makeFakeRepo()
  const { output, code } = runCli(repo, ['demo-full', '--mode', 'full'])
  assertEqual(code, 0, `应当成功：${output}`)

  const dir = path.join(repo, 'plugins', 'demo-full')
  const manifest = readJson(path.join(dir, 'package.json')) as { commands: Array<{ name: string; mode: string }> }
  const byMode = new Map(manifest.commands.map((c) => [c.mode, c.name]))
  assertEqual(byMode.get('view'), 'demo-full')
  assertEqual(byMode.get('script'), 'demo-full-run')
  const validation = validateManifest(manifest)
  assert(validation.ok, `清单应当通过校验：${JSON.stringify(validation)}`)

  for (const file of ['vite.config.ts', 'src/App.vue', 'Cargo.toml', 'src/bin/demo-full-run.rs']) {
    assert(fs.existsSync(path.join(dir, file)), `缺少 ${file}`)
  }
})

test('错误路径：保留前缀 / 非法 id / 目录已存在都被拦住', () => {
  const repo = makeFakeRepo()

  const reserved = runCli(repo, ['internal-foo'])
  assertEqual(reserved.code, 1)
  assert(reserved.output.includes('internal-'), `应提示保留前缀：${reserved.output}`)

  const bad = runCli(repo, ['Not_Kebab'])
  assertEqual(bad.code, 1)
  assert(bad.output.includes('kebab-case'), `应提示 id 形状：${bad.output}`)

  assertEqual(runCli(repo, ['demo-view']).code, 0)
  const again = runCli(repo, ['demo-view'])
  assertEqual(again.code, 1, '目录已存在应当拒绝')
  assert(again.output.includes('--force'), `应提示 --force：${again.output}`)
  assertEqual(runCli(repo, ['demo-view', '--force']).code, 0, '--force 后可以覆盖')
})

const failed = await run('插件脚手架')
if (failed > 0) process.exit(1)
