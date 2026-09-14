/** 贡献型搜索源契约：宿主常驻该 worker，输入时下发 query */
import { ctx, log, onError, onQuery } from '@launcher/api-node'

onError()
log(`feed 启动：${ctx().command}`, undefined, 'debug')

onQuery(({ query, token }) => [
  {
    id: `echo:feed:${query}`,
    title: `echo: ${query}`,
    subtitle: `token=${token}`,
    icon: 'terminal',
    score: 0.5,
    action: { type: 'command' as const, command: 'job', args: { from: 'feed', query } },
  },
])
