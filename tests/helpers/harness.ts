/**
 * 测试装置 = **真内核二进制**（`target/debug/launcher-kernel`）+ 真协议。
 *
 * M5 之前这里是 `new Kernel(...)` 直接跑 TS 内核（进程内、白盒）。v1 内核退役后
 * （ADR-0005 / m5 计划 §A3.1），装置改为 **spawn 真二进制**：断言全部走对外路径 ——
 * HTTP `/api/*` + SSE `/api/events`（UI 那条），stdio NDJSON（壳那条）。
 *
 * 换来的东西：**测的就是发货的那颗内核**。代价是断言不能再伸进内核内部（
 * 原来是 `h.kernel.plugins.get(...)` 这种），要改走端点或落盘文件 —— 见下面
 * `plugins()` / `pluginAction()` / `config()` / `audit()` / `readData()` 这组辅助。
 *
 * 假壳（`fakeShell: true`）走**子进程 stdio**：不给 `--standalone`，内核就读 stdin、
 * 往 stdout 发 JSON-RPC —— 和真壳（`apps/shell/src/sidecar.rs`）完全同一条路。
 * 协议面：请求 = `{jsonrpc,id,method,params}`（壳要应答），通知 = `{jsonrpc,method,params}`。
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? path.resolve(process.cwd())

const KERNEL_BIN = path.join(repoRoot, 'target', 'debug', process.platform === 'win32' ? 'launcher-kernel.exe' : 'launcher-kernel')
/** 启动日志：`内核就绪：UI http://127.0.0.1:<port>，数据目录 …`（apps/kernel/src/kernel.rs） */
const READY_RE = /内核就绪：UI http:\/\/127\.0\.0\.1:(\d+)/
/** stdout 协议行的单条上限（防野 stdout 把内存吃光） */
const MAX_BUFFER = 256 * 1024

let kernelReady: Promise<void> | null = null

/**
 * 保证内核二进制是**当前源码**编出来的：构建一次（源码没动时是毫秒级 no-op）。
 * 装置是子进程形态，跑旧二进制 = 测了个寂寞，所以这里不做 "存在就跳过" 的优化。
 */
function ensureKernelBinary(): Promise<void> {
  kernelReady ??= (async () => {
    const result = spawnSync('cargo', ['build', '-p', 'launcher-kernel'], { cwd: repoRoot, stdio: 'inherit' })
    if (result.error) throw new Error(`无法执行 cargo（需要 Rust 工具链）：${result.error.message}`)
    if (result.status !== 0) throw new Error('构建 launcher-kernel 失败：cargo build -p launcher-kernel')
  })()
  return kernelReady
}

export interface HarnessOptions {
  /** 要装进 extensions/ 的 fixture 插件目录名（位于 tests/fixtures/） */
  fixtures?: string[]
  /** 出厂插件根目录（默认空目录；可传多个） */
  builtinRoots?: string[]
  label?: string
  /** 接一个假壳。默认关（standalone 形态：没有壳，只有 HTTP） */
  fakeShell?: boolean
  /**
   * 内核启动前落一些文件（fixture 已拷好、插件还没加载）。
   * 用于「插件安装目录里带旧数据」这类场景 —— 迁移必须在装配期发生。
   */
  seed?: (dataRoot: string) => Promise<void>
}

/**
 * 假壳：站在壳那一侧观察内核发了什么。
 *
 * 存在的理由：**只看内核源码看不出"壳已经做了一遍、内核又做一遍"这类 bug**，
 * 必须有个东西站在壳那一侧，观察内核越界发了什么。窗口显隐那条 bug 就是这么漏出去的。
 */
export interface FakeShell {
  /** 内核发给壳的请求方法名（按发出顺序）；**就绪之后**才开记（装配期的不混进断言） */
  sent: string[]
  /** 内核发给壳的请求（方法 + 参数），按发出顺序 —— 要断言"发出去的值对不对"时用它 */
  calls: Array<{ method: string; params: Record<string, unknown> }>
  /** 模拟壳发来一条通知（不是请求，不期望应答） */
  notify: (method: string, params?: Record<string, unknown>) => void
  /** 等内核发出某个请求；已发过则立刻返回 */
  waitFor: (method: string, timeoutMs?: number) => Promise<void>
  /** 真壳会在 `window.show` 里带回"上屏之前读到的前台选中文本"，这里模拟它 */
  showSelection: string | null
  /** 假壳对 `app.usage` 的回答（状态条要拼"启动台一共占多少"的壳那一半） */
  usage: { rss: number; cpuMs: number }
  /** 断开假壳（= 关掉内核的 stdin，内核会自己收尾退出） */
  close: () => void
}

