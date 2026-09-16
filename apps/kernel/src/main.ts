import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerApi } from './api'
import { defaultBuiltinPluginsRoots, defaultDataRoot } from './config'
import { Kernel } from './kernel'

const VERSION = '0.1.0'

interface CliOptions {
  dataRoot: string
  /** 出厂插件根目录（可多个；开发态默认就是仓库根的 plugins/） */
  builtinRoots: string[]
  uiDistDir: string | null
  uiDevUrl?: string
  /** 不连壳（开发/测试：只有 HTTP 服务） */
  standalone: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!
    if (item.startsWith('--')) {
      const [key, inline] = item.slice(2).split('=')
      const next = argv[i + 1]
      if (inline !== undefined) args.set(key!, inline)
      else if (next && !next.startsWith('--')) {
        args.set(key!, next)
        i += 1
      } else flags.add(key!)
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  // 内核产物位于 <repo>/apps/kernel/dist/kernel.mjs（三级上即仓库根）
  const repoRoot = path.resolve(here, '..', '..', '..')
  const uiDist = path.resolve(args.get('ui-dist') ?? path.join(repoRoot, 'apps', 'launcher-ui', 'dist'))
  // `--builtin-plugins` 接受逗号分隔的多个目录（内置 + 预置）
  const builtinArg = args.get('builtin-plugins')
  const builtinRoots = builtinArg
    ? builtinArg
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(item))
    : defaultBuiltinPluginsRoots()
  return {
    dataRoot: path.resolve(args.get('data-root') ?? defaultDataRoot()),
    builtinRoots,
    // 一律绝对路径：静态服务的前缀比较依赖它
    uiDistDir: flags.has('no-ui') ? null : uiDist,
    ...(args.get('ui-dev') ? { uiDevUrl: args.get('ui-dev')! } : {}),
    standalone: flags.has('standalone'),
  }
}

async function main(): Promise<void> {
  // stdout 是壳的 JSON-RPC 通道：把 console 全部重定向到 stderr，避免污染协议
  const toStderr =
    (level: string) =>
    (...parts: unknown[]): void => {
      process.stderr.write(`[kernel:${level}] ${parts.map((p) => (typeof p === 'string' ? p : safe(p))).join(' ')}\n`)
    }
  console.log = toStderr('info')
  console.info = toStderr('info')
  console.warn = toStderr('warn')
  console.error = toStderr('error')
  console.debug = toStderr('debug')

  const opts = parseArgs(process.argv.slice(2))
  const kernel = new Kernel({
    dataRoot: opts.dataRoot,
    builtinRoots: opts.builtinRoots,
    uiDistDir: opts.uiDistDir,
    ...(opts.uiDevUrl ? { uiDevUrl: opts.uiDevUrl } : {}),
    version: VERSION,
  })

  registerApi(kernel)

  if (!opts.standalone) {
    kernel.link.start()
    kernel.link.markConnected()
    kernel.link.notify('kernel/booting', { pid: process.pid })
  }

  await kernel.start()
  kernel.markReady()

  if (!opts.standalone) {
    kernel.link.notify('kernel/ready', {
      version: VERSION,
      uiPort: kernel.uiServer.address,
      dataRoot: kernel.dataRoot,
    })
  } else {
    process.stderr.write(`[kernel:info] 独立模式：UI http://127.0.0.1:${kernel.uiServer.address}\n`)
  }

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[kernel:info] 收到 ${signal}，正在退出…\n`)
    // 兜底：任何一步挂住都必须退出，否则会变成僵尸/残留进程
    const force = setTimeout(() => {
      process.stderr.write('[kernel:warn] 优雅退出超时，强制结束\n')
      process.exit(0)
    }, 3000)
    force.unref?.()
    await kernel.stop().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // 壳异常退出（被强杀）时 stdin 管道会关闭：内核必须跟着退，否则变孤儿进程
  if (!opts.standalone) {
    const onPipeClosed = (): void => {
      process.stderr.write('[kernel:info] 壳连接已断开，内核退出\n')
      void shutdown('shell-disconnect')
    }
    process.stdin.on('end', onPipeClosed)
    process.stdin.on('close', onPipeClosed)
    process.stdin.resume()
  }
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[kernel:error] 未捕获异常：${err?.stack || String(err)}\n`)
  })
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[kernel:error] 未处理的 Promise 拒绝：${err instanceof Error ? err.stack : String(err)}\n`)
  })
}

function safe(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

void main()
