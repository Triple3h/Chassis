import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 本地图片查找与读取（只在 Node Worker / script 命令里使用）。
 *
 * 为什么需要它：View 插件跑在 iframe 里，浏览器沙箱不允许按路径读文件；
 * 而 `mode: "script"` 的命令跑在 Node Worker 中，可以正常访问文件系统。
 * 于是「截图存盘 → 按路径读进来解码」这条路是通的。
 *
 * 安全约束（这一层能读整块磁盘，必须自己收紧）：
 *   1. 默认只在常见截图/图片目录里单层扫描，不递归、不越界；
 *   2. 只有显式传入 path 时才读取其它位置，且必须通过扩展名白名单 + 文件头魔数校验；
 *   3. 单文件大小上限，避免一张巨型图把 Worker 内存和 IPC 打爆。
 */

export interface LocalImageFile {
  path: string
  name: string
  size: number
  mtime: number
  mime: string
  /** base64（不带 data: 前缀） */
  data: string
}

export interface LocalImageInfo {
  path: string
  name: string
  size: number
  mtime: number
  mime: string
}

export const MAX_BYTES = 20 * 1024 * 1024

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heic',
}

/** 常见截图落点（macOS 截图默认在桌面，Windows 在「图片/屏幕截图」） */
export function defaultScanDirs(): string[] {
  const home = os.homedir()
  const dirs = [
    path.join(home, 'Pictures', 'Screenshots'),
    path.join(home, 'Pictures'),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
  ]
  if (process.platform === 'darwin') {
    // macOS 中文系统会把目录显示成中文，但磁盘上仍是英文名
    dirs.unshift(path.join(home, 'Desktop'))
  }
  return [...new Set(dirs)]
}

export function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase()
}

export function isSupportedExt(filePath: string): boolean {
  return extensionOf(filePath) in EXT_MIME
}

export function mimeFromExt(filePath: string): string {
  return EXT_MIME[extensionOf(filePath)] ?? 'application/octet-stream'
}

/** 用文件头判断真实类型，比扩展名可靠（顺便挡掉「改名成 .png 的其它文件」） */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  // HEIC/HEIF: ....ftypheic / heix / mif1
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'image/heic'
  return null
}

/**
 * 清洗用户粘贴进来的路径：
 *  - 去掉首尾空白与包裹的引号（Finder / PowerShell「复制路径」都可能带）
 *  - macOS/Linux 下把终端转义出来的 `\ ` 还原成空格
 *  - 展开开头的 `~`
 */
export function normalizePathInput(input: string): string {
  let p = input.trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim()
  }
  if (process.platform !== 'win32') p = p.replace(/\\ /g, ' ')
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

export interface ScanOptions {
  /** 只看最近多少分钟内改动过的文件 */
  withinMinutes?: number
  /** 最多返回几个候选 */
  limit?: number
  /** 自定义扫描目录（测试用） */
  dirs?: string[]
  /** 当前时间戳（测试用） */
  now?: number
}

/** 列出最近的候选图片（只读目录元信息，不读文件内容） */
export function scanRecentImages(options: ScanOptions = {}): LocalImageInfo[] {
  const within = (options.withinMinutes ?? 30) * 60 * 1000
  const limit = options.limit ?? 8
  const dirs = options.dirs ?? defaultScanDirs()
  const now = options.now ?? Date.now()
  const seen = new Set<string>()
  const out: LocalImageInfo[] = []

  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      // 目录不存在 / 没权限，跳过就好
      continue
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (seen.has(full) || !isSupportedExt(full)) continue
      try {
        const stat = statSync(full)
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) continue
        if (now - stat.mtimeMs > within) continue
        seen.add(full)
        out.push({
          path: full,
          name,
          size: stat.size,
          mtime: stat.mtimeMs,
          mime: mimeFromExt(full),
        })
      } catch {
        continue
      }
    }
  }
  // 同一毫秒写入的文件很多（连续截图），用路径兜底保证结果稳定可比
  out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  return out.slice(0, limit)
}

/** 读取指定图片并转成 base64（含魔数校验） */
export function readImageFile(inputPath: string): LocalImageFile {
  const resolved = path.resolve(normalizePathInput(inputPath))
  if (!isSupportedExt(resolved)) {
    throw new Error(`不支持的图片格式：${extensionOf(resolved) || '（无扩展名）'}，请给 .png / .jpg / .webp 等图片文件`)
  }
  if (!existsSync(resolved)) {
    throw new Error(`文件不存在：${resolved}`)
  }
  const stat = statSync(resolved)
  if (!stat.isFile()) throw new Error('这不是一个文件')
  if (stat.size === 0) throw new Error('文件是空的')
  if (stat.size > MAX_BYTES) {
    throw new Error(`图片太大（${(stat.size / 1048576).toFixed(1)}MB），请压缩到 20MB 以内`)
  }
  const buf = readFileSync(resolved)
  const mime = sniffMime(buf)
  if (!mime) throw new Error('这个文件不是能被识别的图片（文件头校验失败）')
  return {
    path: resolved,
    name: path.basename(resolved),
    size: buf.length,
    mtime: stat.mtimeMs,
    mime,
    data: buf.toString('base64'),
  }
}
