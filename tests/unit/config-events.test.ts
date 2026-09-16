/**
 * 守「配置改完必须广播」这条链路。
 *
 * 主题 / 主题色 / 密度这三项，值只有启动台 UI 知道怎么落到界面上
 * （`data-theme` / `--color-accent` / `data-density`）。内核写完配置文件**不广播**的话，
 * UI 的 config 快照会一直停在旧值，只能等下一次 `plugin/state`（比如去改插件）或重启才刷新 ——
 * 表现出来就是「主题色在设置里改了，界面纹丝不动」，而 config.json 里其实早就写进去了。
 *
 * 顺带守 sanitize：广播出去的必须是**落盘后**的值，否则 UI 会照着非法值去算 CSS 变量。
 */
import { assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

interface Appearance {
  accent?: string
  theme?: string
  density?: string
}

const h = await createHarness({ label: 'config-events' })

function record(): { seen: Appearance[]; stop: () => void } {
  const seen: Appearance[] = []
  const off = h.kernel.bus.on('config/changed', (payload) => {
    const config = (payload as { config?: Appearance } | undefined)?.config
    if (config) seen.push(config)
  })
  return { seen, stop: off }
}

test('改主题色 / 主题 / 密度后内核广播 config/changed，payload 带新值', async () => {
  const { seen, stop } = record()
  await h.api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ accent: '#ff8800', theme: 'dark', density: 'compact' }),
  })
  stop()

  assertEqual(seen.length, 1, `应当广播且只广播一次，实际 ${seen.length} 次`)
  assertEqual(seen[0]?.accent, '#ff8800', '广播里要带新的主题色，UI 才不会停在旧颜色')
  assertEqual(seen[0]?.theme, 'dark')
  assertEqual(seen[0]?.density, 'compact')
})

test('非法主题色被 sanitize 回落默认值，广播的也是默认值', async () => {
  const { seen, stop } = record()
  await h.api('/api/config', { method: 'POST', body: JSON.stringify({ accent: '不是颜色' }) })
  stop()

  assertEqual(seen.length, 1)
  assertEqual(seen[0]?.accent, h.kernel.defaultConfig.accent, 'UI 拿到的一定是能直接用进 CSS 的值')
})

test('改非外观项（热键）同样广播，UI 不必为此单独开一条通道', async () => {
  const { seen, stop } = record()
  await h.api('/api/config', { method: 'POST', body: JSON.stringify({ hotkey: { accelerator: 'Alt+Shift+K' } }) })
  stop()

  assertEqual(seen.length, 1, '热键分支会提前 return，广播必须排在它前面')
  assertEqual(seen[0]?.accent, h.kernel.config.get().accent, 'payload 是完整配置，不是只挑了改动字段')
})

const failed = await run('配置变更广播')
await h.stop()
if (failed > 0) process.exit(1)
