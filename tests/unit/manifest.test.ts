import { assert, assertEqual, run, test } from '../helpers/assert'
import { checkEntries, supportsRuntime, validateManifest } from '../../packages/plugin-manifest/src/index'

const VALID = {
  name: 'my-plugin',
  title: '我的插件',
  version: '0.1.0',
  type: 'module',
  apiVersion: '2',
  capabilities: ['storage'],
  commands: [
    { name: 'hello', title: '打个招呼', mode: 'view', searchable: true, placeholder: '输入名字' },
    { name: 'job', title: '后台任务', mode: 'no-view' },
    { name: 'compute', title: '脚本', mode: 'script' },
  ],
}

test('合法清单通过校验并保留可选字段', () => {
  const result = validateManifest(VALID)
  assert(result.ok, '应当通过')
  assertEqual(result.manifest.name, 'my-plugin')
  assertEqual(result.manifest.commands.length, 3)
  assertEqual(result.manifest.commands[0]?.searchable, true)
})

test('缺 name / title / version / commands 均报 MANIFEST_INVALID', () => {
  for (const patch of [
    { name: undefined },
    { title: undefined },
    { version: undefined },
    { commands: undefined },
    { commands: [] },
  ]) {
    const result = validateManifest({ ...VALID, ...patch })
    assert(!result.ok, `${JSON.stringify(patch)} 应当失败`)
    assertEqual(result.code, 'MANIFEST_INVALID', JSON.stringify(patch))
  }
})

test('name 必须符合 [a-z0-9-] 且首尾为小写字母数字', () => {
  for (const name of ['My-Plugin', '-abc', 'ab', 'a', 'x_1', 'ok-name-2']) {
    const result = validateManifest({ ...VALID, name })
    if (name === 'ok-name-2') assert(result.ok, `${name} 应当通过`)
    else assert(!result.ok, `${name} 应当失败`)
  }
})

test('essential 只接受布尔值；不写 = 未声明（不是 false）', () => {
  const absent = validateManifest(VALID)
  assert(absent.ok && absent.manifest.essential === undefined, '不写就是未声明')

  const declared = validateManifest({ ...VALID, essential: true })
  assert(declared.ok && declared.manifest.essential === true)

  const wrong = validateManifest({ ...VALID, essential: 'yes' })
  assert(!wrong.ok)
  assertEqual(wrong.code, 'MANIFEST_INVALID')
})

test('history 只接受布尔值；不写 = 未声明（默认计入最近使用）', () => {
  const absent = validateManifest(VALID)
  assert(absent.ok && absent.manifest.history === undefined, '不写就是未声明')

  const declared = validateManifest({ ...VALID, history: false })
  assert(declared.ok && declared.manifest.history === false)

  const wrong = validateManifest({ ...VALID, history: 'no' })
  assert(!wrong.ok)
  assertEqual(wrong.code, 'MANIFEST_INVALID')
})

test('settings：三类设置项都能声明，select 必须带 options 且 default 在选项内', () => {
  const result = validateManifest({
    ...VALID,
    settings: [
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
    ],
  })
  assert(result.ok, '应当通过')
  assertEqual(result.manifest.settings?.length, 3)
  assertEqual(result.manifest.settings?.[0]?.options?.length, 2)
})

