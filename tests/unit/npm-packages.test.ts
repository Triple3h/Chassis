/**
 * npm 更新通道（scripts/publish-npm.mjs）：
 * 包拆分、索引改写（npmmirror URL + tgz entry + mirrors）、签名、dry-run 与签名缺失的失败口径。
 *
 * 全程 `--dry-run`：不调 npm、不联网；产物与索引都落在临时目录里检查。
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'

const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? process.cwd()
const script = path.join(repoRoot, 'scripts', 'publish-npm.mjs')
const READ_BASE = 'https://registry.npmmirror.com'

function makeKey(): { secret: string; publicKey: crypto.KeyObject; keyId: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const raw = spki.subarray(spki.length - 32)
  const keyId = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return { secret, publicKey, keyId }
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chassis-npm-test-'))
}

function runPublish(
  args: string[],
  env: Record<string, string> = {},
): { status: number; output: string } {
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, LAUNCHER_TEST: '1', ...env },
    })
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  return { status, output }
}

function writeZip(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), 'zip')
}

function githubUrl(file: string): string {
  return `https://github.com/triple3h/Chassis/releases/download/x-latest/${file}`
}

function appRegistry() {
  return {
    schema: 1,
    generatedAt: '2026-11-02T00:00:00.000Z',
    app: {
      version: '0.1.11',
      shellHotVersion: '3',
      minShellHotVersion: '2',
      notes: '修复启动残留',
      assets: [
        {
          platforms: ['macos'],
          arch: ['arm64'],
          url: githubUrl('Chassis-0.1.11-macos-arm64.zip'),
          sha256: 'aa'.repeat(32),
          bytes: 3,
        },
        {
          platforms: ['windows'],
          arch: ['x64'],
          url: githubUrl('Chassis-0.1.11-win-x64.zip'),
          sha256: 'bb'.repeat(32),
          bytes: 3,
        },
      ],
    },
  }
}

test('app：按平台拆包，索引改写成 npmmirror tgz 并保留原 GitHub 为 mirrors', () => {
  const root = tempRoot()
  const release = path.join(root, 'release')
  const staging = path.join(root, 'staging')
  fs.mkdirSync(release, { recursive: true })
  fs.writeFileSync(path.join(release, 'app-registry.json'), JSON.stringify(appRegistry(), null, 2))
  writeZip(release, 'Chassis-0.1.11-macos-arm64.zip')
  writeZip(release, 'Chassis-0.1.11-win-x64.zip')

  const { secret } = makeKey()
  const { status, output } = runPublish(
    ['--channel', 'app', '--dir', release, '--dry-run', '--staging', staging, '--index-version', '0.20261102.42'],
    { INDEX_SIGNING_KEY: secret },
  )
  assertEqual(status, 0, `dry-run 应成功：${output}`)

  const macManifest = JSON.parse(
    fs.readFileSync(path.join(staging, 'triple3h-chassis-app-macos-arm64', 'package.json'), 'utf8'),
  )
  assertEqual(macManifest.name, '@triple3h/chassis-app-macos-arm64')
  assertEqual(macManifest.version, '0.1.11')
  assertEqual(macManifest.os?.[0], 'darwin')
  assertEqual(macManifest.cpu?.[0], 'arm64')

  const indexManifest = JSON.parse(
    fs.readFileSync(path.join(staging, 'triple3h-chassis-index-app', 'package.json'), 'utf8'),
  )
  assertEqual(indexManifest.version, '0.20261102.42')
  assertEqual(typeof indexManifest.chassis.registry, 'string', '索引原文必须以字符串内嵌（签名对象）')

  const registry = JSON.parse(indexManifest.chassis.registry)
  assertEqual(registry.app.minShellHotVersion, '2', '门槛字段必须原样保留')
  assertEqual(registry.app.notes, '修复启动残留')
  assertEqual(registry.app.assets[0].sha256, 'aa'.repeat(32), 'zip 的 sha256 不能变')

  const mac = registry.app.assets[0]
  assertEqual(
    mac.url,
    `${READ_BASE}/@triple3h/chassis-app-macos-arm64/-/chassis-app-macos-arm64-0.1.11.tgz`,
  )
  assertEqual(mac.format, 'tgz')
  assertEqual(mac.entry, 'Chassis-0.1.11-macos-arm64.zip')
  assertEqual(mac.mirrors[0], githubUrl('Chassis-0.1.11-macos-arm64.zip'))

  fs.rmSync(root, { recursive: true, force: true })
})

test('索引签名可被公钥验证，keyId 与公钥指纹一致', () => {
  const root = tempRoot()
  const release = path.join(root, 'release')
  const staging = path.join(root, 'staging')
  fs.mkdirSync(release, { recursive: true })
  fs.writeFileSync(path.join(release, 'app-registry.json'), JSON.stringify(appRegistry(), null, 2))
  writeZip(release, 'Chassis-0.1.11-macos-arm64.zip')
  writeZip(release, 'Chassis-0.1.11-win-x64.zip')

  const { secret, publicKey, keyId } = makeKey()
  const { status, output } = runPublish(
    ['--channel', 'app', '--dir', release, '--dry-run', '--staging', staging],
    { INDEX_SIGNING_KEY: secret },
  )
  assertEqual(status, 0, output)

  const manifest = JSON.parse(
    fs.readFileSync(path.join(staging, 'triple3h-chassis-index-app', 'package.json'), 'utf8'),
  )
  const text = manifest.chassis.registry as string
  const sig = Buffer.from(manifest.chassis.sig as string, 'base64')
  assert(
    crypto.verify(null, Buffer.from(text, 'utf8'), publicKey, sig),
    'chassis.sig 必须能验证 chassis.registry 的原文',
  )
  assertEqual(manifest.chassis.keyId, keyId, 'keyId 应为公钥指纹前缀')
  assert(output.includes('sig'), 'dry-run 输出应带上签名摘要')

  fs.rmSync(root, { recursive: true, force: true })
})

test('插件：只发布有本地产物的插件，索引仍覆盖全量（增量发布不塌陷）', () => {
  const root = tempRoot()
  const release = path.join(root, 'release')
  const staging = path.join(root, 'staging')
  fs.mkdirSync(release, { recursive: true })
  const registry = {
    schema: 1,
    plugins: {
      todo: {
        title: '待办',
        version: '0.1.2',
        apiVersion: '2',
        minKernel: '0.1.9',
        notes: null,
        assets: [
          { platforms: ['macos'], arch: ['arm64'], url: githubUrl('todo-0.1.2-macos-arm64.zip'), sha256: 'cc'.repeat(32), bytes: 3 },
          { platforms: ['windows'], arch: ['x64'], url: githubUrl('todo-0.1.2-windows-x64.zip'), sha256: 'dd'.repeat(32), bytes: 3 },
        ],
      },
      'calc-pad': {
        title: '计算器',
        version: '0.2.0',
        apiVersion: '2',
        minKernel: null,
        notes: null,
        assets: [
          { platforms: ['macos'], arch: ['arm64'], url: githubUrl('calc-pad-0.2.0-macos-arm64.zip'), sha256: 'ee'.repeat(32), bytes: 3 },
          { platforms: ['windows'], arch: ['x64'], url: githubUrl('calc-pad-0.2.0-windows-x64.zip'), sha256: 'ff'.repeat(32), bytes: 3 },
        ],
      },
    },
  }
  fs.writeFileSync(path.join(release, 'registry.json'), JSON.stringify(registry, null, 2))
  writeZip(release, 'todo-0.1.2-macos-arm64.zip')
  writeZip(release, 'todo-0.1.2-windows-x64.zip')

  const { secret } = makeKey()
  const { status, output } = runPublish(
    ['--channel', 'plugins', '--dir', release, '--dry-run', '--staging', staging],
    { INDEX_SIGNING_KEY: secret },
  )
  assertEqual(status, 0, `dry-run 应成功：${output}`)

  const todoDir = path.join(staging, 'triple3h-chassis-plugin-todo')
  assertEqual(fs.readdirSync(todoDir).filter((name) => name.endsWith('.zip')).length, 2, '插件包应含两个平台')
  assert(!fs.existsSync(path.join(staging, 'triple3h-chassis-plugin-calc-pad')), '没本地产物的插件不发包')

  const indexManifest = JSON.parse(
    fs.readFileSync(path.join(staging, 'triple3h-chassis-index-plugins', 'package.json'), 'utf8'),
  )
  const npmRegistry = JSON.parse(indexManifest.chassis.registry)
  assertEqual(
    npmRegistry.plugins['calc-pad'].assets[0].url,
    `${READ_BASE}/@triple3h/chassis-plugin-calc-pad/-/chassis-plugin-calc-pad-0.2.0.tgz`,
    '未重建的插件也必须改写成 npm 地址（客户端不能回落 GitHub）',
  )
  assertEqual(npmRegistry.plugins.todo.assets[1].entry, 'todo-0.1.2-windows-x64.zip')

  fs.rmSync(root, { recursive: true, force: true })
})

test('缺少 INDEX_SIGNING_KEY 必须拒绝（第三方索引不允许未签名发布）', () => {
  const root = tempRoot()
  const release = path.join(root, 'release')
  fs.mkdirSync(release, { recursive: true })
  fs.writeFileSync(path.join(release, 'app-registry.json'), JSON.stringify(appRegistry(), null, 2))
  writeZip(release, 'Chassis-0.1.11-macos-arm64.zip')
  writeZip(release, 'Chassis-0.1.11-win-x64.zip')

  const { status, output } = runPublish(['--channel', 'app', '--dir', release, '--dry-run'], {
    INDEX_SIGNING_KEY: '',
  })
  assert(status !== 0, '缺签名密钥应失败')
  assert(output.includes('INDEX_SIGNING_KEY'), `错误信息应点明缺失项：${output}`)

  fs.rmSync(root, { recursive: true, force: true })
})

test('--configure-trust 只打印 npm trust 命令（不发布）', () => {
  const root = tempRoot()
  const release = path.join(root, 'release')
  fs.mkdirSync(release, { recursive: true })
  fs.writeFileSync(path.join(release, 'app-registry.json'), JSON.stringify(appRegistry(), null, 2))

  const { status, output } = runPublish([
    '--channel',
    'app',
    '--dir',
    release,
    '--configure-trust',
    '--dry-run',
  ])
  assertEqual(status, 0, output)
  assert(
    output.includes(
      'npm trust github @triple3h/chassis-app-macos-arm64 --file app-release.yml --repo Triple3h/Chassis --allow-publish -y',
    ),
    `应打印 macOS 包的 trust 命令：${output}`,
  )
  assert(output.includes('@triple3h/chassis-index-app'), '索引包也要绑定 trusted publisher')

  fs.rmSync(root, { recursive: true, force: true })
})

const failed = await run('npm 更新通道')
if (failed > 0) process.exit(1)
