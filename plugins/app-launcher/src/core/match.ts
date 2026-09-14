import type { AppEntry } from './scanner'

export interface AppHit {
  app: AppEntry
  score: number
}

/** 拼音首字母（如 "chr" 命中 "Chrome"），只处理 ASCII 前缀场景 */
function acronym(text: string): string {
  return text
    .split(/[\s\-_.]+/)
    .map((part) => part[0] ?? '')
    .join('')
    .toLowerCase()
}

/**
 * 插件侧粗排（内核还会用自己的匹配公式再打分）。
 * 返回 0 分以上、按分数降序的命中项。
 */
export function searchApps(apps: AppEntry[], query: string, limit: number): AppHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const hits: AppHit[] = []
  for (const app of apps) {
    const name = app.name.toLowerCase()
    let score = -1
    if (name === q) score = 1
    else if (name.startsWith(q)) score = 0.9
    else if (name.includes(q)) score = 0.7
    else {
      for (const alias of app.aliases) {
        const value = alias.toLowerCase()
        if (value === q || value.startsWith(q)) {
          score = Math.max(score, 0.65)
          break
        }
      }
      if (score < 0 && acronym(app.name) === q) score = 0.55
      if (score < 0 && app.path.toLowerCase().includes(q)) score = 0.4
    }
    if (score >= 0) hits.push({ app, score })
  }

  hits.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name, 'zh-Hans-CN'))
  return hits.slice(0, limit)
}