test('settings：非法声明一律拒绝（key / type / options / default / 重复）', () => {
  const bad = [
    { settings: [{ key: 'Engine', type: 'text', title: 'x' }] },
    { settings: [{ key: 'ok', type: 'radio', title: 'x' }] },
    { settings: [{ key: 'ok', type: 'select', title: 'x' }] },
    { settings: [{ key: 'ok', type: 'select', title: 'x', options: [{ value: 'a', label: 'A' }] }] },
    { settings: [{ key: 'ok', type: 'select', title: 'x', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }] },
    {
      settings: [
        { key: 'ok', type: 'select', title: 'x', default: 'z', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      ],
    },
    { settings: [{ key: 'ok', type: 'switch', title: 'x', default: 'true' }] },
    { settings: [{ key: 'ok', type: 'text', title: 'x' }, { key: 'ok', type: 'text', title: 'y' }] },
    { settings: 'engine' },
  ]
  for (const patch of bad) {
    const result = validateManifest({ ...VALID, ...patch })
    assert(!result.ok, `${JSON.stringify(patch)} 应当失败`)
    assertEqual(result.code, 'MANIFEST_INVALID', JSON.stringify(patch))
  }
})

test('platforms / arch：省略 = 不限制；给了就必须是已知值的非空数组', () => {
  const absent = validateManifest(VALID)
  assert(absent.ok, '未声明应当通过')
  assertEqual(absent.manifest.platforms, undefined)
  assertEqual(absent.manifest.arch, undefined)

  const declared = validateManifest({ ...VALID, platforms: ['windows'], arch: ['x64'] })
  assert(declared.ok, '合法声明应当通过')
  assertEqual(declared.manifest.platforms?.join(','), 'windows')
  assertEqual(declared.manifest.arch?.join(','), 'x64')

  for (const patch of [
    { platforms: [] },
    { platforms: 'windows' },
    { platforms: ['win'] },
    { platforms: [1] },
    { arch: [] },
    { arch: ['arm'] },
  ]) {
    const result = validateManifest({ ...VALID, ...patch })
    assert(!result.ok, `${JSON.stringify(patch)} 应当失败`)
    assertEqual(result.code, 'MANIFEST_INVALID', JSON.stringify(patch))
  }
})

test('supportsRuntime：声明命中运行环境才通过（未声明的维度不限制）', () => {
  // 模拟一个 Windows x64 环境
  const win: { platform: 'windows'; arch: 'x64' } = { platform: 'windows', arch: 'x64' }

  const absent = validateManifest(VALID)
  assert(absent.ok && supportsRuntime(absent.manifest, win), '未声明 ⇒ 任何环境都通过')

  const windowsOnly = validateManifest({ ...VALID, platforms: ['windows'] })
  assert(windowsOnly.ok && supportsRuntime(windowsOnly.manifest, win), 'windows 插件在 win 上通过')
  assert(!supportsRuntime(windowsOnly.manifest, { platform: 'macos', arch: 'arm64' }), '在 mac 上不通过')

  const macArm = validateManifest({ ...VALID, platforms: ['macos'], arch: ['arm64'] })
  assert(macArm.ok && supportsRuntime(macArm.manifest, { platform: 'macos', arch: 'arm64' }))
  assert(!supportsRuntime(macArm.manifest, { platform: 'macos', arch: 'x64' }), '架构不匹配也不通过')

  const all = validateManifest({ ...VALID, platforms: ['macos', 'windows', 'linux'], arch: ['x64', 'arm64'] })
  assert(all.ok && supportsRuntime(all.manifest, win) && supportsRuntime(all.manifest, { platform: 'linux', arch: 'arm64' }))
})

test('apiVersion "1" 与 "2" 都接受；未知版本报 API_VERSION_UNSUPPORTED', () => {
  const v1 = validateManifest({ ...VALID, apiVersion: '1' })
  assert(v1.ok, 'apiVersion 1 仍可加载（视图层不受版本影响）')

  const v2 = validateManifest({ ...VALID, apiVersion: '2' })
  assert(v2.ok, 'apiVersion 2 应当通过')

  const unknown = validateManifest({ ...VALID, apiVersion: '3' })
  assert(!unknown.ok)
  assertEqual(unknown.code, 'API_VERSION_UNSUPPORTED')
})

test('未知 capability 报 CAPABILITY_UNKNOWN（插件级与命令级都查）', () => {
  const a = validateManifest({ ...VALID, capabilities: ['storage', 'teleport'] })
  assert(!a.ok)
  assertEqual(a.code, 'CAPABILITY_UNKNOWN')

  const b = validateManifest({
    ...VALID,
    commands: [{ name: 'hello', title: '标题', mode: 'script', capabilities: ['time-travel'] }],
  })
  assert(!b.ok)
  assertEqual(b.code, 'CAPABILITY_UNKNOWN')
})

test('命令 mode / name 非法或重名报 MANIFEST_INVALID', () => {
  const badMode = validateManifest({ ...VALID, commands: [{ name: 'a', title: 'x', mode: 'popup' }] })
  assert(!badMode.ok)

  const badName = validateManifest({ ...VALID, commands: [{ name: 'Bad_Name', title: 'x', mode: 'view' }] })
  assert(!badName.ok)

  const dup = validateManifest({
    ...VALID,
    commands: [
      { name: 'same', title: 'a', mode: 'view' },
      { name: 'same', title: 'b', mode: 'view' },
    ],
  })
  assert(!dup.ok)
  assert(String(dup.message).includes('重复'), '错误信息应说明重名')
})

test('缺 apiVersion / capabilities 一律拒绝（无兼容放行）', () => {
  const legacy = { ...VALID } as Record<string, unknown>
  delete legacy.apiVersion
  delete legacy.capabilities
  const result = validateManifest(legacy)
  assert(!result.ok, '缺 apiVersion 应当失败')
  assertEqual(result.code, 'MANIFEST_INVALID')

  const partial = { ...VALID, capabilities: undefined } as Record<string, unknown>
  delete partial.capabilities
  const noCaps = validateManifest(partial)
  assert(!noCaps.ok, '缺 capabilities 应当失败')
})

test('产物校验：view 缺 index.html、逻辑层缺同名可执行产物都报 ENTRY_MISSING', () => {
  const result = validateManifest(VALID)
  assert(result.ok)
  const { missing } = checkEntries(result.manifest, ['hello.mjs'])
  assertEqual(missing.hello, '缺少 index.html')
  assertEqual(missing.job, '缺少 job（可执行产物）')
  assertEqual(missing.compute, '缺少 compute（可执行产物）')

  const { missing: ok } = checkEntries(result.manifest, [
    'index.html',
    'assets/app.js',
    'job',
    'workers/compute.exe',
  ])
  assertEqual(Object.keys(ok).length, 0, `不应有缺失：${JSON.stringify(ok)}`)
})

const failed = await run('插件清单校验')
if (failed > 0) process.exit(1)
