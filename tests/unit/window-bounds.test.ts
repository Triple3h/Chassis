/**
 * 窗口几何记忆（requirements §3.1「窗口几何记忆」/ architecture D20）。
 *
 * 守五件事：
 *  - **清洗**：记忆值要落盘、下次唤出直接拿来设窗口 —— 半个坐标 / 迷你尺寸 / 非法键
 *    必须在入口被丢掉（留一个脏数字 ⇒ 下次唤出窗口跑到屏幕外，而用户不知道为什么）；
 *    （纯函数侧由 `apps/kernel/src/config.rs` 的单测覆盖；这里守它经 HTTP 的落盘行为）
 *  - **按窗口态分开记**：`host` / `plugin:<id>` 互不干扰（patchConfig 是浅合并，
 *    UI 每次写回都得把整个对象给全；少给一个键 = 把别的窗口态的记忆悄悄抹掉）；
 *  - **只记合法的一半**：只拖过窗口 ⇒ 「只有位置」也是合法记忆（不能因为没尺寸就整项丢）；
 *  - **先钳制再转发**：UI 算错时不能把窗口拉成 5 像素高 —— 发给壳的必须是钳制后的值；
 *  - **启动恢复**：config 里的宿主几何要真的推给壳（跨重启恢复的入口）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

/** 与 `apps/kernel/src/config.rs` 的窗口常量对齐（合同值，改动会被本用例拦下） */
const MIN_WINDOW_HEIGHT = 240
const MAX_WINDOW_WIDTH = 2000

const h = await createHarness({ label: 'window-bounds', fakeShell: true })
const shell = h.shell
if (!shell) throw new Error('fakeShell 未启用')

test('落盘：每个窗口态各记一份（host 与 plugin:<id> 互不干扰）', async () => {
  await h.patchConfig({
    windowBounds: {
      host: { x: 120, y: 80, width: 900, height: 700 },
      'plugin:demo': { x: 40, y: -20, width: 1000, height: 800 },
    },
  })
  const bounds = (await h.config()).windowBounds
  assertEqual(bounds.host?.x, 120, '宿主的位置应当落盘')
  assertEqual(bounds['plugin:demo']?.y, -20, '插件页的位置可以是负数（副屏在主屏左侧）')

  // 「只拖过窗口」的写回：整项只剩位置，尺寸那一半不再有
  await h.patchConfig({ windowBounds: { ...bounds, 'plugin:demo': { x: 40, y: -20 } } })
  const next = (await h.config()).windowBounds
  assertEqual(next.host?.height, 700, '写插件那份不该把宿主那份弄丢')
  assertEqual(next['plugin:demo']?.width, undefined, '只记位置也合法（用户只拖过窗口）')
})

test('清洗：半个坐标 / 迷你尺寸 / 非法键都不落盘', async () => {
  await h.patchConfig({
    windowBounds: {
      host: { x: 10, width: 800, height: 600 },
      'plugin:tiny': { width: 100, height: 600 },
      ghost: { width: 800, height: 600 },
    },
  })
  const bounds = (await h.config()).windowBounds
  assertEqual(bounds.host?.x, undefined, '半个位置（只有 x）必须整半丢掉')
  assertEqual(bounds.host?.width, 800, '尺寸那一半要留下')
  assertEqual(bounds['plugin:tiny'], undefined, '比最小尺寸还小 ⇒ 整项丢')
  assertEqual(bounds.ghost, undefined, '只认 host / plugin / plugin:<id>')
})

test('恢复默认：只清尺寸、位置保留，别的窗口态不受影响', async () => {
  await h.patchConfig({
    windowBounds: {
      host: { x: 120, y: 80, width: 900, height: 700 },
      'plugin:demo': { x: 40, y: 60, width: 1000, height: 800 },
    },
  })
  // UI 的「恢复默认大小」：删掉当前窗口态的 width / height，位置原样留下
  const before = (await h.config()).windowBounds
  await h.patchConfig({ windowBounds: { ...before, host: { x: 120, y: 80 } } })
  const bounds = (await h.config()).windowBounds
  assertEqual(bounds.host?.width, undefined, '尺寸记忆被清掉')
  assertEqual(bounds.host?.x, 120, '位置记忆保留（用户没说要忘掉"放在哪儿"）')
  assertEqual(bounds['plugin:demo']?.width, 1000, '别的窗口态不受影响')
})

