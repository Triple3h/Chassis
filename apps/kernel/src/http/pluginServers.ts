import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { resolveWithinRoot } from '../util/fsx'

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  // 'wasm-unsafe-eval'：放行随包 wasm 的编译（如 totp 的 zxing 二维码解码器）。
  // 它只允许 WebAssembly 编译，不放行 JS 的 eval / new Function。
  "script-src 'self' 'wasm-unsafe-eval'",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export interface PluginListener {
  pluginId: string
  port: number
  close: () => Promise<void>
}

/**
 * 每插件一个 HTTP listener（requirements §4.1 / §8.4）：
 * 端口不同 ⇒ origin 不同 ⇒ localStorage / IndexedDB 天然隔离。
 */
export class PluginServerPool {
  private listeners = new Map<string, PluginListener>()

  constructor(private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void) {}

  /** 起 listener；端口从 0 让系统分配（避免端口被占） */
  async start(pluginId: string, root: string): Promise<PluginListener> {
    const existing = this.listeners.get(pluginId)
    if (existing) return existing

    const server = http.createServer((req, res) => {
      void this.handle(req, res, root)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('插件 listener 端口分配失败')
    }
    const port = address.port
    const listener: PluginListener = {
      pluginId,
      port,
      close: async () => {
        this.listeners.delete(pluginId)
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
    this.listeners.set(pluginId, listener)
    return listener
  }

  async stop(pluginId: string): Promise<void> {
    const listener = this.listeners.get(pluginId)
    if (!listener) return
    this.listeners.delete(pluginId)
    await listener.close()
  }

  async stopAll(): Promise<void> {
    const all = [...this.listeners.values()]
    this.listeners.clear()
    await Promise.all(all.map((l) => l.close()))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
    const url = req.url || '/'
    const pathname = decodeURIComponent(url.split('?')[0] || '/')
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')

    const resolved = resolveWithinRoot(root, relative)
    if (!resolved) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('403 禁止访问')
      return
    }

    try {
      const stat = await fsp.stat(resolved)
      if (stat.isDirectory()) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('403 目录不可列')
        return
      }
      const ext = path.extname(resolved).toLowerCase()
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      })
      fs.createReadStream(resolved).pipe(res)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 未找到')
    }
  }
}

export { CSP }
