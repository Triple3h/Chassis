import { host, storage } from '@launcher/api'
import type { Note } from './notes'
import { plainNotes } from './notes'

const NOTES_KEY = 'markdown-notes:list'
const CURRENT_KEY = 'markdown-notes:current'

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
