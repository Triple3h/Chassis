import type { ActionResult } from '@launcher/plugin-manifest'
import type { Disposer, ExecContext, Middleware, MiddlewareStage } from './types'

interface Entry {
  fn: Middleware
  label: string
  pluginId: string
}

/**
 * 执行管线（requirements §7.3）：
 * invoke → resolve → pre-execute → execute → post-execute → ActionResult
 * 中间件本身也是插件注册的（提权确认 / 审计 / 重试都是插件）。
 */
export class Pipeline {
  private stages: Record<MiddlewareStage, Entry[]> = {
    'pre-execute': [],
    execute: [],
    'post-execute': [],
  }

  use(stage: MiddlewareStage, fn: Middleware, pluginId = 'kernel', label = 'anonymous'): Disposer {
    const entry: Entry = { fn, label, pluginId }
    this.stages[stage].push(entry)
    return () => {
      const list = this.stages[stage]
      const idx = list.indexOf(entry)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  async run(ctx: ExecContext, terminal: () => Promise<ActionResult>): Promise<ActionResult> {
    const chain = [
      ...this.stages['pre-execute'],
      ...this.stages.execute,
      ...this.stages['post-execute'],
    ]
    const composed = chain.reduceRight<() => Promise<ActionResult>>(
      (next, entry) => () => entry.fn(ctx, next),
      terminal,
    )
    return composed()
  }
}
