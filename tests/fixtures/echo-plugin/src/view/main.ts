/**
 * 契约自检页：逐条调用宿主 API，把结果与错误码打到页面上。
 * Playwright 直连 `http://127.0.0.1:<port>` 时也能跑（requirements §11 E2E）。
 */
import {
  clipboard,
  commands,
  exec,
  host,
  hostUi,
  notify,
  quicklink,
  screenshot,
  search,
  searchResult,
  shell,
  storage,
} from '@launcher/api'

interface CheckResult {
  method: string
  ok: boolean
  detail: string
}

const root = document.getElementById('root') as HTMLElement
const results: CheckResult[] = []

function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] ?? ch)
}

async function check(method: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const value = await fn()
    results.push({ method, ok: true, detail: typeof value === 'string' ? value : JSON.stringify(value) })
  } catch (err) {
    const error = err as { code?: string; message?: string }
    results.push({ method, ok: false, detail: `${error.code ?? 'ERR'}: ${error.message ?? String(err)}` })
  }
}

function render(): void {
  root.innerHTML = results
    .map(
      (item) =>
        `<div class="${item.ok ? 'ok' : 'err'}">${item.ok ? '✓' : '✗'} ${escapeHtml(item.method)}</div><pre>${escapeHtml(
          item.detail,
        )}</pre>`,
    )
    .join('')
}

async function run(): Promise<void> {
  const info = await host.info()
  results.push({ method: 'host.info', ok: true, detail: JSON.stringify(info) })
  results.push({ method: 'host.isLauncher', ok: true, detail: String(host.isLauncher()) })

  await check('storage.set', () => storage.set('contract', { at: Date.now() }))
  await check('storage.get', () => storage.get('contract'))
  await check('storage.all', () => storage.all())
  await check('storage.remove', () => storage.remove('contract'))

  await check('hostUi.getSearchContent', () => hostUi.getSearchContent())
  await check('hostUi.setSearchContent', () => hostUi.setSearchContent('echo'))
  await check('hostUi.clearSearchContent', () => hostUi.clearSearchContent())
  await check('hostUi.setFooter', () =>
    hostUi.setFooter([{ type: 'button', label: '回填', icon: 'refresh', keys: ['Mod+L'], onClick: () => void hostUi.setSearchContent('footer') }]),
  )

  await check('searchResult.set', () => searchResult.set([{ id: 'echo:1', title: '契约结果', action: { type: 'command', command: 'job' } }]))
  await check('searchResult.append', () => searchResult.append([{ id: 'echo:2', title: '契约结果 2', action: { type: 'command', command: 'job' } }]))
  await check('searchResult.clear', () => searchResult.clear())

  await check('commands.invoke', () => commands.invoke({ command: 'compute', args: { n: 21 } }))
  await check('exec.run', () => exec.run({ command: 'compute', args: { n: 42 }, timeoutMs: 8000 }))

  await check('quicklink.all', () => quicklink.all())
  await check('quicklink.add', () => quicklink.add({ name: '契约链接', url: 'https://example.com' }))

  await check('clipboard.readText', () => clipboard.readText())
  await check('clipboard.writeText', () => clipboard.writeText('contract'))
  await check('shell.openUrl', () => shell.openUrl('https://example.com'))
  await check('notify.show', () => notify.show({ title: '契约', body: '通知测试' }))
  await check('screenshot.start', () => screenshot.start())

  render()
}

void run().catch((err) => {
  root.textContent = `fatal: ${err instanceof Error ? err.message : String(err)}`
})

// 贡献型搜索自检：宿主广播 query 时回一条结果
search.onQuery(() => [{ id: 'echo:query', title: 'echo 贡献结果', action: { type: 'command', command: 'job' } }])
