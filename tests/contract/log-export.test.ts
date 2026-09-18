/**
 * 导出内核日志（设置 → 关于 → 导出日志）的契约。
 *
 * `ctx.settings.exportLogs` 走 view 桥 → 内核汇总「插件状态 + 内核日志 + 审计摘要」
 * → 写 `<dataRoot>/logs/exports/*.txt`（壳连接时还会在访达中显示）。
 *
 * 黑盒形态：装真出厂插件（internal-settings 是 essential，只认出厂根），
 * 断言只读**返回的路径与文件内容** —— 导出文件就是用户发给开发者 / AI 助手的那份东西。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness, repoRoot } from '../helpers/harness'

interface ExportResult {
  scope: string
  filename: string
  path: string
  bytes: number
  entries: number
  auditEntries: number
  truncated: boolean
  revealed: boolean
}

const h = await createHarness({ label: 'log-export', builtinRoots: [path.join(repoRoot, 'plugins')] })

async function exportLogs(scope: string): Promise<ExportResult> {
  const { sid, token } = await h.openSession('internal-settings', 'settings')
  const response = await h.bridge(sid, token, 'ctx.settings.exportLogs', { scope })
  assertEqual(response.ok, true, `导出失败：${JSON.stringify(response.error ?? {})}`)
  return response.result as unknown as ExportResult
}

test('导出最近一次会话：含插件状态、内核日志与审计区', async () => {
  const payload = await exportLogs('session')
  assertEqual(payload.scope, 'session')
  assertEqual(payload.revealed, false, '（standalone 没有壳）不该声称已在访达中显示')
  assert(payload.filename.endsWith('.txt'), payload.filename)
  assert(payload.bytes > 200, `导出文件不该是空的：${payload.bytes} 字节`)
  assert(payload.entries > 0, '内核日志不该是空的')

  const text = await fsp.readFile(payload.path, 'utf-8')
  assert(text.includes('Chassis 内核诊断日志'), '应有诊断头部')
  assert(text.includes('导出范围：最近一次会话'), '头部应写明范围')
  assert(text.includes('── 插件状态'), '应有插件状态区')
  assert(text.includes('internal-settings'), '插件状态应列出设置插件')
  assert(text.includes('插件扫描：发现'), '内核日志应含插件扫描记录')
  assert(text.includes('插件已激活：'), '内核日志应含插件加载记录')
  assert(text.includes('── 内核日志'), '应有内核日志区')
  assert(text.includes('── 审计日志'), '应有审计子区')
})

test('导出全部日志：以 kernel.log 为源，落在 logs/exports/', async () => {
  const payload = await exportLogs('all')
  assertEqual(payload.scope, 'all')
  assert(payload.path.includes(`${path.sep}logs${path.sep}exports${path.sep}`), payload.path)

  const text = await fsp.readFile(payload.path, 'utf-8')
  assert(text.includes('导出范围：全部日志'), '头部应写明范围')
  assert(text.includes('内核日志文件：'), '应给出内核日志落点')

  // 「全部日志」的来源是 <dataRoot>/logs/kernel.log：最后一行必须出现在导出里
  const logFile = await fsp.readFile(path.join(h.dataRoot, 'logs', 'kernel.log'), 'utf-8')
  const lastLine = logFile.trim().split('\n').at(-1) ?? ''
  assert(lastLine.length > 0, '内核日志文件不该是空的')
  assert(text.includes(lastLine), `导出应包含 kernel.log 的最后一行：${lastLine}`)
})

test('未知范围按「最近一次会话」处理', async () => {
  const payload = await exportLogs('nope')
  assertEqual(payload.scope, 'session')
})

const failed = await run('导出内核日志契约')
await h.stop()
if (failed > 0) process.exit(1)
