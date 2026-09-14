/**
 * 脚本侧（no-view / script 命令）的宿主适配。
 *
 * 为什么不用任何 SDK：跑在 Node Worker 里的脚本，两个宿主注入的东西几乎一样
 * （`workerData` + `parentPort.postMessage`）。直接说这套协议，脚本就**天生双宿主兼容**，
 * 也就不必把 `@sofastapp/api/node` 打进产物。
 *
 * 两个宿主**并非逐字节相同**（实测 @sofastapp/api@0.0.3 与底座 plugin-api-node）：
 *
 * | 消息 | 如快 | 底座 | 本文件的做法 |
 * |---|---|---|---|
 * | progress | `{type:'progress', progress}` | `{type:'progress', p}` | 两个字段都发 |
 * | done(undefined) | 不发 result，只发 done | 发 result(data:undefined) + done | 与如快一致（对底座等价） |
 * | fail(e) | `{type:'error', error}` | `{type:'result', data:{__error}}` + `{type:'done'}` | 三种都发，谁认谁处理 |
 *
 * 数据落点：**只写 `ctx().dataPath`**（N2 —— `pluginPath` 是只读安装目录，升级会覆盖）。
 * `dataPath` 的兜底 `pluginPath/data` 恰好就是如快里的旧位置，所以备份等在如快里原地不动、
 * 在新底座里自动落到 `<dataRoot>/plugins/<id>/`。
 */

import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

export interface NodeContext {
  command: string
  args: unknown
  /** 只读安装目录（N2：禁止写入） */
  pluginPath: string
  /** 唯一可写目录（N2） */
  dataPath: string
  dataRoot: string
  pluginId: string
  mode: 'run' | 'search'
}

interface WorkerData {
  command?: string
  args?: unknown
  pluginPath?: string
  dataPath?: string
  dataRoot?: string
  pluginId?: string
  mode?: string
}

export function ctx(): NodeContext {
  const wd = (workerData ?? {}) as WorkerData
  const pluginPath = wd.pluginPath?.trim() || process.cwd()
  return {
    command: wd.command ?? '',
    args: wd.args,
    pluginPath,
    // ← 这一行同时兼容两个宿主：新底座给 dataPath；如快没给，退回它的旧位置
    dataPath: wd.dataPath?.trim() || path.join(pluginPath, 'data'),
    dataRoot: wd.dataRoot?.trim() || path.dirname(pluginPath),
    // 插件目录名就是插件 id（两个宿主的安装目录布局都是 <root>/<pluginId>）
    pluginId: wd.pluginId?.trim() || path.basename(pluginPath),
    mode: wd.mode === 'search' ? 'search' : 'run',
  }
}

type Level = 'info' | 'debug' | 'warn' | 'error'

function post(message: Record<string, unknown>): void {
  try {
    parentPort?.postMessage(message)
  } catch {
    /* 宿主已经关了，发不出去就算了 */
  }
}

export function log(message: string, data?: unknown, level: Level = 'info'): void {
  post({ type: 'log', level, message, data })
}

export function progress(p: number, data?: unknown): void {
  const value = Math.max(0, Math.min(1, Number(p) || 0))
  post({ type: 'progress', p: value, progress: value, data })
}

export function done(result?: unknown): void {
  if (typeof result !== 'undefined') post({ type: 'result', data: result })
  post({ type: 'done' })
}

export function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // 如快认这条
  post({ type: 'error', error: message })
  // 底座认这两条（顺序不能反：result 必须在 done 之前）
  post({ type: 'result', data: { __error: message } })
  post({ type: 'done' })
}

export function onError(): void {
  process.on('uncaughtException', (e) => fail(e))
  process.on('unhandledRejection', (e) => fail(e))
}
