#!/usr/bin/env node
/**
 * 对所有带 tsconfig.json 的工作区包执行类型检查。
 *
 * 两种编译器：
 *  - 普通 TS 包（含 esbuild 工具链的插件）：根目录的 `tsc -p`;
 *  - **vue 工程**（`plugins/{totp,host-manager,text-diff,json-tools}`）：它们有自己的 `vue-tsc`（`tsc` 认不了 `.vue`），
 *    所以走包自己的 `typecheck` 脚本 —— 判定依据是源码里有 `.vue` 文件。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tscBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')

const roots = ['packages', 'apps', 'plugins', 'tests'].map((r) => path.join(repoRoot, r))
const dirs = []

function collect(dir) {
  if (!fs.existsSync(dir)) return
  if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
    dirs.push(dir)
    return
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    collect(path.join(dir, entry.name))
  }
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 源码里有没有 .vue —— 有的话只能用 vue-tsc（扫包内任意位置，跳过产物与依赖） */
function hasVueSource(dir) {
  const skip = new Set(['node_modules', 'dist', '.git'])
  try {
    return fs.readdirSync(dir, { recursive: true }).some((entry) => {
      const name = String(entry)
      if (!name.endsWith('.vue')) return false
      return !name.split(path.sep).some((segment) => skip.has(segment))
    })
  } catch {
    return false
  }
}

for (const root of roots) collect(root)

let failed = 0
for (const dir of dirs.sort()) {
  const rel = path.relative(repoRoot, dir)
  const pkg = readPackage(dir)
  const useOwnScript = Boolean(pkg?.scripts?.typecheck) && hasVueSource(dir)

  process.stdout.write(`\n▶ ${useOwnScript ? 'vue-tsc' : 'tsc'} ${rel}\n`)
  const result = useOwnScript
    ? spawnSync('pnpm', ['--filter', pkg.name, 'run', 'typecheck'], { stdio: 'inherit', cwd: repoRoot })
    : spawnSync(tscBin, ['-p', dir], { stdio: 'inherit', cwd: repoRoot })
  if (result.status !== 0) failed += 1
}

console.log(`\n${'─'.repeat(60)}`)
if (failed > 0) {
  console.error(`typecheck 失败：${failed}/${dirs.length} 个包`)
  process.exit(1)
}
console.log(`typecheck 通过：${dirs.length} 个包`)