/** `/api/plugins` 的一条（`PluginRuntimeInfo` 的字段子集） */
export interface PluginInfo {
  id: string
  title: string
  state: string
  builtin: boolean
  essential: boolean
  apiVersion: string
  capabilities: string[]
  [key: string]: unknown
}

export interface WindowSizes {
  host?: { width: number; height: number }
  plugin?: { width: number; height: number }
}

export interface KernelConfig {
  disabled: string[]
  hideOnBlur: boolean
  accent: string
  theme: string
  density: string
  historyLimit: number
  hotkey: { accelerator: string; [key: string]: unknown }
  windowSizes: WindowSizes
  [key: string]: unknown
}

export interface AuditRecord {
  pluginId: string
  method: string
  ok: boolean
  ts: string
  [key: string]: unknown
}

export interface SseEvent {
  event: string
  data: unknown
}

export interface Subscription {
  /** SSE 连接已建立；此后发生的广播才收得到（订阅前的事件不补发） */
  ready: Promise<void>
  stop: () => void
}

export type ApiResult<T = unknown> = { ok: boolean; result?: T; error?: { code: string; message: string } } & Record<string, unknown>

export interface Harness {
  dataRoot: string
  uiPort: number
  base: string
  /** 调内核 HTTP API（与 UI 同一条路） */
  api: <T = unknown>(pathname: string, init?: RequestInit) => Promise<T>
  /** 通过桥调用插件 API（与插件页同一条路） */
  bridge: (sid: string, token: string, method: string, params?: Record<string, unknown>) => Promise<ApiResult>
  /** 创建一个 view 会话并返回 sid / token */
  openSession: (pluginId: string, command: string, args?: unknown) => Promise<{ sid: string; token: string; url: string }>
  /** 调插件命令（UI 走的 `/api/invoke`）；返回内核那层的 `{ok, data|error}` */
  invoke: (id: string, args?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }>
  /** 订阅 SSE（UI 的事件流）—— 先 `await sub.ready` 再触发动作，否则会漏事件 */
  subscribe: (handler: (event: SseEvent) => void) => Subscription
  /** 插件列表（`/api/plugins`） */
  plugins: () => Promise<PluginInfo[]>
  /** 单个插件的信息（按 id 查） */
  plugin: (id: string) => Promise<PluginInfo | undefined>
  /** 插件动作（disable / enable / uninstall / setKeywords…）：失败以 `{ok:false,error}` 返回，不抛 */
  pluginAction: (action: string, payload?: Record<string, unknown>) => Promise<ApiResult>
  /** 当前配置（`/api/config`） */
  config: () => Promise<KernelConfig>
  /** 改配置（`/api/config` POST，收口在 `Kernel::patch_config`） */
  patchConfig: (patch: Record<string, unknown>) => Promise<ApiResult>
  /** 审计记录（`/api/audit`，最近在前） */
  audit: (limit?: number) => Promise<AuditRecord[]>
  /** 读数据目录下的文件并解析 JSON（`config.json` / `history.json` / `plugin-overrides.json`…） */
  readData: <T = unknown>(name: string) => Promise<T>
  /** 轮询等待条件成立（跨进程：事件、落盘、重载都是异步到达的） */
  waitFor: (predicate: () => boolean, timeoutMs?: number, label?: string) => Promise<void>
  /** 内核 stderr 日志（排错用） */
  logs: () => string
  /** 仅在 options.fakeShell 时存在 */
  shell?: FakeShell
  stop: () => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 假壳收发原文（LAUNCHER_TEST_DEBUG=1 时打开；排查「壳调用超时」用） */
const debugLink = (direction: '→' | '←', line: string): void => {
  if (process.env.LAUNCHER_TEST_DEBUG === '1') console.log(`[fake-shell ${direction}] ${line.trim()}`)
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  await ensureKernelBinary()

  const label = options.label ?? 'harness'
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `launcher-${label}-`))
  const builtinRoots = options.builtinRoots ?? [path.join(dataRoot, '__builtin-empty__')]
  for (const root of builtinRoots) await fsp.mkdir(root, { recursive: true })
  await fsp.mkdir(path.join(dataRoot, 'extensions'), { recursive: true })

  for (const fixture of options.fixtures ?? []) {
    const from = path.join(repoRoot, 'tests', 'fixtures', fixture)
    const to = path.join(dataRoot, 'extensions', fixture)
    await fsp.cp(from, to, { recursive: true, dereference: true })
  }

  await options.seed?.(dataRoot)

  // 假壳 ⇒ 不给 --standalone：内核接 stdin，走真壳那条 stdio JSON-RPC
  const args = ['--data-root', dataRoot, '--no-ui', '--builtin-plugins', builtinRoots.join(',')]
  if (!options.fakeShell) args.push('--standalone')

  const child: ChildProcess = spawn(KERNEL_BIN, args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdin = child.stdin!
  const stdout = child.stdout!
  const stderr = child.stderr!

  let logBuffer = ''
  const appendLog = (chunk: string): void => {
    logBuffer += chunk
    if (logBuffer.length > MAX_BUFFER) logBuffer = logBuffer.slice(-MAX_BUFFER / 2)
  }
  const tail = (): string => logBuffer.trim().split('\n').slice(-12).join('\n')

  let exitInfo: { code: number | null; signal: string | null } | null = null
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal }
  })

  // ── 壳那一侧：读 stdout 的 JSON-RPC、应答、必要时通知回去 ──────────────
  // **必须在等就绪之前挂上**：内核 `start()` 期间就会调壳（tray.setMenu / hotkey.register），
  // 晚挂 = 那些请求在 Node 的缓冲里躺着没人应答 —— 内核等满超时（日志里那条
  // 「全局热键注册失败：壳调用超时」，实测踩过）。
  const sent: string[] = []
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const usage = { rss: 96 * 1024 * 1024, cpuMs: 1234 }
  let showSelection: string | null = null
  let recordShell = false
  let stdoutBuffer = ''

  stdout.setEncoding('utf8')
  stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    if (stdoutBuffer.length > MAX_BUFFER && !stdoutBuffer.includes('\n')) stdoutBuffer = stdoutBuffer.slice(-MAX_BUFFER / 2)
    let index = stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index).trim()
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      index = stdoutBuffer.indexOf('\n')
      if (!line) continue
      let message: { id?: number; method?: string; params?: Record<string, unknown> }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        continue // 野 stdout：内核已把它当协议行处理失败，测试里直接忽略
      }
      if (!message.method) continue
      debugLink('←', line)
      if (recordShell) {
        sent.push(message.method)
        calls.push({ method: message.method, params: message.params ?? {} })
      }
      // 壳必须应答，否则内核要等满超时；返回值够测试用即可
      if (message.id !== undefined) {
        const result =
          message.method === 'window.isVisible'
            ? true
            : message.method === 'window.show'
              ? { selection: showSelection }
              : message.method === 'app.usage'
                ? { ok: true, rss: usage.rss, cpuMs: usage.cpuMs }
                // 剪贴板监听：假壳按「支持」应答（真壳在 Windows 上开线程监听，其余平台返回 unsupported）
                : message.method === 'clipboard.watch'
                  ? { ok: true }
                  // 截图原语（D18 下沉后由壳执行）：假壳按「成功触发」应答
                  : message.method === 'screenshot.start'
                    ? { ok: true }
                    // 应用（壳）自更新：`app.info` 报壳自己的版本 / 安装位置 / 能否自更新
                    : message.method === 'app.info'
                      ? {
                          version: '0.1.0',
                          shellVersion: '0.1.0',
                          shellHotVersion: '0.1.0',
                          platform: 'macos',
                          arch: 'arm64',
                          dataRoot: '/tmp/fake-shell-data',
                          bundlePath: '/Applications/Chassis.app',
                          canSelfUpdate: true,
                        }
                      // 交壳替换并重启整个应用：假壳按「已接受」应答（真壳在回执后 400ms 退出）
                      : message.method === 'shell.applyUpdate'
                        ? { ok: true, restarting: true, from: '0.1.0', to: '0.1.1' }
                        : null
        const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
        debugLink('→', reply)
        stdin.write(`${reply}\n`)
      }
    }
  })

  const uiPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`内核启动超时（15s）\n--- 内核日志 ---\n${tail()}`))
    }, 15_000)
    const onExit = (): void => {
      clearTimeout(timer)
      reject(new Error(`内核在就绪前退出（${JSON.stringify(exitInfo)}）\n--- 内核日志 ---\n${tail()}`))
    }
    child.once('exit', onExit)
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      appendLog(chunk)
      const match = READY_RE.exec(logBuffer)
      if (!match) return
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(Number(match[1]))
    })
  })

  const base = `http://127.0.0.1:${uiPort}`

  const shell: FakeShell | undefined = options.fakeShell
    ? {
        sent,
        calls,
        usage,
        get showSelection() {
          return showSelection
        },
        set showSelection(value: string | null) {
          showSelection = value
        },
        notify: (method, params) => {
          stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`)
        },
        waitFor: async (method, timeoutMs = 2000) => {
          const started = Date.now()
          while (!sent.includes(method)) {
            if (Date.now() - started > timeoutMs) {
              throw new Error(`等待内核发出 ${method} 超时（实际发出：${sent.join(', ') || '无'}）`)
            }
            await sleep(20)
          }
        },
        close: () => {
          stdin.end()
        },
      }
    : undefined
  // 装配期的壳调用不该混进断言：就绪之后才开记
  recordShell = true

  const api = async <T = unknown>(pathname: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    return (await res.json()) as T
  }

  const bridge = async (sid: string, token: string, method: string, params?: Record<string, unknown>): Promise<ApiResult> => {
    return api<ApiResult>('/api/bridge', {
      method: 'POST',
      body: JSON.stringify({ sid, token, id: 1, method, params }),
    })
  }

  const openSession = async (pluginId: string, command: string, args?: unknown) => {
    const res = await api<{ ok: boolean; result?: { ok: boolean; data?: { sid: string; url: string }; error?: unknown } }>(
      '/api/invoke',
      { method: 'POST', body: JSON.stringify({ id: `${pluginId}:${command}`, args }) },
    )
    const data = res.result?.data
    if (!data?.sid) throw new Error(`无法创建会话：${JSON.stringify(res)}`)
    const token = new URL(data.url).searchParams.get('token') ?? ''
    return { sid: data.sid, token, url: data.url }
  }

  const invoke = async (
    id: string,
    args?: unknown,
  ): Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }> => {
    const res = await api<{ ok: boolean; result?: { ok: boolean; data?: unknown; error?: { code?: string; message?: string } } }>(
      '/api/invoke',
      { method: 'POST', body: JSON.stringify({ id, args }) },
    )
    return res.result ?? { ok: false, error: { code: 'INVOKE_FAILED', message: JSON.stringify(res) } }
  }

  const subscribe = (handler: (event: SseEvent) => void): Subscription => {
    const controller = new AbortController()
    let markReady: () => void = () => undefined
    let markFailed: (err: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      markFailed = reject
    })
    void (async () => {
      const res = await fetch(`${base}/api/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      })
      if (!res.body) throw new Error('SSE 响应没有 body')
      markReady()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          index = buffer.indexOf('\n\n')
          let name = 'message'
          const dataLines: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          }
          if (dataLines.length === 0) continue
          try {
            handler({ event: name, data: JSON.parse(dataLines.join('\n')) })
          } catch {
            // 非 JSON 的 data 忽略（当前内核不发）
          }
        }
      }
    })().catch((err: unknown) => {
      markFailed(err instanceof Error ? err : new Error(String(err)))
    })
    return { ready, stop: () => controller.abort() }
  }

  const plugins = async (): Promise<PluginInfo[]> => {
    const res = await api<{ ok: boolean; plugins: PluginInfo[] }>('/api/plugins')
    return res.plugins ?? []
  }

  const stop = async (): Promise<void> => {
    if (!exitInfo) {
      if (options.fakeShell) stdin.end() // 壳断了 ⇒ 内核自己收尾退出
      else child.kill('SIGTERM')
      const started = Date.now()
      while (!exitInfo && Date.now() - started < 6000) await sleep(30)
      if (!exitInfo) child.kill('SIGKILL')
    }
    await fsp.rm(dataRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  return {
    dataRoot,
    uiPort,
    base,
    api,
    bridge,
    openSession,
    invoke,
    subscribe,
    plugins,
    plugin: async (id) => (await plugins()).find((entry) => entry.id === id),
    pluginAction: (action, payload = {}) =>
      api<ApiResult>('/api/plugins/action', { method: 'POST', body: JSON.stringify({ action, ...payload }) }),
    config: async () => {
      const res = await api<{ ok: boolean; config: KernelConfig }>('/api/config')
      return res.config
    },
    patchConfig: (patch) => api<ApiResult>('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
    audit: async (limit = 200) => {
      const res = await api<{ ok: boolean; records: AuditRecord[] }>(`/api/audit?limit=${limit}`)
      return res.records ?? []
    },
    readData: async <T = unknown>(name: string): Promise<T> => {
      const text = await fsp.readFile(path.join(dataRoot, name), 'utf-8')
      return JSON.parse(text) as T
    },
    waitFor: async (predicate, timeoutMs = 3000) => {
      const started = Date.now()
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error(`等待条件成立超时（${timeoutMs}ms）`)
        await sleep(20)
      }
    },
    logs: () => logBuffer,
    ...(shell ? { shell } : {}),
    stop,
  }
}
