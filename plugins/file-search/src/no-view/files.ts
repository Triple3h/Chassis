import path from 'node:path'
import { onError, onQuery } from '@launcher/api-node'
import { iconFor, prettyPath, searchFiles } from '../core/spotlight'

onError()

const LIMIT = 8

onQuery(async ({ query }) => {
  if (process.platform !== 'darwin') return []
  const hits = await searchFiles(query, LIMIT)
  return hits.map((hit) => ({
    id: `file:${hit.path}`,
    title: hit.name,
    subtitle: prettyPath(path.dirname(hit.path)),
    icon: iconFor(hit.path),
    score: hit.score,
    action: { type: 'open' as const, target: hit.path, targetKind: 'path' as const },
    actions: [
      { type: 'command' as const, command: 'reveal', args: { path: hit.path } },
      { type: 'copy' as const, text: hit.path },
    ],
  }))
})
