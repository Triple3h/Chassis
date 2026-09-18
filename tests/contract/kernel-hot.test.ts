/**
 * 内核热更新（v0.1.0，`/api/hot/*`）：真内核 + 真 HTTP 的端到端契约。
 *
 * 覆盖：状态 / 两阶段（stage→apply）/ 扩展路由 / 停用内置路由 / 热中间件（维护模式）/
 * 事件订阅热替换 / 回滚 / 日志（时间+版本+模块+结果）/ 二进制热替换（staging→apply→rollback）/
 * 优雅重启（壳收到 `kernel/restarting`）。
 *
 * 断言全部走对外路径（HTTP + SSE + 落盘文件）—— 装置里没有内核内部对象可用。
 */
import fsp from 'node:fs/promises'
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface HotStatus {
  hotVersion: string
  generation: number
  revision: string
  inflight: number
  spec: { middleware: { maintenance: boolean; requestLog: boolean }; routes: { disabled: string[] } }
  previous: { revision: string } | null
  paths: { current: string; previous: string; candidate: string; log: string; dir: string }
  binary: { supported: boolean; currentExe: string; pending: { toVersion: string } | null }
}

interface ApplyResponse {
  ok: boolean
  result?: { generation: number; revision: string; previousRevision: string; modules: string[]; probed: number }
  hot?: HotStatus
  error?: { code: string; message: string }
}

const HOT_VERSION = '0.1.0'
const baseSpec = {
  schema: 1,
  hotVersion: HOT_VERSION,
  kernelVersion: '0.1.0',
  revision: 'test-base',
  note: '契约测试基线',
  modules: [] as string[],
  routes: { extensions: [] as unknown[], disabled: [] as string[] },
  middleware: { requestLog: false, timeoutMs: 0, maintenance: false },
  bus: { log: [] as string[] },
}

const h = await createHarness({ label: 'kernel-hot' })

const raw = (pathname: string, init?: RequestInit): Promise<Response> => fetch(`${h.base}${pathname}`, init)
const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
const apply = (spec: Record<string, unknown>): Promise<ApplyResponse> =>
  h.api<ApplyResponse>('/api/hot/apply', json({ spec }))
const status = async (): Promise<HotStatus> => (await h.api<{ hot: HotStatus }>('/api/hot/status')).hot

test('hot/status：初始代 = 内置默认，机制版本 0.1.0', async () => {
  const hot = await status()
  assertEqual(hot.hotVersion, HOT_VERSION, '热更新机制版本')
  assert(hot.generation >= 1, `代数从 1 起：${hot.generation}`)
  assertEqual(hot.revision, 'builtin', '首次启动是内置默认代')
  assertEqual(hot.inflight, 0, '没有在途请求')
  assertEqual(hot.binary.supported, true, '当前平台支持二进制热替换')
  assert(hot.binary.currentExe.length > 0, '报告当前二进制路径')
})

test('stage 两阶段：只落候选文件，不生效', async () => {
  const staged = await h.api<{ ok: boolean; staged: string }>('/api/hot/stage', json({ spec: { ...baseSpec, revision: 'test-staged' } }))
  assertEqual(staged.ok, true, 'stage 成功')
  const content = JSON.parse(await fsp.readFile(staged.staged, 'utf-8')) as { revision: string }
  assertEqual(content.revision, 'test-staged', '候选 spec 已落盘')
  assertEqual((await status()).revision, 'builtin', 'stage 不改变当前代')
})

test('apply：扩展路由生效、内置路由不受影响、广播 hot/updated', async () => {
  const events: string[] = []
  const sub = h.subscribe((event) => events.push(event.event))
  await sub.ready

  const spec = {
    ...baseSpec,
    revision: 'test-routes',
    modules: ['routes', 'middleware'],
    routes: {
      extensions: [
        { kind: 'json', method: 'GET', path: '/api/ext/hello', body: { hello: 'hot' }, description: 'json 扩展' },
        { kind: 'text', method: 'GET', path: '/api/ext/text', text: 'hot-update 0.1.0' },
      ],
      disabled: [],
    },
    middleware: { requestLog: true, timeoutMs: 0, maintenance: false },
  }
  const applied = await apply(spec)
  assertEqual(applied.ok, true, `apply 成功：${JSON.stringify(applied.error ?? {})}`)
  assertEqual(applied.result?.revision, 'test-routes')
  assertEqual(applied.result?.probed, 2, '两条扩展路由都过了自检')
  assert(applied.result!.modules.includes('routes'), `变更模块含 routes：${applied.result!.modules}`)

  const hello = await raw('/api/ext/hello')
  assertEqual(hello.status, 200, '扩展路由可访问')
  assertEqual(((await hello.json()) as { hello: string }).hello, 'hot', '返回声明的 JSON')
  assertEqual((await raw('/api/ext/text')).status, 200, 'text 扩展路由')
  assertEqual((await raw('/api/health')).status, 200, '内置路由不受影响')
  await sleep(150)
  sub.stop()
  assert(events.includes('hot/updated'), `要广播 hot/updated（实际：${events.join(', ') || '无'}）`)
})

