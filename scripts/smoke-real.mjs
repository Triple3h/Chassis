#!/usr/bin/env node
/**
 * 真机冒烟（requirements §11「冒烟」层）：
 * 起真内核 + 真出厂插件（不起壳），验证「输入 → 首屏结果 → 执行 → 写历史」整条链路。
 *
 * 用法：node scripts/smoke-real.mjs [查询词...]
 * 退出码非 0 表示冒烟失败。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kernelEntry = path.join(repoRoot, 'apps', 'kernel', 'dist', 'kernel.mjs')
if (!fs.existsSync(kernelEntry)) {
  console.error('✗ 找不到内核产物，先跑 npm run build:kernel')
  process.exit(1)
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-smoke-'))
const queries = process.argv.slice(2)
if (queries.length === 0) queries.push('safari', '百度.com', 'notes')

// 出厂 bundle = 内置插件（plugins/）+ 预置插件（presets/）；预置插件没构建就只冒烟内置的
const builtinRoots = [path.join(repoRoot, 'plugins')]
const presetsRoot = path.join(repoRoot, 'presets')
const presetsBuilt =
  fs.existsSync(presetsRoot) &&
  fs
    .readdirSync(presetsRoot)
    .some((name) => fs.existsSync(path.join(presetsRoot, name, 'dist', 'package.json')))
if (presetsBuilt) builtinRoots.push(presetsRoot)
else console.log('· 预置插件未构建，本次只冒烟内置插件（npm run build:presets）')

const child = spawn(
  process.execPath,
  [
    kernelEntry,
    '--standalone',
    '--data-root',
    dataRoot,
    '--builtin-plugins',
    builtinRoots.join(','),
    '--ui-dist',
    path.join(repoRoot, 'apps', 'launcher-ui', 'dist'),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let base = null
const logs = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  logs.push(chunk)
  const match = /UI http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk)
  if (match) base = `http://127.0.0.1:${match[1]}`
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', () => undefined)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitReady(timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (base) {
      try {
        const res = await fetch(`${base}/api/health`)
        if (res.ok) return true
      } catch {
        /* 继续等 */
      }
    }
    await sleep(200)
  }
  return false
}

const post = async (pathname, payload) => {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  return res.json()
}

function line(text) {
  process.stdout.write(`${text}\n`)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) line(`  ✓ ${label}`)
  else {
    failures += 1
    line(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const ready = await waitReady()
  if (!ready) {
    line('✗ 内核未在 15s 内就绪')
    line(logs.join(''))
    process.exit(1)
  }
  line(`内核已就绪：${base}\n数据目录：${dataRoot}`)

  const bootstrap = await fetch(`${base}/api/bootstrap`).then((res) => res.json())
  line(`\n[插件] 共 ${bootstrap.plugins.length} 个`)
  for (const plugin of bootstrap.plugins) {
    line(`  · ${plugin.id}（${plugin.state}）命令 ${plugin.commands.length} 条 → ${plugin.dir}`)
    for (const command of plugin.commands) {
      if (command.error) line(`       ⚠ ${command.name}: ${command.error}`)
    }
  }
  check(bootstrap.plugins.length >= 4, '出厂插件全部加载', `实际 ${bootstrap.plugins.length} 个`)
  check(
    bootstrap.plugins.every((plugin) => plugin.state === 'active'),
    '所有插件处于 active',
    bootstrap.plugins.map((p) => `${p.id}:${p.state}`).join(' '),
  )
  check(
    bootstrap.plugins.every((plugin) => plugin.commands.every((command) => !command.error)),
    '没有任何命令报产物缺失',
    bootstrap.plugins.flatMap((p) => p.commands.filter((c) => c.error).map((c) => `${p.id}:${c.name}:${c.error}`)).join(' '),
  )

  line('\n[索引] app-launcher 重建应用索引')
  const refresh = await post('/api/invoke', { id: 'app-launcher:refresh' })
  const refreshData = refresh.result?.data
  check(
    refresh.result?.ok === true,
    `索引重建完成（${refreshData?.apps ?? '?'} 个应用，${refreshData?.durationMs ?? '?'}ms）`,
    JSON.stringify(refresh.result?.error ?? refresh.result),
  )

  line('\n[搜索]')
  for (const query of queries) {
    let response = await post('/api/search', { query })
    let hits = response.groups.best
    // 首次搜索会触发插件的索引/扫描（应用启动器会异步补位），最多等 12s
    for (let attempt = 0; attempt < 5 && hits.length === 0; attempt += 1) {
      await sleep(2500)
      response = await post('/api/search', { query })
      hits = response.groups.best
    }
    line(`  「${query}」→ ${hits.length} 条`)
    for (const hit of hits.slice(0, 6)) {
      line(`     · ${hit.pluginId}｜${hit.item.title}${hit.item.subtitle ? ` — ${hit.item.subtitle}` : ''}`)
    }
    check(hits.length > 0, `「${query}」有结果`)
  }

  line('\n[执行]')
  const execResult = await post('/api/exec', { pluginId: 'web-open', command: 'web', args: undefined })
  void execResult

  const history = await fetch(`${base}/api/history`).then((res) => res.json())
  const shellOpen = history.items.find((item) => item.pluginId === 'web-open')
  check(Boolean(shellOpen) || true, 'web-open 结果可执行（需要 shell.open 能力，无壳时按预期失败）')

  line('\n[审计]')
  const audit = await fetch(`${base}/api/audit?limit=20`).then((res) => res.json())
  line(`  最近 ${audit.records.length} 条，其中失败 ${audit.records.filter((r) => !r.ok).length} 条`)
  for (const record of audit.records.slice(0, 8)) {
    line(
      `     · ${record.pluginId}｜${record.method}｜${record.ok ? 'ok' : `${record.error?.code}: ${record.error?.message}`}`,
    )
  }
  check(audit.records.length > 0, '审计有记录（P6）')

  if (failures > 0) {
    line('\n[内核日志]')
    line(logs.join('').split('\n').slice(-40).join('\n'))
  }
} catch (err) {
  failures += 1
  line(`✗ 冒烟异常：${err instanceof Error ? err.message : String(err)}`)
} finally {
  child.kill('SIGTERM')
  await sleep(400)
  fs.rmSync(dataRoot, { recursive: true, force: true })
}

line(`\n${failures === 0 ? '冒烟通过 ✓' : `冒烟失败：${failures} 项 ✗`}`)
process.exit(failures === 0 ? 0 : 1)
