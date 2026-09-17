import os from 'node:os'

/**
 * 状态条数据（requirements §3.1「状态显示」/ architecture D21）。
 *
 * 主角是**启动台自身**的占用（用户要看的是"这个东西轻不轻"）：
 *  - 内存 = 壳进程 + 内核进程的常驻内存之和；
 *  - CPU = 两个进程的累计 CPU 时间差分 ÷ 墙钟 ÷ 核心数（**占整机的百分比**）。
 *
 * 内核只能报自己那一半，壳那一半走原语 `app.usage`（`primitives/usage.rs`）。
 * 整机数字（`node:os`：总 CPU / 内存 / 负载）只作 tooltip 里的对照 —— 判断"轻不轻"
 * 需要有参照物，但那不是状态条要回答的问题。
 *
 * 采样是**惰性**的：只在有人来读（UI 每 3s 拉一次）时才算，没有常驻定时器。
 * 壳读不到（standalone / `pnpm dev`）时退化成"只报内核"，CPU 记 `null` 让 UI 显示占位符 ——
 * 绝不拿一半的差值冒充整体（那会让数字每次都在两个量级之间跳）。
 */
export interface AppUsage {
  /** 壳 + 内核的常驻内存之和（bytes） */
  rss: number
  rssShell: number
  rssKernel: number
  /** 占整机 CPU 的百分比（0–100，一位小数）；还没有差分基线时为 null */
  cpu: number | null
  /** 本机逻辑核心数（CPU 百分比按它归一） */
  cores: number
}

export interface SystemStats {
  /** 启动台自身占用（状态条主角） */
  app: AppUsage
  /** 整机 CPU 使用率（0–100，对照用） */
  cpu: number
  /** 整机已用 / 总内存（bytes，对照用） */
  memUsed: number
  memTotal: number
  /** 1 / 5 / 15 分钟平均负载 */
  loadAvg: number[]
  /** 采样时刻（epoch ms） */
  sampledAt: number
}

export interface SystemStatsDeps {
  /**
   * 取壳进程的自身占用。壳不可用 / 超时 / 老版本壳不认这个原语时返回 null。
   * 用函数注入是刻意的：采样本体不碰 JSON-RPC，测试里直接给个假实现就能跑。
   */
  shellUsage: () => Promise<{ rss: number; cpuMs: number } | null>
}

interface CpuSample {
  idle: number
  total: number
}

interface AppCpuSample {
  at: number
  /** 壳 + 内核的累计 CPU 时间（ms） */
  cpuMs: number
  /**
   * 这次采样是否**包含壳**那一半。
   *
   * 含壳与不含壳的累计值不能相减 —— 壳进程的累计 CPU 是"开机以来"的量级，
   * 拿它去减一个只有内核的基线，会把这几十秒全算进采样窗口（实测读数 312%）。
   */
  hasShell: boolean
}

/** 就地补采样的等待时长：够短（不拖慢这次请求）、够长（差分不失真） */
const SAMPLE_GAP_MS = 150
/** 整机 CPU 的上次采样超过这个时长就算"陈旧"，必须重新起一个短窗口 */
const STALE_MS = 10_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const round1 = (value: number): number => Math.round(value * 10) / 10

function readCpu(): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    // `nice` / `irq` 在个别平台缺失：一律按"累计时间"求和，别假设字段齐全
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

export class SystemStatsSampler {
  private last: CpuSample | null = null
  private lastAt = 0
  private lastApp: AppCpuSample | null = null
  /** 同一时刻只跑一次采样（UI 轮询与其它调用可能撞上） */
  private inflight: Promise<SystemStats> | null = null

  constructor(private readonly deps: SystemStatsDeps = { shellUsage: async () => null }) {}

  /**
   * 内核启动时预热一次：整机 CPU 立刻有基线；自身的基线只有内核这一半
   * （`shellUsage` 是异步的，这里不为了预热去等 IPC）——
   * 所以首次 `read()` 只建立含壳的基线、不给 CPU 数字，第二次起才有值。
   */
  warmup(): void {
    this.last = readCpu()
    this.lastAt = Date.now()
    this.lastApp = { at: Date.now(), cpuMs: kernelCpuMs(), hasShell: false }
  }

  async read(): Promise<SystemStats> {
    if (this.inflight) return this.inflight
    this.inflight = this.sample().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async sample(): Promise<SystemStats> {
    // 壳的占用与整机采样并发做：两件事互不依赖，别让 800ms 的 IPC 超时叠在采样窗口上
    const [app, whole] = await Promise.all([this.readApp(), this.readWholeMachine()])
    return { app, ...whole, sampledAt: Date.now() }
  }

  private async readApp(): Promise<AppUsage> {
    const cores = os.cpus().length || 1
    const rssKernel = process.memoryUsage.rss()
    const shell = await this.deps.shellUsage().catch(() => null)
    const rssShell = shell?.rss ?? 0
    const cpuMs = kernelCpuMs() + (shell?.cpuMs ?? 0)
    const now = Date.now()

    // 差分要"两次都含壳"才作数（见 `AppCpuSample.hasShell`）：壳从无到有会让累计值跳一大截
    const prev = this.lastApp
    let cpu: number | null = null
    if (prev && prev.hasShell && shell && now > prev.at) {
      const delta = cpuMs - prev.cpuMs
      if (delta >= 0) cpu = round1((delta / (now - prev.at) / cores) * 100)
    }
    this.lastApp = { at: now, cpuMs, hasShell: Boolean(shell) }

    return { rss: rssShell + rssKernel, rssShell, rssKernel, cpu, cores }
  }

  private async readWholeMachine(): Promise<{
    cpu: number
    memUsed: number
    memTotal: number
    loadAvg: number[]
  }> {
    const now = readCpu()
    let base = this.last
    if (!base || Date.now() - this.lastAt > STALE_MS) {
      base = now
      await delay(SAMPLE_GAP_MS)
    }
    const fresh = readCpu()
    this.last = fresh
    this.lastAt = Date.now()

    const idleDelta = fresh.idle - base.idle
    const totalDelta = fresh.total - base.total
    const cpu = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0

    const memTotal = os.totalmem()
    // macOS 的 `freemem` 只算"完全空闲"的页（不含可回收的文件缓存），
    // 所以这里的"已用"比活动监视器的"内存压力"读数偏保守 —— tooltip 里写清口径即可
    const memUsed = Math.max(0, memTotal - os.freemem())

    return {
      cpu: Math.min(100, Math.max(0, cpu)),
      memUsed,
      memTotal,
      loadAvg: os.loadavg(),
    }
  }
}

/** 内核进程自己的累计 CPU 时间（user + system，ms） */
function kernelCpuMs(): number {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}