test('非法 spec 被拒绝：当前代原样在跑（回滚到上一稳定版本）', async () => {
  const before = await status()
  const badSchema = await apply({ ...baseSpec, schema: 99, revision: 'test-bad-schema' })
  assertEqual(badSchema.ok, false, '未知 schema 必须拒绝')

  const conflict = await apply({
    ...baseSpec,
    revision: 'test-conflict',
    routes: { extensions: [{ kind: 'json', path: '/api/health', body: {} }], disabled: [] },
  })
  assertEqual(conflict.ok, false, '与内置路由冲突必须拒绝')
  assert(conflict.error?.message.includes('冲突'), `错误信息要说明冲突：${conflict.error?.message}`)

  const after = await status()
  assertEqual(after.generation, before.generation, '拒绝不改代数')
  assertEqual((await raw('/api/ext/hello')).status, 200, '当前代（含扩展路由）原样在跑')
})

test('disabled：热更新可以停用内置路由（写成不存在路径则拒绝）', async () => {
  const reachable = await raw('/api/dev/register', json({}))
  assertEqual(reachable.status, 400, '停用前可达（缺参数 ⇒ BAD_ARGS）')

  const rejected = await apply({ ...baseSpec, revision: 'test-disabled-bad', routes: { extensions: [], disabled: ['/api/not-exist'] } })
  assertEqual(rejected.ok, false, '停用不存在的内置路由必须拒绝')

  const applied = await apply({ ...baseSpec, revision: 'test-disabled', routes: { extensions: [], disabled: ['/api/dev/register'] } })
  assertEqual(applied.ok, true, '停用内置路由成功')
  // 停用后请求落到静态兜底（它只挂 GET）⇒ POST 得到 405；关键是**不再进真 handler**（400）
  const after = (await raw('/api/dev/register', json({}))).status
  assert(after !== 400, `停用后不能再进真 handler（实际状态：${after}）`)
  assertEqual((await raw('/api/health')).status, 200, '其它内置路由照常')
})

test('热中间件：维护模式拦住写请求，读与热更新 API 豁免（能自救）', async () => {
  const on = await apply({ ...baseSpec, revision: 'test-maintenance-on', middleware: { requestLog: false, timeoutMs: 0, maintenance: true } })
  assertEqual(on.ok, true, '开启维护模式')

  const blocked = await raw('/api/search', json({ query: 'x' }))
  assertEqual(blocked.status, 503, '写请求被维护模式拦住')
  const body = (await blocked.json()) as { error: { code: string } }
  assertEqual(body.error.code, 'MAINTENANCE', '错误码')
  assertEqual((await raw('/api/health')).status, 200, '读接口保持可用')
  assertEqual((await raw('/api/hot/status')).status, 200, '热更新 API 豁免（否则维护模式无法解除）')

  const off = await apply({ ...baseSpec, revision: 'test-maintenance-off' })
  assertEqual(off.ok, true, '关闭维护模式')
  assertEqual((await raw('/api/search', json({ query: 'x' }))).status, 200, '恢复后可写')
})

test('事件订阅随代切换：bus.log 把订阅的事件写进热更新日志', async () => {
  const applied = await apply({ ...baseSpec, revision: 'test-bus', bus: { log: ['history/changed'] } })
  assertEqual(applied.ok, true)
  await h.api('/api/history/clear', json({}))
  await sleep(200)

  const log = await h.api<{ entries: Array<Record<string, unknown>> }>('/api/hot/log?limit=200')
  const eventLine = log.entries.find((entry) => entry.type === 'event')
  assert(!!eventLine, '订阅的事件要写进热更新日志')
  assertEqual(eventLine!.event, 'history/changed', '事件名')
  assert(typeof eventLine!.ts === 'string' && (eventLine!.ts as string).length >= 19, '每行都有时间戳')
  assertEqual(eventLine!.hotVersion, HOT_VERSION, '每行都有机制版本')
})

