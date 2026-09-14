import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { URL } from 'node:url'
import { toErrorShape } from '@launcher/plugin-manifest'
import { resolveWithinRoot } from '../util/fsx'

export interface HttpRequestContext {
  method: string
  pathname: string
  query: URLSearchParams
  body: unknown
  req: http.IncomingMessage
  res: http.ServerResponse
}

export type RouteHandler = (ctx: HttpRequestContext) => Promise<unknown> | unknown

export interface UiServerOptions {
  /** 启动台 UI 静态资源目录（生产构建产物）；不存在时只提供 API */
  uiDistDir: string | null
  /** 开发模式：UI 由 vite dev server 提供，内核把请求 302 过去 */
  uiDevUrl?: string
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 允许跨域的来源（vite dev server 直连内核 API 时用） */
  allowedOrigins: string[]
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

interface SseClient {
  res: http.ServerResponse
}

/**
 * 启动台 UI 的宿主服务（ADR-0001：内核托管 UI 静态资源，UI 走 HTTP + SSE 与内核通信）。
 */
export class UiServer {
  private routes = new Map<string, RouteHandler>()
  private server: http.Server | null = null
  private sseClients = new Set<SseClient>()
  private port = 0

  constructor(private readonly opts: UiServerOptions) {}

  get address(): number {
    return this.port
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  route(method: string, pathname: string, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${pathname}`, handler)
  }

  get(pathname: string, handler: RouteHandler): void {
    this.route('GET', pathname, handler)
  }

  post(pathname: string, handler: RouteHandler): void {
    this.route('POST', pathname, handler)
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('UI 服务端口分配失败')
    this.port = address.port
    this.server = server
    return this.port
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.res.end()
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /** 事件推送（SSE）：UI 与插件页的事件都从这里扇出 */
  broadcast(event: string, payload: unknown): void {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`
    for (const client of [...this.sseClients]) {
      try {
        client.res.write(data)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/'
    const parsed = new URL(url, `http://127.0.0.1:${this.port || 1}`)
    const pathname = parsed.pathname

    this.applyCors(req, res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // SSE
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      const client: SseClient = { res }
      this.sseClients.add(client)
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(keepAlive)
        }
      }, 20_000)
      keepAlive.unref?.()
      req.on('close', () => {
        clearInterval(keepAlive)
        this.sseClients.delete(client)
      })
      return
    }

    const handler = this.routes.get(`${req.method?.toUpperCase()} ${pathname}`)
    if (handler) {
      try {
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined
        const result = await handler({
          method: req.method ?? 'GET',
          pathname,
          query: parsed.searchParams,
          body,
          req,
          res,
        })
        if (res.writableEnded) return
        sendJson(res, 200, result ?? { ok: true })
      } catch (err) {
        const error = toErrorShape(err)
        sendJson(res, error.code === 'BAD_ARGS' ? 400 : 500, { ok: false, error })
      }
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知接口：${pathname}` } })
      return
    }

    await this.serveStatic(pathname, res)
  }

  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin
    if (!origin) return
    const allowed = this.opts.allowedOrigins.includes(origin) || origin === this.origin
    if (!allowed) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Vary', 'Origin')
  }

  private async serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    if (this.opts.uiDevUrl) {
      res.writeHead(302, { Location: new URL(pathname === '/' ? '/' : pathname, this.opts.uiDevUrl).href })
      res.end()
      return
    }
    const root = this.opts.uiDistDir
    if (!root) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('启动台 UI 尚未构建：请先执行 npm run build:ui')
      return
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const resolved = resolveWithinRoot(root, relative)
    if (!resolved) {
      res.writeHead(403)
      res.end('403')
      return
    }
    try {
      const stat = await fsp.stat(resolved)
      if (stat.isDirectory()) {
        res.writeHead(403)
        res.end('403')
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-cache',
      })
      fs.createReadStream(resolved).pipe(res)
    } catch {
      // SPA 兜底：未知路径回 index.html
      const indexFile = path.join(root, 'index.html')
      try {
        const html = await fsp.readFile(indexFile)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(html.byteLength) })
        res.end(html)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404')
      }
    }
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  const MAX = 8 * 1024 * 1024
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}
