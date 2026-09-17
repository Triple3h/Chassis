/**
 * 测试 fixture 的**生成**（v2）：逻辑层是 Rust 可执行产物，没有 npm 构建链兜底 ——
 * fixture 的 `dist/` 是 `.gitignore` 的生成物，测试自己负责把它铺出来。
 *
 * echo 示例（`packages/plugin-sdk-rs/examples/echo.rs`）同时是协议一致性 fixture 的
 * v2 载体：compute / job / feed / probe 四个命令共用一个二进制，按文件名区分命令。
 */
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { repoRoot } from './harness'

const EXAMPLE_BIN = path.join(repoRoot, 'target', 'debug', 'examples', process.platform === 'win32' ? 'echo.exe' : 'echo')

let exampleReady: Promise<void> | null = null

/** 构建 echo 示例（memoized；源码没动时是毫秒级 no-op） */
function ensureEchoExample(): Promise<void> {
  exampleReady ??= (async () => {
    const result = spawnSync('cargo', ['build', '-p', 'launcher-plugin-sdk', '--example', 'echo'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    if (result.error) throw new Error(`无法执行 cargo：${result.error.message}`)
    if (result.status !== 0) throw new Error('构建 echo 示例失败：cargo build -p launcher-plugin-sdk --example echo')
  })()
  return exampleReady
}

/** 把 echo 示例铺成某个插件的逻辑层产物：`<pluginRoot>/dist/<name>`（可执行） */
export async function installEchoBinaries(pluginRoot: string, commands: string[]): Promise<void> {
  await ensureEchoExample()
  await fsp.mkdir(path.join(pluginRoot, 'dist'), { recursive: true })
  for (const command of commands) {
    const target = path.join(pluginRoot, 'dist', command)
    await fsp.copyFile(EXAMPLE_BIN, target)
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755)
  }
}

/**
 * 生成 echo-plugin 契约 fixture 的 `dist/`：
 * 清单从源码 `package.json` 派生（单一真源：命令 / 能力声明都在那），apiVersion 改 2；
 * 视图侧给一个占位资产（测试不开 iframe），逻辑层铺 compute / job / feed / probe。
 */
export async function materializeEchoPlugin(): Promise<string> {
  const root = path.join(repoRoot, 'tests', 'fixtures', 'echo-plugin')
  const dist = path.join(root, 'dist')
  const source = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf-8')) as Record<string, unknown>
  const manifest: Record<string, unknown> = { ...source, apiVersion: '2' }
  delete manifest.scripts
  delete manifest.dependencies
  delete manifest.devDependencies
  delete manifest.private

  await fsp.mkdir(path.join(dist, 'assets'), { recursive: true })
  await fsp.writeFile(path.join(dist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await fsp.copyFile(path.join(root, 'index.html'), path.join(dist, 'index.html'))
  await fsp.writeFile(path.join(dist, 'assets', 'main.js'), '// fixture 占位视图（测试不加载 iframe）\n')
  await installEchoBinaries(root, ['compute', 'job', 'feed', 'probe'])
  return root
}
