/**
 * 守「一次桥调用不留双份、也绝不留空」。
 *
 * 背景：插件页的调用会在**两处**写审计 —— 桥入口（`BridgeDispatcher.dispatch`）与
 * 服务层（`audited()`，见 services/{storage,hostUi,shell,quicklink}）。两边都记的后果实测过：
 * 一次 `ctx.storage.get` 落 **2 条**同 method / 同能力的记录，而审计环形缓冲只有 500 条
 * ⇒ 可追溯窗口被砍半，设置页审计列表成对重复。
 *
 * 现在的分工（见 `apps/kernel/src/bridge.rs` 的 `SELF_AUDITED`）：
 * - 自带审计的服务：成功路径**恰好 1 条**（服务层那一条）；
 * - 其余方法（host / commands / searchResult / exec / settings / log）：**恰好 1 条**（桥那一条）；
 * - 失败路径：**至少 1 条**，允许 2 条 —— 参数 / 能力校验可能发生在服务层记录之前，
 *   宁可多记不可漏记（P6 是「可审计」，不是「不重复」）。
 *
 * 新增 SDK 方法时请把它补进本用例（漏了 = 这条线没人守）。
 */
import { assert, assertEqual, run, test } from '../helpers/assert'
import { createHarness } from '../helpers/harness'

const h = await createHarness({ fixtures: ['echo-plugin'], label: 'bridge-audit' })

/** 跑一次桥调用，返回它新增的审计条数 */
async function auditCount(fn: () => Promise<unknown>): Promise<number> {
  const before = (await h.audit(500)).length
  await fn()
  return (await h.audit(500)).length - before
}

test('自带审计的服务：成功路径恰好一条（不双记）', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  const cases: Array<[string, Record<string, unknown>]> = [
    ['ctx.storage.set', { key: 'k', value: { a: 1 } }],
    ['ctx.storage.get', { key: 'k' }],
    ['ctx.storage.all', {}],
    ['ctx.hostUi.setFooter', { buttons: [{ type: 'button', id: 'b', label: 'x' }] }],
    ['ctx.hostUi.setSearchContent', { value: 'hi' }],
    ['ctx.quicklink.all', {}],
  ]
  for (const [method, params] of cases) {
    const count = await auditCount(() => h.bridge(sid, token, method, params))
    assertEqual(count, 1, `${method} 应当恰好一条审计，实际 ${count}（双记会让可追溯窗口减半）`)
  }
})

test('服务层不记的方法：由桥入口记一条（不得为 0）', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')
  for (const method of ['ctx.host.info', 'ctx.searchResult.clear', 'ctx.searchResult.set']) {
    const count = await auditCount(() =>
      method === 'ctx.searchResult.set'
        ? h.bridge(sid, token, method, { items: [{ id: 'i1', title: 't', action: { type: 'command', command: 'echo' } }] })
        : h.bridge(sid, token, method),
    )
    assertEqual(count, 1, `${method} 必须由桥记一条，实际 ${count}（审计漏掉 = P6 失效）`)
  }
})

test('失败路径必须留痕（可能两条：校验发生在服务层记录之前）', async () => {
  const { sid, token } = await h.openSession('echo-plugin', 'echo')

  // 非法 URL：服务层 assertHttpUrl 失败（B2 的审计在服务层内部记一次，桥再记一次）
  const badUrl = await auditCount(() => h.bridge(sid, token, 'ctx.shell.openUrl', { url: 'file:///etc/passwd' }))
  assert(badUrl >= 1, `非法 URL 也不得漏记，实际 ${badUrl}`)

  // 未知脚本命令：校验在桥/服务入口（exec 不自带审计）→ 恰好桥那一条
  const badExec = await auditCount(() => h.bridge(sid, token, 'ctx.exec.run', { command: 'not-exists' }))
  assert(badExec >= 1, `失败的 exec.run 也不得漏记，实际 ${badExec}`)

  // 无壳环境下 clipboard 读取会失败：服务层 + 桥各一条都算正常
  const noShell = await auditCount(() => h.bridge(sid, token, 'ctx.clipboard.readText'))
  assert(noShell >= 1, `无壳时的失败调用也要有审计，实际 ${noShell}`)
})

test('token 不匹配：先记 SESSION_INVALID，再拒绝', async () => {
  const { sid } = await h.openSession('echo-plugin', 'echo')
  const count = await auditCount(() => h.bridge(sid, 'deadbeef', 'ctx.storage.get', { key: 'k' }))
  assertEqual(count, 1, `会话校验失败应当恰好一条，实际 ${count}`)
})

const failed = await run('桥调用审计不重复')
await h.stop()
if (failed > 0) process.exit(1)
