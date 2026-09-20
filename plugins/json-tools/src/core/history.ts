/**
 * 历史记录（最近 20 份 JSON）：纯逻辑，落盘由调用方交给 `ctx.storage`。
 *
 * 两条边界来自底座，不是洁癖：
 *  - **字节上限**：`/api/bridge` 的 JSON body 走 axum 默认 2MB 限制，一次 `storage.set`
 *    塞太多会整个被拒（413），历史就再也写不进去 —— 所以单条与总量都要卡；
 *  - **一条记录绑定来源标签页（`owner`）**：编辑过程中按空闲落盘会 upsert 同一条，
 *    而不是把 20 个「同一份 JSON 的半成品」塞满历史；换标签页/换文件才开新记录。
 */
export interface HistoryEntry {
  id: string
  /** 来源标签页 id（每次运行都重新生成 ⇒ 旧记录不会被新会话的同名 tab 顶掉） */
  owner: string
  /** 毫秒时间戳 */
  at: number
  text: string
}

/** storage 里的键名 */
export const HISTORY_KEY = 'history'
export const HISTORY_LIMIT = 20
/** 单条上限（字节）：一份 400KB 的 JSON 已远超「回溯复用」的实际需要 */
export const HISTORY_MAX_ENTRY_BYTES = 400_000
/** 总量预算（字节）：给 2MB 的桥留足余量 */
export const HISTORY_MAX_TOTAL_BYTES = 1_000_000

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** 单行摘要（列表里展示的那一行） */
export function previewOf(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 插入一条记录，返回新列表；**内容没变时原样返回**（调用方据此跳过落盘）。
 *
 * 淘汰规则：同 owner（或同内容）的旧记录先去掉，再从最旧的一端丢到总量预算内。
 */
export function addHistoryEntry(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const text = entry.text
  if (!text.trim() || byteLength(text) > HISTORY_MAX_ENTRY_BYTES) return list
  const head = list[0]
  if (head && head.owner === entry.owner && head.text === text) return list

  const rest = list.filter((e) => e.owner !== entry.owner && e.text !== text)
  const out: HistoryEntry[] = []
  let bytes = 0
  for (const e of [entry, ...rest]) {
    const size = e === entry ? byteLength(text) : byteLength(e.text)
    if (bytes + size > HISTORY_MAX_TOTAL_BYTES) break
    bytes += size
    out.push(e)
    if (out.length >= HISTORY_LIMIT) break
  }
  return out
}

/** 读回来的原始值可能是任意脏数据（旧版本 / 手改过的 storage.json） */
export function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Partial<HistoryEntry>
    if (typeof entry.text !== 'string' || !entry.text.trim()) continue
    out.push({
      id: String(entry.id ?? ''),
      owner: String(entry.owner ?? ''),
      at: Number(entry.at) || 0,
      text: entry.text,
    })
    if (out.length >= HISTORY_LIMIT) break
  }
  return out
}
