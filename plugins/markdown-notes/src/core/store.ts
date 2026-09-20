import { host, storage } from '@launcher/api'
import type { Note } from './notes'
import { plainNotes } from './notes'

const NOTES_KEY = 'markdown-notes:list'
const CURRENT_KEY = 'markdown-notes:current'
const PREFS_KEY = 'markdown-notes:prefs'

/** 预览字号边界：12px 是「窗口很窄也放得下表格」的下限，20px 再大就只剩几行了 */
export const MIN_FONT_SIZE = 12
export const MAX_FONT_SIZE = 20
export const DEFAULT_FONT_SIZE = 14

export interface Prefs {
  /** 预览区字号（px） */
  fontSize: number
}

export async function loadPrefs(): Promise<Prefs> {
  const fallback: Prefs = { fontSize: DEFAULT_FONT_SIZE }
  if (!host.isLauncher()) return fallback
  const raw = await storage.get<Partial<Prefs>>(PREFS_KEY).catch(() => undefined)
  const size = Number(raw?.fontSize)
  if (!Number.isFinite(size) || size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) return fallback
  return { fontSize: size }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  if (!host.isLauncher()) return
  await storage.set(PREFS_KEY, { ...prefs }).catch(() => undefined)
}

function isNote(value: unknown): value is Note {
  const note = value as Note | null
  return !!note && typeof note.id === 'string' && typeof note.content === 'string' && typeof note.updatedAt === 'number'
}

export async function loadNotes(): Promise<Note[]> {
  if (!host.isLauncher()) return []
  const raw = await storage.get<Note[]>(NOTES_KEY).catch(() => undefined)
  if (!Array.isArray(raw)) return []
  return raw.filter(isNote).map((note) => ({
    ...note,
    title: typeof note.title === 'string' && note.title ? note.title : '未命名笔记',
    createdAt: typeof note.createdAt === 'number' ? note.createdAt : note.updatedAt,
    pinned: note.pinned === true,
  }))
}

export async function saveNotes(list: Note[]): Promise<void> {
  if (!host.isLauncher()) return
  await storage.set(NOTES_KEY, plainNotes(list)).catch(() => undefined)
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
