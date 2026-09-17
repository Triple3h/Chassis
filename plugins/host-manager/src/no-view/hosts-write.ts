/// <reference types="node" />
import { ctx, done, log, onError } from '@launcher/api-node'
import type { HostsWriteArgs, HostsWriteResult } from '../core/script-types'
import { resolveHostsPath, writeHostsFile } from './_hosts-file'

/**
 * script 命令：把托管区写回系统 hosts。
 *
 * package.json 里声明为 { "name": "hosts-write", "mode": "script" }，
 * View 侧用 Backend.run('hosts-write', args) 调用；产物必须是 dist/hosts-write.mjs。
 *
 * args:
 *   { region: string, remove?: string[], mode?: 'auto' | 'direct' | 'privileged', backup?: boolean }
 *   region 是**托管区文本**（含首尾标记），不是整份文件：
 *   区外的行归系统与别的程序管，我们不碰，详见 _hosts-file.ts 的 spliceRegion。
 *   remove 只用于「区外条目收进块」时把那几行从区外摘掉。
 *
 * 注意：目标路径不接收调用方传参，只由 _hosts-file.ts 里的平台规则决定，
 * 否则这个「能提权写文件」的脚本就变成了任意文件写入的跳板。
 */

onError()

void (async () => {
  const { args, dataPath } = ctx()
  const opts = (args ?? {}) as HostsWriteArgs
  // 备份与待生效文件都落在数据目录（N2：安装目录只读，升级会被覆盖）
  const baseDir = dataPath

  try {
    const region = typeof opts.region === 'string' ? opts.region : ''
    const remove = Array.isArray(opts.remove) ? opts.remove.filter((v): v is string => typeof v === 'string') : []
    const result = writeHostsFile({
      region,
      remove,
      dataPath: baseDir,
      mode: opts.mode,
      backup: opts.backup,
    })
    log('hosts-write: 完成', {
      path: result.path,
      ok: result.ok,
      method: result.method,
      changed: result.changed,
      backup: result.backup,
      verified: result.verified,
      error: result.error,
    })
    done(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('hosts-write: 失败', { message }, 'error')
    done({ ok: false, method: 'none', path: resolveHostsPath(), error: message } satisfies HostsWriteResult)
  }
})()
