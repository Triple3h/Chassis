/** script 契约：`done(x)` 的 x 即调用方 `ctx.exec.run` 的返回值 */
import { ctx, done, fail, onError } from '@launcher/api-node'

onError()

try {
  const input = (ctx().args ?? {}) as { n?: number; fail?: boolean }
  if (input.fail) {
    fail('compute 按要求失败')
  } else {
    const n = Number(input.n ?? 1)
    if (!Number.isFinite(n)) fail('n 必须是数字')
    else done({ n, doubled: n * 2, pluginId: ctx().pluginId })
  }
} catch (err) {
  fail(err)
}
