/** 插件设置的纯函数层：值校验 / 按声明过滤 / 生效值合并 */
import type { SettingDecl } from '../../packages/plugin-manifest/src/index'
import {
  effectiveSettings,
  isValidSettingValue,
  sanitizeSettingValues,
  sanitizeSettingsFile,
} from '../../apps/kernel/src/pluginSettings'
import { assert, assertDeepEqual, assertEqual, run, test } from '../helpers/assert'

const DECLS: SettingDecl[] = [
  {
    key: 'engine',
    type: 'select',
    title: '引擎',
    default: 'alpha',
    options: [
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta', label: 'Beta' },
    ],
  },
  { key: 'flag', type: 'switch', title: '开关', default: false },
  { key: 'note', type: 'text', title: '备注' },
]

test('值校验：按类型与 options 判，文本限长', () => {
  assert(isValidSettingValue(DECLS[0]!, 'beta'))
  assert(!isValidSettingValue(DECLS[0]!, 'beta2'), '不在 options 里应当被拒')
  assert(!isValidSettingValue(DECLS[0]!, true), '类型不符应当被拒')

  assert(isValidSettingValue(DECLS[1]!, true))
  assert(!isValidSettingValue(DECLS[1]!, 'true'))

  assert(isValidSettingValue(DECLS[2]!, '任意文本'))
  assert(!isValidSettingValue(DECLS[2]!, 'x'.repeat(201)), '文本限长 200')
})

test('按声明过滤：清单里删掉的键、类型对不上的残留值一律丢弃', () => {
  assertDeepEqual(
    sanitizeSettingValues({ engine: 'beta', ghost: 'x', flag: 'oops', note: 'hi' }, DECLS),
    { engine: 'beta', note: 'hi' },
  )
  assertDeepEqual(sanitizeSettingValues(null, DECLS), {})
})

test('生效值：用户值优先，缺省回落 default（两者都没有则缺席）', () => {
  assertDeepEqual(effectiveSettings(DECLS, { engine: 'beta' }), { engine: 'beta', flag: false })
  assertDeepEqual(effectiveSettings(DECLS, undefined), { engine: 'alpha', flag: false })
  assertDeepEqual(effectiveSettings(DECLS, { note: 'hi' }), { engine: 'alpha', flag: false, note: 'hi' })
})

test('文件级粗过滤：只留 string | boolean，空条目不留痕', () => {
  assertDeepEqual(sanitizeSettingsFile({ a: { engine: 'beta', n: 1, b: true }, b: 'oops', c: {} }), {
    a: { engine: 'beta', b: true },
  })
  assertDeepEqual(sanitizeSettingsFile([]), {})
})

const failed = await run('插件设置（纯函数）')
if (failed > 0) process.exit(1)
