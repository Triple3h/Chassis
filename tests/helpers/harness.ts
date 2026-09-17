import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { registerApi } from '../../apps/kernel/src/api'
import { Kernel } from '../../apps/kernel/src/kernel'

// 测试代码会被 esbuild 打包到 .dev/ 下运行，所以优先用运行器注入的仓库根
const repoRoot = process.env.LAUNCHER_REPO_ROOT ?? path.resolve(process.cwd())

export interface HarnessOptions {
  /** 要装进 extensions/ 的 fixture 插件目录名（位于 tests/fixtures/） */
  fixtures?: string[]
  /** 出厂插件根目录（默认空目录；可传多个） */
  builtinRoots?: string[]
  label?: string
  /** 接一个假壳（见 FakeShell）。默认关，因为接上后内核会认为壳已连接 */
  fakeShell?: boolean
  /**
   * 内核启动前落一些文件（fixture 已拷好、插件还没加载）。
   * 用于「插件安装目录里带旧数据」这类场景 —— 迁移必须在装配期发生。
   */
  seed?: (dataRoot: string) => Promise<void>
}

/**
 * 假壳：内核 ↔ 壳是 newline-delimited JSON-RPC，所以接一对内存流就能在测试里扮演壳。
 *
 * 存在的理由：**只看内核源码看不出"壳已经做了一遍、内核又做一遍"这类 bug**，
 * 必须有个东西站在壳那一侧，观察内核越界发了什么。窗口显隐那条 bug 就是这么漏出去的。
 */
export interface FakeShell {
  /** 内核发给壳的请求方法名（按发出顺序） */
  sent: string[]
  /** 模拟壳发来一条通知（不是请求，不期望应答） */
  notify: (method: string, params?: Record<string, unknown>) => void
  /** 等内核发出某个请求；已发过则立刻返回 */
  waitFor: (method: string, timeoutMs?: number) => Promise<void>
  /** 断开假壳（harness 收尾用） */
  close: () => void
}

export interface Harness {
  kernel: Kernel
  dataRoot: string
  uiPort: number
  base: string
  /** 调内核 HTTP API */
  api: <T = unknown>(pathname: string, init?: RequestInit) => Promise<T>
  /** 通过桥调用插件 API（模拟启动台 UI 的转发） */
  bridge: (
    sid: string,
    token: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>
  /** 创建一个 view 会话并返回 sid / token */
  openSession: (pluginId: string, command: string, args?: unknown) => Promise<{ sid: string; token: string; url: string }>
  /** 仅在 options.fakeShell 时存在 */
  shell?: FakeShell
  stop: () => Promise<void>
}

function attachFakeShell(kernel: Kernel): FakeShell {
  const toKernel = new PassThrough()
  const fromKernel = new PassThrough()
  const sent: string[] = []
  const waiters: Array<{ method: string; resolve: () => void }> = []
  let buffer = ''

  const settle = (method: string): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (!waiter || waiter.method !== method) continue
      waiter.resolve()
      waiters.splice(index, 1)
    }
  }

  fromKernel.setEncoding('utf8')
  fromKernel.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line) continue
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (!message.method) continue
      sent.push(message.method)
      // 假壳必须应答，否则内核要等满 3s 超时；返回值够测试用即可
      if (message.id !== undefined) {
        const result = message.method === 'window.isVisible' ? true : null
        toKernel.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
      }
      settle(message.method)
    }
  })

  kernel.link.start({ input: toKernel, output: fromKernel })
  kernel.link.markConnected()

  return {
    sent,
    notify: (method, params) => {
      toKernel.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`)
    },
    waitFor: (method, timeoutMs = 2000) =>
      new Promise<void>((resolve, reject) => {
        if (sent.includes(method)) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          reject(new Error(`等待内核发出 ${method} 超时（实际发出：${sent.join(', ') || '无'}）`))
        }, timeoutMs)
        waiters.push({
          method,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      }),
    close: () => {
      toKernel.end()
      fromKernel.end()
    },
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
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

  const kernel = new Kernel({
    dataRoot,
    builtinRoots,
    uiDistDir: null,
    version: 'test',
  })
  registerApi(kernel)
  await kernel.start()

  // 刻意在 start() 之后接假壳：插件装配期的调用不该混进断言里
  const shell = options.fakeShell ? attachFakeShell(kernel) : undefined

  const base = `http://127.0.0.1:${kernel.uiServer.address}`

  const api = async <T>(pathname: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    return (await res.json()) as T
  }

  const bridge = async (sid: string, token: string, method: string, params?: Record<string, unknown>) => {
    return api<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>('/api/bridge', {
      method: 'POST',
      body: JSON.stringify({ sid, token, id: 1, method, params }),
    })
  }

  const openSession = async (pluginId: string, command: string, args?: unknown) => {
    const res = await api<{ ok: boolean; result: { ok: boolean; data?: { sid: string; url: string }; error?: unknown } }>(
      '/api/invoke',
      { method: 'POST', body: JSON.stringify({ id: `${pluginId}:${command}`, args }) },
    )
    const data = res.result?.data as { sid: string; url: string } | undefined
    if (!data?.sid) throw new Error(`无法创建会话：${JSON.stringify(res)}`)
    const token = new URL(data.url).searchParams.get('token') ?? ''
    return { sid: data.sid, token, url: data.url }
  }

  return {
    kernel,
    dataRoot,
    uiPort: kernel.uiServer.address,
    base,
    api,
    bridge,
    openSession,
    ...(shell ? { shell } : {}),
    stop: async () => {
      shell?.close()
      await kernel.stop()
      await fsp.rm(dataRoot, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export { repoRoot }
