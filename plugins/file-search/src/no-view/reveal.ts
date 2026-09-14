import { ctx, done, fail, onError } from '@launcher/api-node'
import { runFile } from '../core/spotlight'

onError()
const { args } = ctx()

try {
  const target = (args as { path?: unknown } | undefined)?.path
  if (typeof target !== 'string' || !target.startsWith('/')) {
    // 安全：只接受绝对路径（不接受调用方传入的相对路径或命令串）
    fail('reveal 需要绝对路径')
  } else {
    const result = await runFile('open', ['-R', target], 4000)
    done({ ok: result.ok, path: target })
  }
} catch (err) {
  fail(err)
}