test('/api/window/bounds：把壳报的当前几何原样交给 UI', async () => {
  shell.bounds = { x: -300, y: 90, width: 900, height: 640 }
  const res = await h.api<{ ok: boolean; bounds: { x: number; y: number; width: number; height: number } | null }>(
    '/api/window/bounds',
  )
  assertEqual(res.ok, true)
  assertEqual(res.bounds?.x, -300, '位置要原样转发（多屏可为负）')
  assertEqual(res.bounds?.width, 900)
})

test('/api/window/setBounds：先钳制、再转发壳，返回壳应用后的几何', async () => {
  shell.bounds = { x: 0, y: 0, width: 720, height: 480 }
  shell.calls.length = 0
  const res = await h.api<{ ok: boolean; bounds?: { x: number; y: number; width: number; height: number } }>(
    '/api/window/setBounds',
    { method: 'POST', body: JSON.stringify({ x: -50, y: 30, width: 99999, height: 10 }) },
  )
  const call = shell.calls.find((item) => item.method === 'window.setBounds')
  assert(call !== undefined, '内核必须把几何转发给壳')
  assertEqual(call?.params.x, -50, '位置原样转发')
  assertEqual(call?.params.width, MAX_WINDOW_WIDTH, '发给壳的必须是钳制后的宽')
  assertEqual(call?.params.height, MIN_WINDOW_HEIGHT, '高度不能小于最小值')
  assertEqual(res.bounds?.width, MAX_WINDOW_WIDTH, '返回壳应用后的几何')
})

test('/api/window/setBounds：半个坐标 / 空请求直接拒绝，绝不转发脏值', async () => {
  shell.calls.length = 0
  const half = await h.api<{ ok: boolean; error?: { code: string } }>('/api/window/setBounds', {
    method: 'POST',
    body: JSON.stringify({ x: 10, width: 800, height: 600 }),
  })
  assertEqual(half.ok, false, '半个位置必须拒绝')
  assertEqual(half.error?.code, 'BAD_ARGS', '按参数错误返回（400），不是内部错误')
  const empty = await h.api<{ ok: boolean; error?: { code: string } }>('/api/window/setBounds', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  assertEqual(empty.ok, false, '什么都没给也要拒绝')
  assertEqual(
    shell.calls.filter((item) => item.method === 'window.setBounds').length,
    0,
    '不该把脏值发给壳',
  )
})

/**
 * 跨重启恢复：内核启动时把**宿主态**（启动后 UI 的第一步就是它）的记忆推给壳
 * （`window.restoreBounds`，通知）。壳只在窗口隐藏时应用 —— 这条用例守的是
 * 「推了、推的值对」，应用与否归壳（真窗口才有意义）。
 */
test('启动恢复：config 里的宿主几何要推给壳（window.restoreBounds）', async () => {
  const seeded = await createHarness({
    label: 'window-bounds-restore',
    fakeShell: true,
    recordFromBoot: true,
    seed: async (dataRoot) => {
      await fsp.writeFile(
        path.join(dataRoot, 'config.json'),
        JSON.stringify({ version: 1, windowBounds: { host: { x: 150, y: 90, width: 900, height: 700 } } }),
      )
    },
  })
  try {
    const seededShell = seeded.shell
    if (!seededShell) throw new Error('fakeShell 未启用')
    const call = seededShell.calls.find((item) => item.method === 'window.restoreBounds')
    assert(
      call !== undefined,
      `内核必须把宿主几何推给壳：${seededShell.calls.map((item) => item.method).join(', ')}`,
    )
    assertEqual(call?.params.x, 150, '推的是宿主态记下的位置')
    assertEqual(call?.params.height, 700, '尺寸一起恢复（跨重启后不用等 UI 再设一遍）')
    assertEqual(seededShell.bounds.x, 150, '假壳应当把它当成当前窗口几何')
  } finally {
    await seeded.stop()
  }
})

const failed = await run('窗口几何记忆')
await h.stop()
if (failed > 0) process.exit(1)
