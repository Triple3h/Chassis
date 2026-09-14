import { toErrorShape, type ErrorShape } from '@launcher/plugin-manifest'
import type { AuditLog } from '../audit'

export interface AuditBind {
  pluginId: string
  channel: 'ui' | 'script' | 'kernel'
}

/** 每个「插件 → 宿主」的调用都必须过这里（P6 / §7.7） */
export async function audited<T>(
  audit: AuditLog,
  bind: AuditBind,
  method: string,
  capability: string,
  args: unknown,
  fn: () => Promise<T> | T,
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    audit.record({
      pluginId: bind.pluginId,
      channel: bind.channel,
      method,
      capability,
      ok: true,
      ms: Date.now() - start,
      args,
    })
    return result
  } catch (err) {
    const error: ErrorShape = toErrorShape(err)
    audit.record({
      pluginId: bind.pluginId,
      channel: bind.channel,
      method,
      capability,
      ok: false,
      ms: Date.now() - start,
      args,
      error,
    })
    throw err
  }
}
