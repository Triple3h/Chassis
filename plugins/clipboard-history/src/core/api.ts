import { exec, host } from '@launcher/api'
import type { ImageResult, ListResult, OpResult } from './types'

/**
 * 面板的一切读写都走逻辑层命令 `clip-io`：
 * iframe 里读不到本地文件（缩略图）、也写不了图片剪贴板。
 *
 * 失败一律返回 `null`（宿主不可用 / 脚本失败 / 超时）—— 调用方给出可操作的提示，
 * 不让异常冒泡成未捕获错误。
 */
async function call<T>(op: string, args: Record<string, unknown> = {}): Promise<T | null> {
  if (!host.isLauncher()) return null
  return (await exec
    .run({ command: 'clip-io', args: { op, ...args }, timeoutMs: 8000 })
    .catch(() => null)) as T | null
}

export function list(query: string, kind: string, limit = 200): Promise<ListResult | null> {
  return call<ListResult>('list', { query, kind: kind === 'all' ? '' : kind, limit })
}

export function paste(id: string): Promise<OpResult | null> {
  return call<OpResult>('paste', { id })
}

export function pin(id: string, pinned: boolean): Promise<OpResult | null> {
  return call<OpResult>('pin', { id, pinned })
}

export function remove(id: string): Promise<OpResult | null> {
  return call<OpResult>('delete', { id })
}

export function clear(all: boolean): Promise<OpResult | null> {
  return call<OpResult>('clear', { all })
}

/** `minutes`: 0 = 恢复、>0 = 暂停若干分钟、<0 = 直到手动恢复 */
export function pause(minutes: number): Promise<OpResult | null> {
  return call<OpResult>('pause', { minutes })
}

export function image(id: string): Promise<ImageResult | null> {
  return call<ImageResult>('image', { id })
}
