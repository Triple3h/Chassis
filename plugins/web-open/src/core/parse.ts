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

/** 可选引擎；清单 `settings` 的 options 与这里一一对应（改一处要改两处） */
export const ENGINES: Engine[] = [
  { id: 'google', name: 'Google', icon: 'search', template: 'https://www.google.com/search?q={q}' },
  { id: 'bing', name: 'Bing', icon: 'search', template: 'https://www.bing.com/search?q={q}' },
  { id: 'baidu', name: '百度', icon: 'search', template: 'https://www.baidu.com/s?wd={q}' },
  { id: 'github', name: 'GitHub', icon: 'terminal', template: 'https://github.com/search?q={q}' },
]

const FALLBACK_ENGINE = ENGINES[0]!

/** 设置里的引擎 id → 引擎；认不出来就回落第一个（用户配置异常也不至于没有搜索入口） */
export function resolveEngine(id: unknown): Engine {
  if (typeof id !== 'string') return FALLBACK_ENGINE
  return ENGINES.find((engine) => engine.id === id) ?? FALLBACK_ENGINE
}

export function normalizeUserUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^mailto:/i.test(raw)) return raw
  if (DOMAIN_RE.test(raw) || LOCALHOST_RE.test(raw) || IPV4_RE.test(raw)) return `https://${raw}`
  return null
}

/**
 * 解析输入：能当网址就直接打开，否则给**一条**默认引擎的搜索项。
 *
 * 只出一条是刻意的：四个引擎全出时，「最佳匹配」整个分区都是同一个查询串，
 * 真正命中的命令反而被挤到后面。引擎在设置里换（`ctx().settings.engine`）。
 */
export function parseQuery(input: string, engine: Engine = FALLBACK_ENGINE): UrlHit[] {
  const raw = input.trim()
  if (!raw) return []

  const direct = normalizeUserUrl(raw)
  if (direct) {
    return [{ url: direct, label: `打开 ${direct.replace(/^https?:\/\//, '')}`, kind: 'url', score: 1 }]
  }

  return [
    {
      url: engine.template.replace('{q}', encodeURIComponent(raw)),
      label: `用 ${engine.name} 搜索「${raw}」`,
      kind: 'search',
      engine: engine.id,
      score: 0.8,
    },
  ]
}
