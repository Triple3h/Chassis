import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface FileHit {
  path: string
  name: string
  score: number
}

const SEARCH_ROOTS = [os.homedir(), '/Applications', '/Users/Shared', '/Library']

export function runFile(
  file: string,
  args: string[],
  timeoutMs = 3000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '' }),
    )
  })
}

/** 用 Spotlight 的 mdfind 查文件名（macOS 自带，无需额外权限） */
export async function searchFiles(query: string, limit: number): Promise<FileHit[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []
  const args: string[] = []
  for (const root of SEARCH_ROOTS) args.push('-onlyin', root)
  args.push('-name', trimmed)

  const { stdout } = await runFile('mdfind', args)
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const seen = new Set<string>()
  const hits: FileHit[] = []
  const lower = trimmed.toLowerCase()

  for (const filePath of lines) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    const name = path.basename(filePath)
    const nameLower = name.toLowerCase()
    let score = 0.45
    if (nameLower === lower) score = 1
    else if (nameLower.startsWith(lower)) score = 0.85
    else if (nameLower.includes(lower)) score = 0.65
    hits.push({ path: filePath, name, score })
    if (hits.length >= limit * 3) break
  }

  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  return hits.slice(0, limit)
}

const ICON_BY_EXT: Record<string, string> = {
  png: 'file-text',
  jpg: 'file-text',
  jpeg: 'file-text',
  gif: 'file-text',
  webp: 'file-text',
  svg: 'file-text',
  pdf: 'file-text',
  md: 'file-text',
  txt: 'file-text',
  json: 'file-text',
  ts: 'terminal',
  tsx: 'terminal',
  js: 'terminal',
  jsx: 'terminal',
  py: 'terminal',
  sh: 'terminal',
  go: 'terminal',
  rs: 'terminal',
  zip: 'folder',
  dmg: 'folder',
  app: 'app-window',
}

export function iconFor(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase()
  return ICON_BY_EXT[ext] ?? 'file'
}

export function prettyPath(filePath: string): string {
  const home = os.homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}
