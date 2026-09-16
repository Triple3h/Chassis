import { storage } from '@launcher/api'

/**
 * 快照（写入前的自动存档 + 用户手动存档）。
 *
 * 自动快照负责「改错了能退回去」，手动快照负责「几套配置来回切」。
 * 两者同一份结构，靠 kind 区分；存储走宿主 LocalStorage（dev 下自动回落 localStorage）。
 */

export interface Snapshot {
  id: string
  name: string
  kind: 'auto' | 'manual'
  createdAt: number
  /** 当时的完整文件内容 */
  content: string
  /** 条目数，列表里展示用 */
  entries: number
}

const KEY = 'hosts:snapshots'

/** 自动快照保留份数 */
export const MAX_AUTO = 20
/** 手动快照保留份数 */
export const MAX_MANUAL = 30
/** 单份内容上限（超过就不值得存了） */
const MAX_CONTENT = 512 * 1024
/** 总体积上限，超了先丢最旧的自动快照 */
const MAX_TOTAL = 2 * 1024 * 1024

export function snapshotId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 按规则裁剪：分别限制自动 / 手动份数，再卡总体积。
 * 纯函数，方便单测。
 */
export function pruneSnapshots(list: Snapshot[]): Snapshot[] {
  const byNewest = (a: Snapshot, b: Snapshot) => b.createdAt - a.createdAt
  const autos = list.filter((s) => s.kind === 'auto').sort(byNewest).slice(0, MAX_AUTO)
  const manuals = list.filter((s) => s.kind === 'manual').sort(byNewest).slice(0, MAX_MANUAL)
  let kept = [...autos, ...manuals].sort((a, b) => a.createdAt - b.createdAt)

  let total = kept.reduce((sum, s) => sum + s.content.length, 0)
  while (total > MAX_TOTAL && kept.length > 1) {
    // 从最旧的一份开始丢；手动快照最后丢
    const idx = kept.findIndex((s) => s.kind === 'auto')
    const victim = idx >= 0 ? idx : 0
    total -= kept[victim].content.length
    kept = kept.filter((_, i) => i !== victim)
  }
  return kept
}

/** 追加一份快照并裁剪（纯函数） */
export function pushSnapshot(
  list: Snapshot[],
  input: { name: string; kind: Snapshot['kind']; content: string; entries: number; now?: number },
): Snapshot[] {
  if (input.content.length > MAX_CONTENT) return list
  const snap: Snapshot = {
    id: snapshotId(),
    name: input.name,
    kind: input.kind,
    createdAt: input.now ?? Date.now(),
    content: input.content,
    entries: input.entries,
  }
  return pruneSnapshots([...list, snap])
}

export function removeSnapshot(list: Snapshot[], id: string): Snapshot[] {
  return list.filter((s) => s.id !== id)
}

/* ------------------------------------------------------------------ 持久化 */

function isSnapshot(value: unknown): value is Snapshot {
  const s = value as Snapshot | null
  return !!s && typeof s.id === 'string' && typeof s.content === 'string' && typeof s.createdAt === 'number'
}

export async function loadSnapshots(): Promise<Snapshot[]> {
  const raw = await storage.get<unknown>(KEY)
  if (!Array.isArray(raw)) return []
  return pruneSnapshots(raw.filter(isSnapshot)).sort((a, b) => b.createdAt - a.createdAt)
}

export async function persistSnapshots(list: Snapshot[]): Promise<void> {
  await storage.set(KEY, pruneSnapshots(list))
}
