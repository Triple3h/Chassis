import { ctx, log, onError, onQuery } from '@launcher/api-node'
import { storage } from '@launcher/api-node'
import { DEFAULT_ENGINES, parseQuery, type Engine } from '../core/parse'

onError()
const { pluginId } = ctx()
void pluginId

let engines: Engine[] = DEFAULT_ENGINES
let ready: Promise<void> | null = null

async function ensureEngines(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    try {
      const saved = await storage.get<Engine[]>('engines')
      if (Array.isArray(saved) && saved.length > 0) {
        engines = saved.filter((e) => e && typeof e.template === 'string' && e.template.includes('{q}'))
        log(`已加载 ${engines.length} 个搜索引擎`, undefined, 'debug')
      }
    } catch {
      /* 用默认引擎 */
    }
  })()
  return ready
}

onQuery(async ({ query }) => {
  await ensureEngines()
  return parseQuery(query, engines).map((hit) => {
    const isDirect = hit.kind === 'url'
    return {
      id: `web:${hit.url}`,
      title: isDirect ? hit.label : hit.label,
      subtitle: isDirect ? '直接打开' : hit.url,
      icon: isDirect ? 'globe' : 'search',
      score: hit.score,
      action: { type: 'open' as const, target: hit.url, targetKind: 'url' as const },
      actions: [{ type: 'copy' as const, text: hit.url }],
    }
  })
})
