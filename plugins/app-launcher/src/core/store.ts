import { storage } from '@launcher/api-node'
import type { AppEntry } from './scanner'

const KEY = 'app-index'

export interface AppIndex {
  version: 1
  scannedAt: number
  apps: AppEntry[]
}

export async function loadIndex(): Promise<AppIndex | null> {
  try {
    const saved = await storage.get<AppIndex>(KEY)
    if (saved && Array.isArray(saved.apps) && saved.apps.length > 0) return saved
  } catch {
    /* 宿主未就绪 */
  }
  return null
}

export async function saveIndex(apps: AppEntry[]): Promise<void> {
  const payload: AppIndex = { version: 1, scannedAt: Date.now(), apps }
  await storage.set(KEY, payload)
}

export async function indexAgeDays(): Promise<number | null> {
  const saved = await loadIndex()
  if (!saved) return null
  return (Date.now() - saved.scannedAt) / 86_400_000
}
