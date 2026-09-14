import fs from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 原子写：临时文件 + rename（requirements §7.5） */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/**
 * 防目录穿越（requirements §9「供应链」/ plugin-spec §2.3）。
 * 校验字符串可以安全作为文件名片段，不可含路径分隔符与 `..`。
 * 移植自 ZTools `utils/pluginStorage.ts`（MIT，见 docs/THIRD-PARTY.md）。
 */
export function assertSafePathPart(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(`${field} 不能用于生成文件路径`)
  }
}

/**
 * 解析 `rel` 到 root 下，越界返回 null（静态文件服务用）。
 * 注意：root 先 `path.resolve()` 再比较——否则传入相对路径时前缀比较必然失败（表现为 403）。
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const base = path.resolve(root)
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '')
  const abs = path.resolve(base, normalized)
  const rootWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`
  if (abs !== base && !abs.startsWith(rootWithSep)) return null
  return abs
}

/** debounce 落盘（requirements §7.5：写入 debounce 500ms） */
export function createDebouncedWriter(write: () => Promise<void>, delayMs = 500) {
  let timer: NodeJS.Timeout | null = null
  let pending: Promise<void> = Promise.resolve()

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = pending.then(write, write)
    await pending
  }

  return {
    schedule(): void {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        pending = pending.then(write, write)
      }, delayMs)
      timer.unref?.()
    },
    flush,
  }
}
