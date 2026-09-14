/// <reference types="node" />
import { ctx, done, log, onError } from '@shared/lib/host-node'
import { defaultScanDirs, readImageFile, scanRecentImages, type LocalImageFile, type LocalImageInfo } from './find-image'

/**
 * script 命令：把本地图片读成 base64 交回 View。
 *
 * package.json 里声明为 { "name": "read-image", "mode": "script" }，
 * View 侧用 Backend.run('read-image', args) 调用；产物必须是 dist/read-image.mjs。
 *
 * args:
 *   { listOnly: true, withinMinutes?: number, limit?: number }  → 只列候选
 *   { path: '/Users/x/Desktop/截图.png' }                       → 读取指定文件
 */

export interface ReadImageResult {
  ok: boolean
  /** 只返回元信息，不带 base64 */
  files: Array<LocalImageInfo | LocalImageFile>
  dirs: string[]
  error?: string
}

interface Args {
  path?: string
  listOnly?: boolean
  withinMinutes?: number
  limit?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

onError()

void (async () => {
  const { args, dataPath } = ctx()
  const opts = (args ?? {}) as Args
  const dirs = defaultScanDirs()
  const result: ReadImageResult = { ok: false, files: [], dirs }

  try {
    if (opts.path) {
      const file = readImageFile(String(opts.path))
      log('read-image: 读取指定文件', { path: file.path, size: file.size, dataPath })
      done({ ...result, ok: true, files: [file] } satisfies ReadImageResult)
      return
    }

    const candidates = scanRecentImages({
      withinMinutes: clamp(Number(opts.withinMinutes) || 30, 1, 24 * 60),
      limit: clamp(Number(opts.limit) || 8, 1, 20),
      dirs,
    })
    log('read-image: 扫描最近截图', { count: candidates.length, dirs })

    if (opts.listOnly) {
      done({ ...result, ok: true, files: candidates } satisfies ReadImageResult)
      return
    }

    // 不带 listOnly 时直接读最新的一张，方便一键导入
    if (!candidates.length) {
      done({ ...result, ok: true, files: [] } satisfies ReadImageResult)
      return
    }
    const file = readImageFile(candidates[0].path)
    done({ ...result, ok: true, files: [file] } satisfies ReadImageResult)
  } catch (err) {
    done({
      ...result,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ReadImageResult)
  }
})()
