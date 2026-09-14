import { pinyin } from 'pinyin-pro'
import type { MatchSpan } from '@launcher/plugin-manifest'
import { normalizeQuery } from './util/text'

export interface SearchTarget {
  title: string
  subtitle?: string
  keywords?: string[]
  pinyin?: PinyinForms
}

export interface PinyinForms {
  full: string
  first: string
}

const cache = new Map<string, PinyinForms>()
const CACHE_LIMIT = 4000

/** 全拼 + 首字母两级索引（requirements §12 风险对策） */
export function buildPinyin(text: string): PinyinForms {
  const cached = cache.get(text)
  if (cached) return cached
  let full = ''
  let first = ''
  try {
    full = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('').toLowerCase()
    first = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' })
      .join('')
      .toLowerCase()
  } catch {
    full = text.toLowerCase()
    first = text.toLowerCase()
  }
  const forms = { full, first }
  if (cache.size > CACHE_LIMIT) cache.clear()
  cache.set(text, forms)
  return forms
}

export interface MatchResult {
  /** 0–1；-1 表示不匹配 */
  score: number
  span: MatchSpan | null
}

const NO_MATCH: MatchResult = { score: -1, span: null }

function asciiRatio(input: string): number {
  if (!input) return 0
  let ascii = 0
  for (const ch of input) if (ch.charCodeAt(0) < 128) ascii += 1
  return ascii / [...input].length
}

function findSpan(haystack: string, needle: string): MatchSpan | null {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return null
  return { start: idx, length: needle.length }
}

/**
 * 匹配打分（requirements §7.5）：
 * 标题前缀 1.0 / 包含 0.7 / 拼音全拼 0.6 / 首字母 0.5 / 副标题与 keywords 0.4
 */
export function matchTarget(query: string, target: SearchTarget): MatchResult {
  const q = normalizeQuery(query)
  if (!q) return { score: 0, span: null }

  const title = target.title ?? ''
  const lowerTitle = title.toLowerCase()

  if (lowerTitle.startsWith(q)) return { score: 1, span: { start: 0, length: q.length } }
  if (lowerTitle.includes(q)) return { score: 0.7, span: findSpan(title, q) }

  const queryIsAscii = asciiRatio(q) > 0.6
  if (queryIsAscii) {
    const forms = target.pinyin ?? buildPinyin(title)
    if (forms.full.startsWith(q)) return { score: 0.6, span: null }
    if (forms.full.includes(q)) return { score: 0.6, span: null }
    if (forms.first.startsWith(q)) return { score: 0.5, span: null }
    if (q.length >= 2 && forms.first.includes(q)) return { score: 0.5, span: null }
  }

  const subtitle = target.subtitle ?? ''
  if (subtitle && subtitle.toLowerCase().includes(q)) return { score: 0.4, span: null }
  for (const kw of target.keywords ?? []) {
    if (!kw) continue
    if (kw.toLowerCase().includes(q)) return { score: 0.4, span: null }
    if (queryIsAscii) {
      const kwForms = buildPinyin(kw)
      if (kwForms.full.includes(q) || kwForms.first.includes(q)) return { score: 0.4, span: null }
    }
  }

  return NO_MATCH
}

/** 时间衰减：半衰 3 天 */
export function recencyScore(lastUsed: number, now = Date.now()): number {
  const deltaHours = Math.max(0, (now - lastUsed) / 3_600_000)
  return Math.exp(-deltaHours / 72)
}

/** 频率：min(1, log2(count + 1) / 5) */
export function frequencyScore(count: number): number {
  return Math.min(1, Math.log2(Math.max(0, count) + 1) / 5)
}

/** 历史/固定项综合分（requirements §7.5） */
export function combinedScore(match: number, lastUsed: number, count: number, now = Date.now()): number {
  return 0.55 * match + 0.3 * recencyScore(lastUsed, now) + 0.15 * frequencyScore(count)
}

/** 插件自评与内核评分的混合 */
export function blendPluginScore(pluginScore: number | undefined, kernelScore: number): number {
  if (pluginScore === undefined || Number.isNaN(pluginScore)) return kernelScore
  const p = Math.min(1, Math.max(0, pluginScore))
  const k = Math.min(1, Math.max(0, kernelScore))
  return 0.6 * p + 0.4 * k
}
