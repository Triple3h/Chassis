/**
 * 与 Rust 逻辑层（`src/model.rs` / `src/guard.rs`）逐字段对齐的类型（camelCase）。
 * 改字段两边必须同步 —— 这里是视图侧的唯一真源，组件只从这里取。
 */

export type Risk = 'safe' | 'caution' | 'blocked'

/** 端口占用条目（`port-list` 的 entries[]） */
export interface PortEntry {
  port: number
  /** `tcp` / `udp` */
  protocol: string
  /** 绑定地址：`*` / `0.0.0.0` / `127.0.0.1` / `::` / `::1` */
  address: string
  /** `listen` / `established` / `time_wait` …（UDP 为空） */
  state: string
  pid: number
  process: string
  user?: string | null
  /** 常驻内存（bytes） */
  memory?: number | null
  risk: Risk
  selfRelated: boolean
}

/** 进程条目（`proc-list` 的 entries[]） */
export interface ProcEntry {
  pid: number
  name: string
  user?: string | null
  /** 百分比，单核满载 = 100（与活动监视器 / 任务管理器同口径） */
  cpu: number
  /** 常驻内存（bytes） */
  memory: number
  parent?: number | null
  risk: Risk
  selfRelated: boolean
}

/** 进程详情（`proc-detail`） */
export interface ProcDetail extends ProcEntry {
  exe?: string | null
  cmd?: string | null
  /** 启动时刻（epoch 秒） */
  startedAt?: number | null
  ports: PortEntry[]
}

export interface PortListResult {
  ok: boolean
  scope: string
  entries: PortEntry[]
  error?: string
  platform?: string
  scannedAt?: number
}

export interface ProcListResult {
  ok: boolean
  entries: ProcEntry[]
  totalMemory: number
  cores: number
  platform?: string
  scannedAt?: number
}

export interface ProcDetailResult {
  ok: boolean
  detail?: ProcDetail
  notFound?: boolean
}

/** 终止结果（`proc-kill`，见 Rust `model.rs::KillOutcome`） */
export interface KillOutcome {
  ok: boolean
  pid: number
  name: string
  force: boolean
  elevated: boolean
  /** 动作之后进程仍在运行 */
  alive: boolean
  notFound: boolean
  permissionDenied: boolean
  /** 需要用户手动执行时的等价命令 */
  manualCommand: string
  message: string
  error?: string | null
}

/** 终止确认弹窗的目标（来自端口表或进程表的一行） */
export interface KillTarget {
  pid: number
  name: string
  user?: string | null
  cpu?: number
  memory?: number | null
  risk: Risk
  selfRelated: boolean
  /** 它占用的端口（从端口表进来时至少有一个） */
  ports?: number[]
  cmd?: string | null
}
