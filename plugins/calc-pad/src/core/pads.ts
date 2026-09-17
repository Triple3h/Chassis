import { evaluate, type Scope } from './expr'
import { formatNumber } from './format'

/** 稿纸里的一行：算式 + 算出来的结果（结果由 recompute 统一填） */
export interface PadRow {
  id: string
  expr: string
  text: string
  value?: number
  error?: string
  note?: string
}

export interface Pad {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  rows: PadRow[]
}

export function makeId(seed = Date.now()): string {
  return `p${seed.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

function padTitleFor(now: number): string {
  const date = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `稿纸 ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function createPad(now = Date.now(), title?: string): Pad {
  return {
    id: makeId(now),
    title: title?.trim() || padTitleFor(now),
    createdAt: now,
    updatedAt: now,
    rows: [],
  }
}

/**
 * 重算整张稿纸：自上而下求值，后面的行能看见前面定义的变量与 `ans`。
 * 报错的行保留原样（只写 error），不影响它后面的行 —— 稿纸是「边写边看」的。
 */
export function recompute(pad: Pad): Pad {
  const scope: Scope = { vars: {} }
  const rows = pad.rows.map((row) => {
    if (!row.expr.trim()) return { ...row, text: '', value: undefined, error: undefined }
    const result = evaluate(row.expr, scope)
    if (!result.ok) return { ...row, text: '', value: undefined, error: result.error }
    scope.vars = result.vars
    scope.last = result.value
    return { ...row, text: formatNumber(result.value), value: result.value, error: undefined }
  })
  return { ...pad, rows }
}

/** 当前作用域（底部输入框做实时预览用） */
export function padScope(pad: Pad): Scope {
  const scope: Scope = { vars: {} }
  for (const row of pad.rows) {
    if (!row.expr.trim()) continue
    const result = evaluate(row.expr, scope)
    if (!result.ok) continue
    scope.vars = result.vars
    scope.last = result.value
  }
  return scope
}

export function appendRow(pad: Pad, expr: string, now = Date.now()): Pad {
  const row: PadRow = { id: makeId(now), expr, text: '' }
  return recompute({ ...pad, rows: [...pad.rows, row], updatedAt: now })
}

export function updateRow(pad: Pad, rowId: string, expr: string, now = Date.now()): Pad {
  const rows = pad.rows.map((row) => (row.id === rowId ? { ...row, expr } : row))
  return recompute({ ...pad, rows, updatedAt: now })
}

export function removeRow(pad: Pad, rowId: string, now = Date.now()): Pad {
  return recompute({ ...pad, rows: pad.rows.filter((row) => row.id !== rowId), updatedAt: now })
}

export function setNote(pad: Pad, rowId: string, note: string, now = Date.now()): Pad {
  const rows = pad.rows.map((row) => (row.id === rowId ? { ...row, note: note.trim() || undefined } : row))
  return { ...pad, rows, updatedAt: now }
}

export function clearPad(pad: Pad, now = Date.now()): Pad {
  return { ...pad, rows: [], updatedAt: now }
}

export function renamePad(pad: Pad, title: string, now = Date.now()): Pad {
  return { ...pad, title: title.trim() || pad.title, updatedAt: now }
}

/** 整张稿纸的纯文本形态：导出与复制都用它 */
export function padText(pad: Pad): string {
  const lines = pad.rows.map((row) => {
    const head = row.error ? `${row.expr}  // ${row.error}` : `${row.expr}${row.text ? ` = ${row.text}` : ''}`
    return row.note ? `${head}  // ${row.note}` : head
  })
  return [`# ${pad.title}`, ...lines].join('\n')
}

export function padSummary(pad: Pad): string {
  if (!pad.rows.length) return '空稿纸'
  const last = pad.rows[pad.rows.length - 1]
  if (!last) return '空稿纸'
  if (last.error) return '有算不通的行'
  return last.text ? `= ${last.text}` : '空稿纸'
}

export function plainPads(list: Pad[]): Pad[] {
  return list.map((pad) => ({ ...pad, rows: pad.rows.map((row) => ({ ...row })) }))
}
