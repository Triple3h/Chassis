#!/usr/bin/env node
/**
 * 用 esbuild 打包 TS 后交给 node（requirements §5 / §11：无测试框架）。
 * 产物落在仓库内 .dev/，这样第三方依赖能从 node_modules 正常解析。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const entry = args.shift()

if (!entry) {
  console.error('用法: node scripts/run-ts.mjs <file.ts> [...nodeArgs]')
  process.exit(1)
}

const absEntry = path.resolve(entry)
if (!fs.existsSync(absEntry)) {
  console.error(`找不到入口：${absEntry}`)
  process.exit(1)
}

const outDir = path.join(repoRoot, '.dev')
fs.mkdirSync(outDir, { recursive: true })
const rel = path.relative(repoRoot, absEntry).replace(/[\\/]/g, '_').replace(/\.ts$/, '')
const outfile = path.join(outDir, `${rel}.mjs`)

const result = await build({
  entryPoints: [absEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,

  logLevel: 'warning',
  sourcemap: 'inline',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})

if (result.errors.length > 0) process.exit(1)

const child = spawnSync(process.execPath, [outfile, ...args], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: { ...process.env, LAUNCHER_REPO_ROOT: repoRoot },
})
process.exit(child.status ?? 1)
