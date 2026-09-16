#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Vue 四件套（`plugins/{totp,hosts,text-diff,json-tools}`）在**真底座**上的冒烟：
 * 覆盖 docs/first-batch-plugins.md §4 阶段 1 / 阶段 2 里能自动化的部分。
 *
 * 做法：把 4 个插件的 dist 拷成临时「已安装插件」，起真内核（standalone），
 * 然后完全走 HTTP（/api/invoke、/api/bridge、/api/search）模拟启动台 UI 的转发 —— 不起壳、不用浏览器。
 *
 * 覆盖：
 *   · 清单与产物：4 个插件都 active、命令无 error（G1 / §2.2）
 *   · 入口型搜索：搜得到命令、view 会话能开、index.html 与 assets 全部 200（资源路径正确）
 *   · 桥：host.info / hostUi 读写 / footer / storage
 *   · 能力边界：只有 hostUi 的插件调 exec.run 必须被拒 + 审计留痕（阶段 1.3 / N3）
 *   · 脚本：exec.run 真跑 read-image / hosts-read，返回值就是 done(x)（阶段 2.1 / 2.2）
 *   · N2：插件安装目录在整个过程中不得被写入；备份/存储只能落 dataRoot
 *
 * 用法：node scripts/smoke-first-batch.mjs
 * 没构建这些插件时退出码 1，并提示先跑 npm run build:plugins。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kernelEntry = path.join(repoRoot, 'apps', 'kernel', 'dist', 'kernel.mjs')
const pluginsRoot = path.join(repoRoot, 'plugins')

const PLUGINS = [
  { id: 'json-tools', command: 'json', query: 'JSON', capability: ['hostUi'] },
  { id: 'text-diff', command: 'diff', query: '比对', capability: ['hostUi'] },
  { id: 'totp', command: 'totp', query: '验证码', capability: ['storage', 'hostUi', 'screenshot', 'exec.spawn'] },
  { id: 'hosts', command: 'hosts', query: 'hosts', capability: ['storage', 'hostUi', 'exec.spawn'] },
]

function line(text) {
  process.stdout.write(`${text}\n`)
}

