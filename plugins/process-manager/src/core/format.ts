/**
 * 展示格式化 + 过滤 / 排序（纯函数，可单测）。界面只做渲染，判断都在这里。
 */

import type { KillTarget, PortEntry, ProcEntry, Risk } from './types'

export type PortSortKey = 'port' | 'process' | 'memory'
export type ProcSortKey = 'cpu' | 'memory' | 'name' | 'pid'

const KIB = 1024

/** 字节 → `1.5 GB` 这种人类可读的形式（拿不到显示 `—`） */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < KIB) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / KIB
  let unit = 0
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** CPU 百分比：小于 10% 保留一位小数（0 显示成 0%） */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '0%'
  if (value < 10) return `${value.toFixed(1)}%`
  return `${Math.round(value)}%`
}

/** 内存占系统总内存的百分比（总内存未知时返回 null） */
export function memoryShare(bytes: number | null | undefined, totalBytes: number | null | undefined): number | null {
  if (!bytes || !totalBytes || totalBytes <= 0) return null
  return (bytes / totalBytes) * 100
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** epoch 毫秒 → `14:32:05` */
export function formatClock(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  const date = new Date(epochMs)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 已运行时长：`3 分钟` / `2 小时 5 分` / `4 天 3 小时` */
export function formatUptime(startedAtSec: number | null | undefined, nowMs: number): string {
  if (!startedAtSec || startedAtSec <= 0) return '—'
  const seconds = Math.floor(nowMs / 1000) - startedAtSec
  if (seconds < 0) return '—'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/** socket 状态 → 中文标签 */
export function stateLabel(state: string): string {
  switch (state) {
    case 'listen':
      return '监听'
    case 'established':
      return '已连接'
    case 'time_wait':
      return 'TIME_WAIT'
    case 'close_wait':
      return 'CLOSE_WAIT'
    case 'syn_sent':
      return 'SYN_SENT'
    case '':
      return '—'
    default:
      return state.toUpperCase()
  }
}

export const RISK_LABEL: Record<Risk, string> = {
  safe: '普通进程',
  caution: '系统组件',
  blocked: '受保护',
}

export const RISK_HINT: Record<Risk, string> = {
  safe: '',
  caution: '系统界面组件：终止后一般会自动重启，期间界面会短暂闪断',
  blocked: '系统关键组件或启动台自身：为安全起见不允许终止',
}

/**
 * 端口表过滤：端口号（`3000` / `:3000`）、进程名、PID、用户名、协议都能命中。
 */
export function matchesPortQuery(entry: PortEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const portQuery = q.startsWith(':') ? q.slice(1) : q
  return (
    String(entry.port).includes(portQuery) ||
    entry.process.toLowerCase().includes(q) ||
    String(entry.pid) === q ||
    (entry.user ?? '').toLowerCase().includes(q) ||
    entry.protocol === q
  )
}

/** 进程表过滤：进程名、PID、用户名。 */
export function matchesProcQuery(entry: ProcEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    entry.name.toLowerCase().includes(q) ||
    String(entry.pid) === q ||
    (entry.user ?? '').toLowerCase().includes(q)
  )
}

export function sortPorts(entries: PortEntry[], key: PortSortKey): PortEntry[] {
  const list = [...entries]
  if (key === 'process') {
    list.sort((a, b) => a.process.localeCompare(b.process, 'zh') || a.port - b.port)
  } else if (key === 'memory') {
    list.sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0) || a.port - b.port)
  } else {
    list.sort((a, b) => a.port - b.port || a.pid - b.pid)
  }
  return list
}

export function sortProcs(entries: ProcEntry[], key: ProcSortKey): ProcEntry[] {
  const list = [...entries]
  switch (key) {
    case 'memory':
      list.sort((a, b) => b.memory - a.memory)
      break
    case 'name':
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      break
    case 'pid':
      list.sort((a, b) => a.pid - b.pid)
      break
    default:
      list.sort((a, b) => b.cpu - a.cpu || b.memory - a.memory)
  }
  return list
}

/** 拿一个进程的「终止目标」快照（从进程表 / 详情来）。 */
export function killTargetFromProc(entry: ProcEntry, ports: number[] = []): KillTarget {
  return {
    pid: entry.pid,
    name: entry.name,
    user: entry.user,
    cpu: entry.cpu,
    memory: entry.memory,
    risk: entry.risk,
    selfRelated: entry.selfRelated,
    ports,
  }
}
