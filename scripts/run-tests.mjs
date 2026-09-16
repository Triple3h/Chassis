#!/usr/bin/env node
/**
 * 无框架测试运行器：打包每个 *.test.ts 并串行执行，汇总结果。
 * 用法：node scripts/run-tests.mjs [unit|contract|smoke|all]
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scope = process.argv[2] ?? 'all'

const ROOTS = {
  unit: ['tests/unit', 'packages', 'apps'],
  contract: ['tests/contract'],
  smoke: ['tests/smoke'],
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

// plugins：适配层与各插件自己的单测（core/script 用例）也纳入统一入口
const roots = scope === 'all' ? ['packages', 'apps', 'tests', 'plugins'] : (ROOTS[scope] ?? [scope])
const files = [...new Set(roots.flatMap((r) => walk(path.join(repoRoot, r))))].sort()

if (files.length === 0) {
  console.log('没有找到测试文件')
  process.exit(0)
}

let passed = 0
const failures = []

for (const file of files) {
  const rel = path.relative(repoRoot, file)
  process.stdout.write(`\n▶ ${rel}\n`)
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'run-ts.mjs'), file], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, LAUNCHER_REPO_ROOT: repoRoot, LAUNCHER_TEST: '1' },
  })
  if (result.status === 0) passed += 1
  else failures.push(rel)
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`测试文件：${files.length} 个，通过 ${passed}，失败 ${failures.length}`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