if (!fs.existsSync(kernelEntry)) {
  line('✗ 找不到内核产物，先跑 npm run build:kernel')
  process.exit(1)
}
if (!fs.existsSync(pluginsRoot)) {
  line('✗ 找不到 plugins/ 目录')
  process.exit(1)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) line(`  ✓ ${label}`)
  else {
    failures += 1
    line(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* --------------------------------------------------------------- 准备环境 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-first-batch-'))
const dataRoot = path.join(workDir, 'data')
const builtinRoot = path.join(workDir, 'installed')
fs.mkdirSync(builtinRoot, { recursive: true })

/** 安装形态：<builtinRoot>/<pluginId>/ 直接是插件根（与解压 zip 后一致） */
function installPlugins() {
  for (const plugin of PLUGINS) {
    const dist = path.join(pluginsRoot, plugin.id, 'dist')
    if (!fs.existsSync(path.join(dist, 'package.json'))) {
      line(`✗ ${plugin.id} 没有 dist/package.json —— 先跑 npm run build:plugins`)
      process.exit(1)
    }
    fs.cpSync(dist, path.join(builtinRoot, plugin.id), { recursive: true })
  }

}

/** 目录快照：验证 N2「安装目录只读」 */
function snapshot(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        out.push(`${path.relative(dir, full)}/`)
        walk(full)
      } else {
        const stat = fs.statSync(full)
        out.push(`${path.relative(dir, full)}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      }
    }
  }
  walk(dir)
  return out.join('\n')
}

installPlugins()
const installSnapshotBefore = snapshot(builtinRoot)

const child = spawn(
  process.execPath,
  [
    kernelEntry,
    '--standalone',
    '--data-root',
    dataRoot,
    '--builtin-plugins',
    builtinRoot,
    ...(fs.existsSync(path.join(repoRoot, 'apps', 'launcher-ui', 'dist'))
      ? ['--ui-dist', path.join(repoRoot, 'apps', 'launcher-ui', 'dist')]
      : []),
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
child.stdout.on('data', (chunk) => logs.push(chunk))

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

/**
 * 模拟启动台 UI 的转发：插件页 postMessage → UI → 内核 /api/bridge
 * 返回 { id, ok, result } 或 { id, ok:false, error }（与 UI 回给插件页的应答同构）
 */
async function bridge(session, method, params) {
  return post('/api/bridge', { sid: session.sid, token: session.token, id: 1, method, params })
}

async function openSession(pluginId, command) {
  const invoked = await post('/api/invoke', { id: `${pluginId}:${command}` })
  const result = invoked.result
  if (!result?.ok || !result.data?.url) return { error: result?.error ?? { code: 'FAILED', message: '未返回会话' } }
  const url = new URL(result.data.url)
  return { sid: url.searchParams.get('sid'), token: url.searchParams.get('token'), url: result.data.url }
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

try {
  if (!(await waitReady())) {
    line('✗ 内核未在 15s 内就绪')
    line(logs.join(''))
    process.exit(1)
  }
  line(`内核已就绪：${base}`)
  line(`数据目录：${dataRoot}`)
  line(`插件来源：${pluginsRoot}\n`)

  /* ------------------------------------------------------------ 阶段 1：加载 */
  line('[加载] 清单与产物')
  const bootstrap = await fetch(`${base}/api/bootstrap`).then((res) => res.json())
  const loaded = new Map(bootstrap.plugins.map((plugin) => [plugin.id, plugin]))
  for (const plugin of PLUGINS) {
    const info = loaded.get(plugin.id)
    if (!info) {
      check(false, `${plugin.id} 已加载`, '未出现在 bootstrap 里')
      continue
    }
    const errors = info.commands.filter((command) => command.error)
    check(
      info.state === 'active' && errors.length === 0,
      `${plugin.id} active，命令 ${info.commands.length} 条`,
      `state=${info.state} ${errors.map((c) => `${c.name}:${c.error}`).join(' ')}`,
    )
  }

  /* -------------------------------------------------- 阶段 1：入口型搜索 + 会话 */
  line('\n[阶段 1] 入口型搜索与 view 会话')
  for (const plugin of PLUGINS) {
    const search = await post('/api/search', { query: plugin.query })
    const hit = search.groups.best.find((item) => item.pluginId === plugin.id)
    check(Boolean(hit), `搜「${plugin.query}」命中 ${plugin.id}`, JSON.stringify(search.groups.best.map((i) => i.pluginId)))
  }

  const jsonSession = await openSession('json-tools', 'json')
  check(Boolean(jsonSession.sid && jsonSession.token), 'json-tools 打开会话拿到 sid/token', JSON.stringify(jsonSession.error))

  if (jsonSession.sid) {
    const htmlRes = await fetch(jsonSession.url)
    const html = htmlRes.ok ? await htmlRes.text() : ''
    check(htmlRes.status === 200 && html.includes('<div id="app"'), 'index.html 200 且含挂载点', `status=${htmlRes.status}`)

    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
    const assetResults = []
    for (const ref of refs) {
      if (/^https?:/.test(ref)) continue
      const assetUrl = new URL(ref, jsonSession.url)
      const res = await fetch(assetUrl)
      assetResults.push(`${ref}:${res.status}`)
    }
    check(
      assetResults.length > 0 && assetResults.every((item) => item.endsWith(':200')),
      '生产构建的资源全路径可达（assets 全部 200）',
      assetResults.join(' '),
    )
  }

  /* --------------------------------------------------------- 阶段 1：桥与能力 */
  line('\n[阶段 1] 宿主桥（hostUi / footer / 存储）')
  if (jsonSession.sid) {
    // 搜索会把当前输入同步进宿主搜索框（hostUi.state.searchContent）
    await post('/api/search', { query: '{"a":1}' })
    const content = await bridge(jsonSession, 'ctx.hostUi.getSearchContent')
    check(content.ok === true && content.result === '{"a":1}', 'hostUi.getSearchContent 拿到入口输入', JSON.stringify(content))

    const info = await bridge(jsonSession, 'ctx.host.info')
    check(
      info.ok === true && info.result.pluginId === 'json-tools' && info.result.command === 'json',
      'host.info 返回当前插件与命令',
      JSON.stringify(info),
    )

    const footer = await bridge(jsonSession, 'ctx.hostUi.setFooter', {
      buttons: [
        { type: 'button', id: 'button:0', label: '格式化', icon: 'Check', keys: ['Mod+Enter'] },
        { type: 'button', id: 'button:1', label: '树视图', icon: 'Braces', keys: ['Mod+E'] },
      ],
    })
    check(footer.ok === true && footer.result === true, 'hostUi.setFooter 注册成功', JSON.stringify(footer))

    const denied = await bridge(jsonSession, 'ctx.exec.run', { command: 'json', args: {} })
    check(
      denied.ok === false && (denied.error?.code === 'CAPABILITY_DENIED' || denied.error?.code === 'NOT_FOUND'),
      '未声明 exec.spawn ⇒ 调用脚本被拒（能力即权限）',
      JSON.stringify(denied),
    )
  }

  /* --------------------------------------------- 阶段 2：脚本（真读本机文件） */
  line('\n[阶段 2] 脚本命令（exec.run → Node Worker）')

  const hostsSession = await openSession('hosts', 'hosts')
  check(Boolean(hostsSession.sid), 'hosts 打开会话', JSON.stringify(hostsSession.error))

  if (hostsSession.sid) {
    const read = await bridge(hostsSession, 'ctx.exec.run', { command: 'hosts-read', args: {}, timeoutMs: 15000 })
    const readValue = read.result
    check(
      read.ok === true && readValue?.ok === true && typeof readValue.content === 'string' && readValue.path.includes('hosts'),
      'hosts-read 返回系统 hosts 内容（done(x) 原样透传）',
      JSON.stringify(read).slice(0, 200),
    )

    const before = readValue?.content
    const rejected = await bridge(hostsSession, 'ctx.exec.run', {
      command: 'hosts-write',
      args: { content: '   \n' },
      timeoutMs: 15000,
    })
    check(
      rejected.ok === true && rejected.result?.ok === false && /内容为空/.test(rejected.result?.error ?? ''),
      'hosts-write 拒绝空内容（不会把本机解析写废）',
      JSON.stringify(rejected).slice(0, 200),
    )
    const after = await bridge(hostsSession, 'ctx.exec.run', { command: 'hosts-read', args: {}, timeoutMs: 15000 })
    check(after.result?.content === before, '拒绝写入后 /etc/hosts 原样未动')

    const stored = await bridge(hostsSession, 'ctx.storage.set', { key: 'smoke', value: { at: 1 } })
    const back = await bridge(hostsSession, 'ctx.storage.get', { key: 'smoke' })
    check(stored.ok === true && back.result?.at === 1, 'storage 读写回到同一份数据', JSON.stringify(back))
    // 落盘是 debounce + 原子写（200ms），等一下再断言文件
    await sleep(500)
    const storageFile = path.join(dataRoot, 'plugins', 'hosts', 'storage.json')
    const onDisk = fs.existsSync(storageFile) ? JSON.parse(fs.readFileSync(storageFile, 'utf-8')) : null
    check(
      onDisk?.smoke?.at === 1,
      '存储落在 <dataRoot>/plugins/hosts/storage.json',
      fs.existsSync(storageFile) ? storageFile : '文件不存在',
    )
  }

  const totpSession = await openSession('totp', 'totp')
  if (totpSession.sid) {
    const images = await bridge(totpSession, 'ctx.exec.run', {
      command: 'read-image',
      args: { listOnly: true, withinMinutes: 240, limit: 5 },
      timeoutMs: 15000,
    })
    check(
      images.ok === true && images.result?.ok === true && Array.isArray(images.result.files),
      `read-image 扫描最近图片（${images.result?.files?.length ?? '?'} 张候选）`,
      JSON.stringify(images).slice(0, 200),
    )
  }

  /* -------------------------------------------------------------- 审计 / N2 */
  line('\n[审计] 能力与数据目录')
  const audit = await fetch(`${base}/api/audit?limit=200`).then((res) => res.json())
  const failuresInAudit = audit.records.filter((record) => !record.ok)
  const deniedRecords = failuresInAudit.filter((record) => record.error?.code === 'CAPABILITY_DENIED')
  check(failuresInAudit.length === deniedRecords.length, '审计里只有「故意越权」那类失败', JSON.stringify(failuresInAudit.slice(0, 5)))
  check(deniedRecords.length >= 1, '越权调用在审计里留痕（阶段 1.3）')

  const installSnapshotAfter = snapshot(builtinRoot)
  check(installSnapshotBefore === installSnapshotAfter, '插件安装目录全程只读（N2）')

  const pluginDataDirs = fs.existsSync(path.join(dataRoot, 'plugins'))
    ? fs.readdirSync(path.join(dataRoot, 'plugins')).sort()
    : []
  line(`  · dataRoot/plugins 下的数据目录：${pluginDataDirs.join(', ') || '（空）'}`)

  if (failures > 0) {
    line('\n[内核日志尾部]')
    line(logs.join('').split('\n').slice(-30).join('\n'))
  }
} catch (err) {
  failures += 1
  line(`✗ 冒烟异常：${err instanceof Error ? err.stack : String(err)}`)
} finally {
  child.kill('SIGTERM')
  await sleep(400)
  fs.rmSync(workDir, { recursive: true, force: true })
}

line(`\n${failures === 0 ? '首批插件冒烟通过 ✓' : `首批插件冒烟失败：${failures} 项 ✗`}`)
process.exit(failures === 0 ? 0 : 1)
