/**
 * 验收口径（requirements §1.3）：
 * 「清空所有插件目录后，应用仍能启动、能唤出、能搜索（结果为空）、能显示空的「最近使用／已固定」、能安装插件。」
 * 这里用真内核 + 真 HTTP 驱动，不起壳。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const h = await createHarness({ label: 'smoke' })

interface SearchResponse {
  groups: {
    pinned: unknown[]
    best: Array<{ itemKey: string; item: { title: string }; stale?: boolean }>
    recent: Array<{ itemKey: string; item: { title: string }; stale?: boolean }>
  }
}

const search = async (query: string): Promise<SearchResponse> =>
  h.api<SearchResponse>('/api/search', { method: 'POST', body: JSON.stringify({ query }) })

test('零插件：能启动、能搜索、结果为空、最近/固定为空', async () => {
  const bootstrap = await h.api<{ ok: boolean; snapshot: { commands: unknown[]; pinned: unknown[]; recent: unknown[] } }>(
    '/api/bootstrap',
  )
  assert(bootstrap.ok, 'bootstrap 应当成功')
  assertEqual(bootstrap.snapshot.commands.length, 0, '没有插件时不应有任何命令')
  assertEqual(bootstrap.snapshot.pinned.length, 0)
  assertEqual(bootstrap.snapshot.recent.length, 0)

  const empty = await search('')
  assertEqual(empty.groups.best.length, 0)
  assertEqual(empty.groups.pinned.length, 0)
  assertEqual(empty.groups.recent.length, 0)

  const miss = await search('随便输点什么')
  assertEqual(miss.groups.best.length, 0, '无插件时搜索应当返回空而不是报错')
})

test('零插件时 UI 服务仍可用（能唤出 = 有页面可加载）', async () => {
  const health = await h.api<{ ok: boolean }>('/api/health')
  assert(health.ok, '健康检查应当通过')
  assert(h.uiPort > 0, 'UI 端口应当已分配')
})

test('能安装插件（从目录），安装后命令立刻参与搜索', async () => {
  const source = path.join(h.dataRoot, 'sources', 'third-party-demo')
  await fsp.mkdir(path.join(source, 'dist', 'assets'), { recursive: true })
  await fsp.writeFile(
    path.join(source, 'dist', 'package.json'),
    JSON.stringify(
      {
        name: 'third-party-demo',
        title: '第三方示例',
        version: '1.0.0',
        type: 'module',
        apiVersion: '1',
        capabilities: [],
        commands: [
          { name: 'hello', title: '问候', mode: 'view', searchable: true, keywords: ['hello'] },
          { name: 'ping', title: 'Ping 一下', mode: 'script', hidden: true },
        ],
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(source, 'dist', 'index.html'), '<!doctype html><title>hello</title>')
  await fsp.writeFile(path.join(source, 'dist', 'ping.mjs'), 'export const pong = true\n')

  await h.kernel.plugins.installFromDirectory(source, { overwrite: true })
  assertEqual(h.kernel.plugins.get('third-party-demo')?.state, 'active')

  const response = await search('问候')
  const titles = response.groups.best.map((item) => item.item.title)
  assert(titles.includes('问候'), `安装后应能搜到：${titles.join(' | ')}`)

  // 拼音：wenhou 也应命中（M3 目标）
  const pinyin = await search('wenhou')
  assert(
    pinyin.groups.best.some((item) => item.item.title === '问候'),
    '拼音全拼应当命中中文命令',
  )
})

test('执行 view 命令会产生会话，执行脚本命令会写历史', async () => {
  const view = await h.api<{ result: { ok: boolean; data?: { sid: string; url: string } } }>('/api/invoke', {
    method: 'POST',
    body: JSON.stringify({ id: 'third-party-demo:hello' }),
  })
  assert(view.result.ok, `view 命令应当可执行：${JSON.stringify(view.result)}`)
  assert(view.result.data?.url.includes('/index.html?sid='), '会话 URL 应符合契约')

  const script = await h.api<{ result: { ok: boolean; data?: unknown } }>('/api/invoke', {
    method: 'POST',
    body: JSON.stringify({ id: 'third-party-demo:ping' }),
  })
  assert(script.result.ok, `脚本命令应当可执行：${JSON.stringify(script.result)}`)

  const history = await h.api<{ items: Array<{ key: string; title: string }> }>('/api/history')
  assert(
    history.items.some((item) => item.title === 'Ping 一下'),
    `脚本执行后应当写历史：${JSON.stringify(history.items)}`,
  )
})

test('固定项可持久化，且搜索时置顶', async () => {
  const history = await h.api<{ items: Array<{ key: string }> }>('/api/history')
  const key = history.items[0]?.key
  assert(key, '需要先有历史项')

  const pinned = await h.api<{ ok: boolean; pinned: boolean }>('/api/pinned/toggle', {
    method: 'POST',
    body: JSON.stringify({
      key,
      pluginId: 'third-party-demo',
      command: 'ping',
      title: 'Ping 一下',
    }),
  })
  assertEqual(pinned.pinned, true)

  const empty = await search('')
  assert(empty.groups.pinned.length >= 1, '空输入应当显示已固定')

  const hit = await search('Ping')
  assert(hit.groups.pinned.length >= 1, '命中时固定项应当置顶')
})

test('禁用插件：命令消失、历史项置灰（不是被删）', async () => {
  await h.kernel.plugins.setDisabled('third-party-demo', true)
  assertEqual(h.kernel.registry.byPlugin('third-party-demo').length, 0, '禁用后命令应当消失')

  const response = await search('Ping')
  const recent = response.groups.recent
  assert(recent.length >= 1, '历史项应当保留')
  assert(recent.every((item) => item.stale === true), '插件不可用时历史项应当置灰')

  const empty = await search('')
  assert(empty.groups.pinned.length >= 1, '固定项应保留')
})

test('重新启用后命令恢复；卸载后目录与命令都消失', async () => {
  await h.kernel.plugins.setDisabled('third-party-demo', false)
  assertEqual(h.kernel.registry.byPlugin('third-party-demo').length, 2)

  await h.kernel.plugins.uninstall('third-party-demo')
  assertEqual(h.kernel.plugins.get('third-party-demo'), undefined)
  assertEqual(h.kernel.registry.byPlugin('third-party-demo').length, 0)
  const extensions = await fsp.readdir(path.join(h.dataRoot, 'extensions'))
  assert(!extensions.includes('third-party-demo'), '卸载后目录应当被删除')
})

const failed = await run('验收口径（零插件可用）')
await h.stop()
if (failed > 0) process.exit(1)
