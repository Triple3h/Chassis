#!/usr/bin/env node
/**
 * 插件构建：产出 plugin-spec §2.2 规定的 dist/。
 *  - 每个 no-view / script 命令：单独 esbuild 打包成自包含 `dist/<name>.mjs`（N1 铁律：多入口逐个构建）
 *  - view 命令：`dist/index.html` + `dist/assets/*`（资源路径相对）
 *  - `dist/package.json`：只保留清单字段（剥掉 scripts / devDependencies）
 *
 * 用法：node scripts/build-plugin.mjs <插件目录名或路径>
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/build-plugin.mjs <插件目录>')
  process.exit(1)
}

// 支持三种写法：绝对路径 / 仓库内相对路径（tests/fixtures/x）/ 仅目录名（plugins/x）
const fromRepo = path.resolve(repoRoot, target)
const dir = path.isAbsolute(target)
  ? target
  : fs.existsSync(fromRepo)
    ? fromRepo
    : path.resolve(repoRoot, 'plugins', target)
const pkgPath = path.join(dir, 'package.json')
if (!fs.existsSync(pkgPath)) {
  console.error(`找不到插件清单：${pkgPath}`)
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const dist = path.join(dir, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

const MANIFEST_FIELDS = [
  'name',
  'title',
  'version',
  'type',
  'apiVersion',
  'capabilities',
  'commands',
  'description',
  'author',
  'icon',
  'keywords',
  'categories',
]

const commands = pkg.commands ?? []
const scriptCommands = commands.filter((c) => c.mode !== 'view')
const viewCommands = commands.filter((c) => c.mode === 'view')
const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
}

// 1) 脚本入口：逐个构建，保证自包含
for (const command of scriptCommands) {
  const candidates = [
    `src/no-view/${command.name}.ts`,
    `src/scripts/${command.name}.ts`,
    `src/${command.name}.ts`,
    `src/no-view/${command.name}.js`,
    `src/${command.name}.js`,
  ]
  const entry = candidates.map((c) => path.join(dir, c)).find((p) => fs.existsSync(p))
  if (!entry) {
    console.error(`✗ ${pkg.name}: 命令 ${command.name} 找不到入口（尝试：${candidates.join(', ')}）`)
    process.exit(1)
  }
  // 必须自包含（plugin-spec N1）：只允许 node:* 是外部依赖
  const outfile = path.join(dist, `${command.name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    logLevel: 'warning',
    banner,
  })

  // 自包含校验（plugin-spec §2.2 的验收：`import` 只应出现 node:*）
  const code = fs.readFileSync(outfile, 'utf8')
  const imports = [...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  const requires = [...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const bad = [...new Set([...imports, ...requires])].filter((name) => !name.startsWith('node:'))
  if (bad.length > 0) {
    console.error(
      `✗ ${pkg.name}/${command.name}.mjs 不是自包含产物，含外部依赖：${bad.join(', ')}\n` +
        '  （plugin-spec N1：产物必须自包含。常见原因：依赖内部使用运行时 require）',
    )
    process.exit(1)
  }
}

// 2) view 入口
if (viewCommands.length > 0) {
  const html = path.join(dir, 'index.html')
  if (!fs.existsSync(html)) {
    console.error(`✗ ${pkg.name}: 有 view 命令但缺少 index.html`)
    process.exit(1)
  }
  let htmlText = fs.readFileSync(html, 'utf8')
  const viewEntry = ['src/view/main.ts', 'src/view/main.js', 'src/main.ts', 'src/main.js']
    .map((c) => path.join(dir, c))
    .find((p) => fs.existsSync(p))
  if (viewEntry) {
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
    await build({
      entryPoints: [viewEntry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'safari16',
      outfile: path.join(dist, 'assets', 'main.js'),
      logLevel: 'warning',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    if (!htmlText.includes('assets/main.js')) {
      htmlText = htmlText.replace('</body>', '    <script type="module" src="./assets/main.js"></script>\n  </body>')
    }
  }
  fs.writeFileSync(path.join(dist, 'index.html'), htmlText)
}

// 3) 静态资源
for (const assetDir of ['assets', 'public']) {
  const from = path.join(dir, assetDir)
  if (assetDir === 'assets' && viewCommands.length > 0) continue
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) continue
  const to = assetDir === 'public' ? dist : path.join(dist, 'assets')
  fs.cpSync(from, to, { recursive: true })
}

// 4) 裁剪后的清单
const manifest = {}
for (const field of MANIFEST_FIELDS) {
  if (pkg[field] !== undefined) manifest[field] = pkg[field]
}
manifest.type = 'module'
fs.writeFileSync(path.join(dist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`✓ ${pkg.name} → dist/（${scriptCommands.length} 个脚本入口，${viewCommands.length} 个 view）`)
