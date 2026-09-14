export interface UrlHit {
  url: string
  label: string
  kind: 'url' | 'search'
  /** 用哪个引擎（search 时） */
  engine?: string
  score: number
}

const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i
const LOCALHOST_RE = /^localhost(?::\d+)?(?:[/?#].*)?$/i
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/

export interface Engine {
  id: string
  name: string
  icon: string
  template: string
}

export const DEFAULT_ENGINES: Engine[] = [
  { id: 'google', name: 'Google', icon: 'search', template: 'https://www.google.com/search?q={q}' },
  { id: 'bing', name: 'Bing', icon: 'search', template: 'https://www.bing.com/search?q={q}' },
  { id: 'baidu', name: '百度', icon: 'search', template: 'https://www.baidu.com/s?wd={q}' },
  { id: 'github', name: 'GitHub', icon: 'terminal', template: 'https://github.com/search?q={q}' },
]

export function normalizeUserUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^mailto:/i.test(raw)) return raw
  if (DOMAIN_RE.test(raw) || LOCALHOST_RE.test(raw) || IPV4_RE.test(raw)) return `https://${raw}`
  return null
}

/**
 * 解析输入：优先当作网址，其次给出多引擎搜索入口。
 * 单一搜索项排在第一（Enter 直接搜），其余引擎作为动作项。
 */
export function parseQuery(input: string, engines: Engine[]): UrlHit[] {
  const raw = input.trim()
  if (!raw) return []

  const direct = normalizeUserUrl(raw)
  if (direct) {
    return [{ url: direct, label: `打开 ${direct.replace(/^https?:\/\//, '')}`, kind: 'url', score: 1 }]
  }

  const hits: UrlHit[] = []
  const enabled = engines.length > 0 ? engines : DEFAULT_ENGINES
  const encoded = encodeURIComponent(raw)
  enabled.forEach((engine, index) => {
    hits.push({
      url: engine.template.replace('{q}', encoded),
      label: `用 ${engine.name} 搜索「${raw}」`,
      kind: 'search',
      engine: engine.id,
      score: index === 0 ? 0.8 : 0.5,
    })
  })
  return hits
}
