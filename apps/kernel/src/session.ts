import { randomUUID } from 'node:crypto'
import type { Disposer, Session, SessionCloseReason } from './types'

/** 会话 = 一次 view 命令的打开实例（每次打开都是新会话，sid 区分） */
export class SessionManager {
  private sessions = new Map<string, Session>()
  private listeners = new Set<(session: Session, kind: 'open' | 'close', reason?: SessionCloseReason) => void>()

  create(input: { pluginId: string; command: string; port: number }): Session {
    const sid = randomUUID()
    const session: Session = {
      sid,
      pluginId: input.pluginId,
      command: input.command,
      token: randomUUID().replace(/-/g, ''),
      port: input.port,
      createdAt: Date.now(),
      lastSearchToken: 0,
    }
    this.sessions.set(sid, session)
    this.emit(session, 'open')
    return session
  }

  get(sid: string): Session | undefined {
    return this.sessions.get(sid)
  }

  byPlugin(pluginId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.pluginId === pluginId)
  }

  all(): Session[] {
    return [...this.sessions.values()]
  }

  /** reason 会随关闭事件广播给 UI：`reload` 表示插件正在重启，页面稍后会被重开 */
  close(sid: string, reason: SessionCloseReason = 'close'): boolean {
    const session = this.sessions.get(sid)
    if (!session) return false
    this.sessions.delete(sid)
    this.emit(session, 'close', reason)
    return true
  }

  closePlugin(pluginId: string, reason: SessionCloseReason = 'disable'): number {
    let count = 0
    for (const session of this.byPlugin(pluginId)) {
      if (this.close(session.sid, reason)) count += 1
    }
    return count
  }

  on(fn: (session: Session, kind: 'open' | 'close', reason?: SessionCloseReason) => void): Disposer {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(session: Session, kind: 'open' | 'close', reason?: SessionCloseReason): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(session, kind, reason)
      } catch {
        /* ignore */
      }
    }
  }
}
