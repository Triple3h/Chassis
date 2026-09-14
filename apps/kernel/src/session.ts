import { randomUUID } from 'node:crypto'
import type { Disposer, Session } from './types'

/** 会话 = 一次 view 命令的打开实例（每次打开都是新会话，sid 区分） */
export class SessionManager {
  private sessions = new Map<string, Session>()
  private listeners = new Set<(session: Session, kind: 'open' | 'close') => void>()

  create(input: { pluginId: string; command: string; port: number }): Session {
    const sid = randomUUID()
    const session: Session = {
      sid,
      pluginId: input.pluginId,
      command: input.command,
      token: randomUUID().replace(/-/g, ''),
      port: input.port,
      origin: `http://127.0.0.1:${input.port}`,
      createdAt: Date.now(),
      lastSearchToken: 0,
      searchContent: '',
      footer: null,
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

  close(sid: string): boolean {
    const session = this.sessions.get(sid)
    if (!session) return false
    this.sessions.delete(sid)
    this.emit(session, 'close')
    return true
  }

  closePlugin(pluginId: string): number {
    let count = 0
    for (const session of this.byPlugin(pluginId)) {
      if (this.close(session.sid)) count += 1
    }
    return count
  }

  closeAll(): void {
    for (const sid of [...this.sessions.keys()]) this.close(sid)
  }

  on(fn: (session: Session, kind: 'open' | 'close') => void): Disposer {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(session: Session, kind: 'open' | 'close'): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(session, kind)
      } catch {
        /* ignore */
      }
    }
  }
}
