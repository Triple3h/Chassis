import type { HistoryEntry, KindFilter } from './types'

/** 绝对时间（相对时间由 Rust 侧给在 subtitle 里；这里补足「几点几分」） */
export function formatTime(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDateTime(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 暂停状态的一句话说明（`pausedUntil` 为 0 = 没暂停） */
export function pauseLabel(pausedUntil: number, now: number): string {
  if (!pausedUntil) return ''
  if (pausedUntil >= Number.MAX_SAFE_INTEGER) return '已暂停记录（手动恢复）'
  const left = pausedUntil - now
  if (left <= 0) return ''
  const minutes = Math.max(1, Math.round(left / 60_000))
  return `已暂停记录 · 约 ${minutes} 分钟后恢复`
}

export function kindIcon(kind: HistoryEntry['kind']): string {
  if (kind === 'image') return 'image'
  if (kind === 'file') return 'folder'
  return 'clipboard'
}

export const KIND_TABS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'file', label: '文件' },
]

/** 列表里的第二行：图片给尺寸、文件给路径、文本给全文预览 */
export function detailOf(entry: HistoryEntry): string {
  if (entry.kind === 'image') {
    return entry.width && entry.height ? `${entry.width}×${entry.height}` : '图片'
  }
  if (entry.kind === 'file') {
    return entry.paths?.join('  ') ?? ''
  }
  return entry.text ?? ''
}
