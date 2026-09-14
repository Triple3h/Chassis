/**
 * 贡献型搜索源（plugin-spec §9.2）：
 * 宿主常驻本 worker，每次输入下发 query，这里返回命中的应用。
 */
import path from 'node:path'
import { ctx, log, onError, onQuery } from '@launcher/api-node'
import { IconCache } from '../core/icons'
import { searchApps } from '../core/match'
import { scanApplications, type AppEntry } from '../core/scanner'
import { loadIndex, saveIndex } from '../core/store'

onError()

const { dataPath } = ctx()
const icons = new IconCache(path.join(dataPath, 'icons'))

let apps: AppEntry[] = []
let loading: Promise<void> | null = null

async function ensureIndex(): Promise<void> {
  if (apps.length > 0) return
  if (loading) return loading
  loading = (async () => {
    const saved = await loadIndex()
    if (saved) {
      apps = saved.apps
      log(`索引已加载：${apps.length} 个应用`, undefined, 'debug')
      return
    }
    if (process.platform !== 'darwin') return
    const result = await scanApplications()
    apps = result.apps
    await saveIndex(apps).catch(() => undefined)
    log(`首次扫描完成：${apps.length} 个应用（${result.durationMs}ms）`)
  })().finally(() => {
    loading = null
  })
  return loading
}

// worker 一起来就在后台准备索引，避免首次输入时白屏
void ensureIndex()

interface ResultItem {
  id: string
  title: string
  subtitle?: string
  icon?: string
  score?: number
  action: { type: 'open'; target: string; targetKind: 'app' | 'path' }
  actions?: Array<
    | { type: 'open'; target: string; targetKind: 'app' | 'path' }
    | { type: 'copy'; text: string }
  >
}

async function toItem(app: AppEntry, score: number): Promise<ResultItem> {
  const icon = await icons.dataUrl(app.iconFile)
  const folder = path.dirname(app.path).replace(process.env.HOME ?? '\u0000', '~')
  const alias = app.aliases.find((value) => value && value !== app.name)
  return {
    id: `app:${app.path}`,
    title: app.name,
    subtitle: alias ?? folder,
    ...(icon ? { icon } : {}),
    score,
    action: { type: 'open', target: app.path, targetKind: 'app' },
    actions: [
      { type: 'open', target: path.dirname(app.path), targetKind: 'path' },
      { type: 'copy', text: app.path },
    ],
  }
}

onQuery(async ({ query }) => {
  await ensureIndex()
  if (apps.length === 0) return []
  const hits = searchApps(apps, query, 10)
  return Promise.all(hits.map((hit) => toItem(hit.app, hit.score)))
})