test('rollback：与上一稳定代互换，再回滚 = 恢复回来', async () => {
  const first = await apply({
    ...baseSpec,
    revision: 'test-rollback-target',
    routes: { extensions: [{ kind: 'json', method: 'GET', path: '/api/ext/rb', body: { ok: true } }], disabled: [] },
  })
  assertEqual(first.ok, true)
  assertEqual((await raw('/api/ext/rb')).status, 200, '回滚前路由在')

  const rolled = await h.api<ApplyResponse>('/api/hot/rollback', json({}))
  assertEqual(rolled.ok, true, `回滚成功：${JSON.stringify(rolled.error ?? {})}`)
  assertEqual((await raw('/api/ext/rb')).status, 404, '回滚后扩展路由消失')
  assertEqual((await status()).previous?.revision, 'test-rollback-target', '被回滚的那一版成为「上一稳定」')

  const again = await h.api<ApplyResponse>('/api/hot/rollback', json({}))
  assertEqual(again.ok, true, '再回滚一次')
  assertEqual((await raw('/api/ext/rb')).status, 200, '恢复回被回滚的那一版（undo/redo 语义）')
})

test('日志文件：每次 apply / reject / rollback 都有结构化记录', async () => {
  const log = await h.api<{ entries: Array<Record<string, unknown>>; path: string }>('/api/hot/log?limit=200')
  const results = log.entries.filter((entry) => entry.type === 'apply')
  assert(results.some((entry) => entry.result === 'applied'), '有 applied 行')
  assert(results.some((entry) => entry.result === 'rejected'), '有 rejected 行')
  assert(log.entries.some((entry) => entry.type === 'rollback' && entry.result === 'rolled-back'), '有 rollback 行')
  const applied = results.find((entry) => entry.result === 'applied')!
  assert(Array.isArray(applied.modules), 'applied 行带「变更模块」')
  assert(typeof applied.generation === 'number', 'applied 行带代数')
})

test('二进制热替换：stage（真内核 probe）→ apply（备份+替换）→ rollback（恢复原字节）', async () => {
  const hot = await status()
  const exe = hot.binary.currentExe
  const original = await fsp.readFile(exe)

  const staged = await h.api<{ ok: boolean; staged: string; probe: { version: string; hotVersion: string } }>(
    '/api/hot/binary',
    json({ mode: 'stage', path: exe }),
  )
  assertEqual(staged.ok, true, `stage 成功：${JSON.stringify(staged)}`)
  assertEqual(staged.probe.version, '0.1.0', '真内核 --hot-probe 自报版本')
  assertEqual(staged.probe.hotVersion, HOT_VERSION, '自报热更新机制版本')

  const applied = await h.api<{
    ok: boolean
    pending: { backup: string; toVersion: string; fromVersion: string }
    restartScheduled: boolean
  }>('/api/hot/binary', json({ mode: 'apply', path: exe, restart: false }))
  assertEqual(applied.ok, true, `apply 成功：${JSON.stringify(applied)}`)
  assertEqual(applied.restartScheduled, false, 'restart:false ⇒ 不触发重启')
  try {
    const backupBytes = await fsp.readFile(applied.pending.backup)
    assert(Buffer.compare(backupBytes, original) === 0, '备份逐字节等于原二进制')
    const pending = (await status()).binary.pending
    assert(!!pending, 'pending 台账进 status')
    assertEqual(pending!.toVersion, '0.1.0', '待验证版本')
  } finally {
    const rolled = await h.api<{ ok: boolean; rolledBack: boolean }>('/api/hot/binary/rollback', json({}))
    assertEqual(rolled.ok, true, '回滚成功')
    assertEqual(rolled.rolledBack, true, '确实回滚了')
  }
  assert(Buffer.compare(await fsp.readFile(exe), original) === 0, '回滚后与原始字节一致')
  assertEqual((await status()).binary.pending, null, 'pending 台账已清')
})

test('持久化：current.json / previous.json 与内存中的代一致（重启后按它恢复）', async () => {
  const hot = await status()
  const saved = JSON.parse(await fsp.readFile(hot.paths.current, 'utf-8')) as { revision: string }
  assertEqual(saved.revision, hot.revision, 'current.json 与当前代一致')
  const previous = JSON.parse(await fsp.readFile(hot.paths.previous, 'utf-8')) as { revision: string }
  assertEqual(previous.revision, hot.previous?.revision, 'previous.json 与上一稳定代一致')
})

const failed = await run('内核热更新（v0.1.0）')
await h.stop()
if (failed > 0) process.exit(1)
