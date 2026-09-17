/**
 * 插件设置（清单 `settings` 声明）的端到端等价物 —— 设置页「插件设置」调用的同一条 pluginAction：
 * 改值 → 落盘 `plugin-settings.json` → 重载插件 → 逻辑层子进程用新值（`ctx.settings` 的来源）。
 *
 * 逻辑层产物用 SDK 的 echo 示例二进制（`probe` 命令：把宿主注入的 settings 原样写进结果项标题），
 * 这样「注入通道」是被真正走了一遍，而不是断言内核内部状态。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'
import { installEchoBinaries } from '../helpers/fixtures'

interface SettingInfo {
  key: string
  value?: string | boolean
  default?: string | boolean
  customized: boolean
}

interface PluginInfo {
  id: string
  state: string
  settings: SettingInfo[]
}

const h = await createHarness({ label: 'plugin-settings' })

// 现造一个声明了三类设置项的插件
const source = path.join(h.dataRoot, 'sources', 'settings-demo')
await fsp.mkdir(path.join(source, 'dist'), { recursive: true })
await fsp.writeFile(
  path.join(source, 'dist', 'package.json'),
  JSON.stringify(
    {
      name: 'settings-demo',
      title: '设置示例',
      version: '1.0.0',
      type: 'module',
      apiVersion: '2',
      capabilities: [],
      commands: [{ name: 'probe', title: '探测设置', mode: 'script', contributes: true }],
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
        { key: 'note', type: 'text', title: '备注', default: 'hi' },
      ],
    },
    null,
    2,
  ),
)
await installEchoBinaries(source, ['probe'])
const installed = await h.pluginAction('installDir', { path: source, overwrite: true })
assert(installed.ok, `安装应当成功：${JSON.stringify(installed.error ?? {})}`)
assertEqual((await h.plugin('settings-demo'))?.state, 'active', '示例插件应当装配成功')

const action = (payload: Record<string, unknown>) => h.pluginAction(payload.action as string, payload)

const infoOf = async (): Promise<PluginInfo> => {
  const record = (await h.plugin('settings-demo')) as unknown as PluginInfo | undefined
  assert(record, '插件应当在列表里')
  return record
}

const settingOf = (info: PluginInfo, key: string): SettingInfo => {
  const setting = info.settings.find((item) => item.key === key)
  assert(setting, `插件应当声明设置项 ${key}`)
  return setting
}

/** 贡献型来源冷启动可能超一次搜索预算：重试到命中为止（最多约 1.5s） */
async function probeTitle(): Promise<string> {
  for (let i = 0; i < 15; i += 1) {
    const res = await h.api<{ groups: { best: Array<{ item: { title: string } }> } }>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'probe-anything' }),
    })
    const hit = res.groups.best.find((entry) => entry.item.title.startsWith('engine='))
    if (hit) return hit.item.title
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('搜索始终没有命中 settings-demo 的结果项')
}

test('默认值随子进程启动注入（三类设置项都在）', async () => {
  assertEqual(await probeTitle(), 'engine=alpha|flag=false|note=hi')
  const info = await infoOf()
  assertEqual(settingOf(info, 'engine').value, 'alpha')
  assertEqual(settingOf(info, 'engine').customized, false)
  assertEqual(settingOf(info, 'flag').value, false)
  assertEqual(settingOf(info, 'note').value, 'hi')
})

test('改设置：值落盘 + 重载后子进程读到新值', async () => {
  const result = await action({ action: 'setSetting', id: 'settings-demo', key: 'engine', value: 'beta' })
  assert(result.ok, '写入应当成功')
  const updated = (result.plugins as PluginInfo[] | undefined)?.find((plugin) => plugin.id === 'settings-demo')
  assertEqual(settingOf(updated as PluginInfo, 'engine').value, 'beta')
  assertEqual(settingOf(updated as PluginInfo, 'engine').customized, true)

  assertEqual(await probeTitle(), 'engine=beta|flag=false|note=hi', '重载后的插件应当拿到新值')
  const file = await h.readData<Record<string, Record<string, unknown>>>('plugin-settings.json')
  assertEqual(file['settings-demo']?.engine, 'beta', '用户值应当落盘到 plugin-settings.json')
})

test('switch / text 同一条路径（值类型按声明校验）', async () => {
  await action({ action: 'setSetting', id: 'settings-demo', key: 'flag', value: true })
  await action({ action: 'setSetting', id: 'settings-demo', key: 'note', value: 'hello' })
  assertEqual(await probeTitle(), 'engine=beta|flag=true|note=hello')

  const bad = await action({ action: 'setSetting', id: 'settings-demo', key: 'flag', value: 'yes' })
  assertEqual(bad.ok, false, '布尔项收到字符串应当被拒')
  assertEqual(bad.error?.code, 'BAD_ARGS')
})

test('非法值 / 未声明的键都被拒绝，且不写脏数据', async () => {
  const notInOptions = await action({ action: 'setSetting', id: 'settings-demo', key: 'engine', value: 'nope' })
  assertEqual(notInOptions.ok, false, '不在 options 里的值应当被拒')
  assertEqual(notInOptions.error?.code, 'BAD_ARGS')

  const ghost = await action({ action: 'setSetting', id: 'settings-demo', key: 'ghost', value: 'x' })
  assertEqual(ghost.ok, false, '未声明的键应当被拒')
  assertEqual(ghost.error?.code, 'NOT_FOUND')

  assertEqual(settingOf(await infoOf(), 'engine').value, 'beta', '被拒的写入不应改动生效值')
})

test('恢复默认：删掉用户值，回落清单 default', async () => {
  const result = await action({ action: 'resetSetting', id: 'settings-demo', key: 'engine' })
  assert(result.ok)
  const info = await infoOf()
  assertEqual(settingOf(info, 'engine').value, 'alpha')
  assertEqual(settingOf(info, 'engine').customized, false)
  assertEqual(await probeTitle(), 'engine=alpha|flag=true|note=hello', '其余设置不受影响')
})

test('卸载插件时清掉它的设置（重装不背旧值）', async () => {
  await action({ action: 'setSetting', id: 'settings-demo', key: 'engine', value: 'beta' })
  const removed = await h.pluginAction('uninstall', { id: 'settings-demo' })
  assertEqual(removed.ok, true, `卸载应当成功：${JSON.stringify(removed.error ?? {})}`)
  const file = await h.readData<Record<string, unknown>>('plugin-settings.json')
  assertEqual(file['settings-demo'], undefined, '卸载后不应还留着设置项')
})

const failed = await run('插件设置（端到端）')
await h.stop()
if (failed > 0) process.exit(1)
