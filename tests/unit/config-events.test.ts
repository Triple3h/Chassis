/**
 * 守「配置改完必须广播」这条链路。
 *
 * 主题 / 主题色 / 密度这三项，值只有启动台 UI 知道怎么落到界面上
 * （`data-theme` / `--color-accent` / `data-density`）。内核写完配置文件**不广播**的话，
 * UI 的 config 快照会一直停在旧值，只能等下一次 `plugin/state`（比如去改插件）或重启才刷新 ——
 * 表现出来就是「主题色在设置里改了，界面纹丝不动」，而 config.json 里其实早就写进去了。
 *
 * 三条写入口都要广播（`Kernel::patch_config` 是唯一收口）：
 * `POST /api/config`、管理面 `ctx.settings.patch` / `setHistoryLimit`。
 * 上次只补了 HTTP 那条，用户从设置页改主题依旧没反应，就是漏了管理面那条。
 *
 * 顺带守 sanitize：广播出去的必须是**落盘后**的值，否则 UI 会照着非法值去算 CSS 变量。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

interface Appearance {
  accent?: string
  theme?: string
  density?: string
  historyLimit?: number
}

// 设置页那条路要一个 `internal-` 前缀的插件才有管理面权限（ADR-0003）
const internalPlugin = path.join('extensions', 'internal-probe', 'dist')

const h = await createHarness({
  label: 'config-events',
  seed: async (dataRoot) => {
    const dir = path.join(dataRoot, internalPlugin)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'internal-probe',
        title: '管理面探针',
        version: '1.0.0',
        type: 'module',
        apiVersion: '1',
        capabilities: [],
        commands: [{ name: 'main', title: '入口', mode: 'view' }],
      }),
    )
    await fsp.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>probe</title>')
  },
})

/** 收 `config/changed` 广播（SSE，UI 走的同一条） */
async function record(): Promise<{ seen: Appearance[]; stop: () => void }> {
  const seen: Appearance[] = []
  const sub = h.subscribe((event) => {
    if (event.event !== 'config/changed') return
    const config = (event.data as { config?: Appearance } | undefined)?.config
    if (config) seen.push(config)
  })
  await sub.ready
  return { seen, stop: sub.stop }
}

test('改主题色 / 主题 / 密度后内核广播 config/changed，payload 带新值', async () => {
  const { seen, stop } = await record()
  await h.api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ accent: '#ff8800', theme: 'dark', density: 'compact' }),
  })
  await h.waitFor(() => seen.length >= 1, 3000, 'config/changed 广播')
  stop()

  assertEqual(seen.length, 1, `应当广播且只广播一次，实际 ${seen.length} 次`)
  assertEqual(seen[0]?.accent, '#ff8800', '广播里要带新的主题色，UI 才不会停在旧颜色')
  assertEqual(seen[0]?.theme, 'dark')
  assertEqual(seen[0]?.density, 'compact')
})

test('非法主题色被 sanitize，广播的必须是落盘后的值', async () => {
  const { seen, stop } = await record()
  const res = await h.api<{ ok: boolean; config: Appearance }>('/api/config', {
    method: 'POST',
    body: JSON.stringify({ accent: '不是颜色' }),
  })
  await h.waitFor(() => seen.length >= 1, 3000, 'config/changed 广播')
  stop()

  assertEqual(seen.length, 1)
  assertEqual(seen[0]?.accent, res.config.accent, 'UI 拿到的一定是能直接用进 CSS 的值（= 落盘值）')
  assert(/^#[0-9a-f]{6}$/i.test(String(seen[0]?.accent)), `非法值必须被兜底，实际：${seen[0]?.accent}`)
})

test('改非外观项（热键）同样广播，UI 不必为此单独开一条通道', async () => {
  const { seen, stop } = await record()
  await h.api('/api/config', { method: 'POST', body: JSON.stringify({ hotkey: { accelerator: 'Alt+Shift+K' } }) })
  await h.waitFor(() => seen.length >= 1, 3000, 'config/changed 广播')
  stop()

  assertEqual(seen.length, 1, '热键分支会提前 return，广播必须排在它前面')
  assertEqual(seen[0]?.accent, (await h.config()).accent, 'payload 是完整配置，不是只挑了改动字段')
})

test('设置页那条路径（ctx.settings.patch）同样广播 —— 它不走 /api/config', async () => {
  const { sid, token } = await h.openSession('internal-probe', 'main')
  const { seen, stop } = await record()
  const patched = await h.bridge(sid, token, 'ctx.settings.patch', { patch: { theme: 'dark', accent: '#00d084' } })
  assertEqual(patched.ok, true, `patch 应当成功：${JSON.stringify(patched.error ?? {})}`)
  const limit = await h.bridge(sid, token, 'ctx.settings.setHistoryLimit', { limit: 300 })
  assertEqual(limit.ok, true, `setHistoryLimit 应当成功：${JSON.stringify(limit.error ?? {})}`)
  await h.waitFor(() => seen.length >= 2, 3000, '两次 config/changed 广播')
  stop()

  assertEqual(seen.length, 2, `两次写入应当各广播一次，实际 ${seen.length} 次`)
  assertEqual(seen[0]?.theme, 'dark', '主题要带出来')
  assertEqual(seen[0]?.accent, '#00d084')
  assertEqual(seen[1]?.historyLimit, 300, '历史上限这类也在同一收口里')
})

const failed = await run('配置变更广播')
await h.stop()
if (failed > 0) process.exit(1)
