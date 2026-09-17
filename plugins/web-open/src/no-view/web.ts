import { ctx, log, onError, onQuery } from '@launcher/api-node'
import { parseQuery, resolveEngine } from '../core/parse'

onError()
// 设置在 worker 启动时快照一次；用户在设置页改完会重载插件，新值随新 worker 生效
const { settings } = ctx()
const engine = resolveEngine(settings.engine)
log(`默认搜索引擎：${engine.name}`, undefined, 'debug')

onQuery(({ query }) => {
  return parseQuery(query, engine).map((hit) => {
    const isDirect = hit.kind === 'url'
    return {
      id: `web:${hit.url}`,
      title: hit.label,
      subtitle: isDirect ? '直接打开' : hit.url,
      icon: isDirect ? 'globe' : 'search',
      score: hit.score,
      action: { type: 'open' as const, target: hit.url, targetKind: 'url' as const },
      actions: [{ type: 'copy' as const, text: hit.url }],
    }
  })
})
