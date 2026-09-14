/// <reference types="node" />
import { ctx, done, log, onError } from '@shared/lib/host-node'
import type { HostsReadArgs, HostsReadResult } from '../core/script-types'
import { listBackups, readBackup, readHostsFile, resolveHostsPath } from './_hosts-file'

/**
 * script 命令：读取系统 hosts 文件。
 *
 * package.json 里声明为 { "name": "hosts-read", "mode": "script" }，
 * View 侧用 Backend.run('hosts-read', args) 调用；产物必须是 dist/hosts-read.mjs。
 *
 * args:
 *   { backups: true }              → 顺带返回磁盘备份列表
 *   { backup: 'hosts-2026-…txt' }  → 读取指定备份的内容（不读系统文件）
 */

function fail(message: string): HostsReadResult {
  return {
    ok: false,
    path: resolveHostsPath(),
    content: '',
    size: 0,
    mtime: 0,
    bom: false,
    encoding: 'utf8',
    writable: false,
    platform: process.platform,
    error: message,
  }
}

onError()

void (async () => {
  const { args, dataPath } = ctx()
  const opts = (args ?? {}) as HostsReadArgs
  // 备份目录固定为 <数据目录>/backups（N2：安装目录只读）。
  // 如快下 dataPath 兜底成 <插件目录>/data，位置与历史版本完全一致。
  const baseDir = dataPath

  try {
    if (opts.backup) {
      const content = readBackup(baseDir, String(opts.backup))
      const info = listBackups(baseDir).find((b) => b.name === opts.backup)
      log('hosts-read: 读取备份', { name: opts.backup, size: content.length })
      done({
        ok: true,
        path: resolveHostsPath(),
        content,
        size: info?.size ?? content.length,
        mtime: info?.mtime ?? 0,
        bom: false,
        encoding: 'utf8',
        writable: false,
        platform: process.platform,
      } satisfies HostsReadResult)
      return
    }

    const result = readHostsFile()
    if (opts.backups) result.backups = listBackups(baseDir)
    log('hosts-read: 完成', { path: result.path, size: result.size, writable: result.writable, encoding: result.encoding })
    done(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('hosts-read: 失败', { message }, 'error')
    done(fail(message))
  }
})()
