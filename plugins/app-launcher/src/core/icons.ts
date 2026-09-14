import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 图标：macOS 应用图标是 .icns，浏览器不认；
 * 用系统自带的 `sips` 转成 64px PNG 并 base64 成 data URL（插件的 ResultItem 只接受 lucide 名 / 相对路径 / data URL）。
 * 结果缓存在 dataPath（N2：唯一可写目录），避免每次搜索都转换。
 */
export class IconCache {
  private memory = new Map<string, string | null>()

  constructor(private readonly dir: string) {}

  async dataUrl(icnsPath: string | undefined): Promise<string | undefined> {
    if (!icnsPath) return undefined
    const cached = this.memory.get(icnsPath)
    if (cached !== undefined) return cached ?? undefined

    const key = createHash('sha1').update(icnsPath).digest('hex')
    const target = path.join(this.dir, `${key}.png`)
    let ready = await exists(target)
    if (!ready) {
      await fs.mkdir(this.dir, { recursive: true }).catch(() => undefined)
      ready = await convert(icnsPath, target)
    }
    if (!ready) {
      this.memory.set(icnsPath, null)
      return undefined
    }
    try {
      const buffer = await fs.readFile(target)
      const url = `data:image/png;base64,${buffer.toString('base64')}`
      this.memory.set(icnsPath, url)
      return url
    } catch {
      this.memory.set(icnsPath, null)
      return undefined
    }
  }
}

function convert(source: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 不接受调用方传入的任意目标路径：source 来自扫描结果，target 由 hash 生成
    execFile(
      'sips',
      ['-s', 'format', 'png', '-Z', '64', source, '--out', target],
      { timeout: 5000 },
      (err) => resolve(!err),
    )
  })
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
