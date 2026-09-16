/**
 * 插件别名覆盖层（`plugin-overrides.json`）：
 * 两层语义（插件级兜底 + 命令级）、`undefined`（未覆盖）与 `[]`（显式清空）的区别、落盘与恢复默认。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertDeepEqual, assertEqual, run, test } from '../helpers/assert'
import type { PluginManifest } from '../../packages/plugin-manifest/src/types'
import {
  MAX_KEYWORDS,
  OverrideStore,
  commandKeywordsOf,
  mergeCommandDecls,
  mergeKeywords,
  pluginKeywordsOf,
  sanitizeKeywords,
  sanitizeOverrides,
} from '../../apps/kernel/src/overrides'

function demoManifest(extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'demo',
    title: '示例',
    version: '1.0.0',
    apiVersion: '1',
    type: 'module',
    capabilities: [],
    keywords: ['demo'],
    commands: [
      { name: 'open', title: '打开', mode: 'view', searchable: true, keywords: ['open'] },
      { name: 'list', title: '列表', mode: 'script' },
    ],
    ...extra,
  }
}

test('sanitizeKeywords：去空白、忽略大小写去重、截断到 10 个，非数组 → undefined', () => {
  assertDeepEqual(sanitizeKeywords([' totp ', 'TOTP', '', '   ', 'otp']), ['totp', 'otp'])
  assertDeepEqual(sanitizeKeywords([]), [], '空数组是合法输入（显式清空）')
  assertEqual(sanitizeKeywords('not-array'), undefined)
  assertEqual(sanitizeKeywords(undefined), undefined)
  const many = Array.from({ length: 30 }, (_, index) => `k${index}`)
  assertEqual(sanitizeKeywords(many)?.length, MAX_KEYWORDS)
})

test('mergeKeywords：插件级在前，忽略大小写去重、保序', () => {
  assertDeepEqual(mergeKeywords(['totp', '验证码'], ['OTP', '验证码']), ['totp', '验证码', 'OTP'])
  assertDeepEqual(mergeKeywords([], []), [])
})

test('覆盖语义：undefined 用清单值，[] 是用户显式清空', () => {
  assertDeepEqual(pluginKeywordsOf(['demo'], undefined), ['demo'])
  assertDeepEqual(pluginKeywordsOf(['demo'], { keywords: [] }), [], '清空后不再回落到清单值')
  assertDeepEqual(pluginKeywordsOf(undefined, { keywords: ['x'] }), ['x'])
  assertDeepEqual(commandKeywordsOf(['open'], { commands: { open: { keywords: ['k'] } } }, 'open'), ['k'])
  assertDeepEqual(commandKeywordsOf(['open'], undefined, 'open'), ['open'])
  assertDeepEqual(commandKeywordsOf(undefined, { commands: { list: { keywords: ['l'] } } }, 'open'), [])
})

test('装配合并：命令最终别名 = 插件级 ∪ 命令级，其它字段原样保留', () => {
  const decls = mergeCommandDecls(demoManifest(), {
    keywords: ['verifier'],
    commands: { open: { keywords: ['open', 'verifier'] } },
  })
  assertDeepEqual(decls[0]?.keywords, ['verifier', 'open'])
  assertDeepEqual(decls[1]?.keywords, ['verifier'], '没有命令级别名时只带插件级')
  assertEqual(decls[0]?.title, '打开')
  assertEqual(decls[0]?.searchable, true)

  const untouched = mergeCommandDecls(demoManifest(), undefined)
  assertDeepEqual(untouched[0]?.keywords, ['demo', 'open'], '没有覆盖时就是清单原值')
})

test('sanitizeOverrides：坏数据不炸，空壳项被丢弃', () => {
  const parsed = sanitizeOverrides({
    good: { keywords: ['a'], commands: { cmd: { keywords: ['b'] } } },
    bad: 'nope',
    empty: {},
    junk: { keywords: 'not-array', commands: { x: { keywords: 1 } } },
  })
  assertDeepEqual(Object.keys(parsed), ['good'])
  assertDeepEqual(parsed.good?.commands?.cmd?.keywords, ['b'])
})

test('OverrideStore：落盘后可重载；恢复默认删键；clear 后文件里不留空壳', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-overrides-'))
  const store = new OverrideStore(dir)
  await store.load()
  await store.setPluginKeywords('totp', ['totp', '验证码'])
  await store.setCommandKeywords('totp', 'totp', ['otp'])

  const reloaded = new OverrideStore(dir)
  await reloaded.load()
  assertDeepEqual(reloaded.getFor('totp')?.keywords, ['totp', '验证码'])
  assertDeepEqual(reloaded.getFor('totp')?.commands?.totp?.keywords, ['otp'])

  await reloaded.setPluginKeywords('totp', null)
  assertEqual(reloaded.getFor('totp')?.keywords, undefined, '恢复默认 = 删掉覆盖项')
  assertDeepEqual(reloaded.getFor('totp')?.commands?.totp?.keywords, ['otp'], '只动被指定的那一项')

  await reloaded.clear('totp')
  assertEqual(reloaded.getFor('totp'), undefined)
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'plugin-overrides.json'), 'utf8')) as Record<string, unknown>
  assertEqual(raw.totp, undefined, '清空后文件里不留空壳')

  await fsp.rm(dir, { recursive: true, force: true })
})

const failed = await run('插件别名覆盖层')
if (failed > 0) process.exit(1)
