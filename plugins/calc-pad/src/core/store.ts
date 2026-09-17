import { host, storage } from '@launcher/api'
import type { Pad } from './pads'
import { plainPads } from './pads'

const PADS_KEY = 'calc-pad:pads'
const CURRENT_KEY = 'calc-pad:current'

function isPad(value: unknown): value is Pad {
  const pad = value as Pad | null
  return !!pad && typeof pad.id === 'string' && typeof pad.title === 'string' && Array.isArray(pad.rows)
}

export async function loadPads(): Promise<Pad[]> {
  if (!host.isLauncher()) return []
  const raw = await storage.get<Pad[]>(PADS_KEY).catch(() => undefined)
  if (!Array.isArray(raw)) return []
  return raw.filter(isPad).map((pad) => ({
    ...pad,
    createdAt: typeof pad.createdAt === 'number' ? pad.createdAt : Date.now(),
    updatedAt: typeof pad.updatedAt === 'number' ? pad.updatedAt : Date.now(),
  }))
}

export async function savePads(list: Pad[]): Promise<void> {
  if (!host.isLauncher()) return
  await storage.set(PADS_KEY, plainPads(list)).catch(() => undefined)
}

export async function loadCurrentId(): Promise<string> {
  if (!host.isLauncher()) return ''
  const raw = await storage.get<string>(CURRENT_KEY).catch(() => undefined)
  return typeof raw === 'string' ? raw : ''
}

export async function saveCurrentId(id: string): Promise<void> {
  if (!host.isLauncher()) return
  await storage.set(CURRENT_KEY, id).catch(() => undefined)
}
