import { host, storage } from '@launcher/api'
import type { Snip, SnipKind } from './types'
import { plainSnips } from './snips'

const KEY = 'snips:items'

function isSnip(value: unknown): value is Snip {
  const item = value as Snip | null
  return (
    !!item &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.content === 'string' &&
    ['text', 'code', 'image'].includes(item.kind) &&
    typeof item.updatedAt === 'number'
  )
}

/** 读回时补齐可选字段：老数据没有 uses / pinned 也能正常渲染 */
function normalize(raw: Snip): Snip {
  return {
    id: raw.id,
    kind: raw.kind as SnipKind,
    title: raw.title,
    content: raw.content,
    ...(typeof raw.lang === 'string' && raw.lang ? { lang: raw.lang } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : raw.updatedAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    usedAt: typeof raw.usedAt === 'number' ? raw.usedAt : 0,
    uses: typeof raw.uses === 'number' ? raw.uses : 0,
    pinned: raw.pinned === true,
  }
}

export async function loadSnips(): Promise<Snip[]> {
  if (!host.isLauncher()) return []
  const raw = await storage.get<Snip[]>(KEY).catch(() => undefined)
  if (!Array.isArray(raw)) return []
  return raw.filter(isSnip).map(normalize)
}

export async function saveSnips(list: Snip[]): Promise<void> {
  if (!host.isLauncher()) return
  await storage.set(KEY, plainSnips(list)).catch(() => undefined)
}
