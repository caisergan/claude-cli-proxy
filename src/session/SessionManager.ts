import { randomUUID } from 'node:crypto'
import { Session, type SessionConfig } from './Session.js'

export interface SessionManagerConfig {
  maxSessions?: number       // default: 0 (unlimited)
  idleTimeoutMs?: number     // default: 30 minutes; 0 = disabled
  defaultModel?: string
  defaultMcpServerUrl?: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000        // check every 60 seconds

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly config: Required<SessionManagerConfig>
  private idleTimer?: ReturnType<typeof setInterval>

  constructor(config: SessionManagerConfig = {}) {
    this.config = {
      maxSessions: config.maxSessions ?? 0,
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      defaultModel: config.defaultModel ?? 'claude-3-7-sonnet-20250219',
      defaultMcpServerUrl: config.defaultMcpServerUrl ?? '',
    }

    if (this.config.idleTimeoutMs > 0) {
      this._startIdleTimer()
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  create(config?: Partial<Omit<SessionConfig, 'sessionId'>>): Session {
    const maxSessions = this.config.maxSessions

    if (maxSessions > 0 && this.sessions.size >= maxSessions) {
      throw new Error(
        `Session limit reached (max: ${maxSessions}). Destroy an existing session first.`,
      )
    }

    const sessionId = randomUUID()
    const session = new Session({
      sessionId,
      model: config?.model ?? this.config.defaultModel,
      mcpServerUrl:
        config?.mcpServerUrl ??
        (this.config.defaultMcpServerUrl || undefined),
      extraFlags: config?.extraFlags,
    })

    this.sessions.set(sessionId, session)

    // Auto-remove from map when the session closes
    session.once('session_closed', () => {
      this.sessions.delete(sessionId)
    })

    return session
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getOrCreate(
    sessionId: string,
    config?: Partial<Omit<SessionConfig, 'sessionId'>>,
  ): Session {
    const existing = this.sessions.get(sessionId)
    if (existing?.isAlive) return existing

    // If the session exists but is dead, remove it first
    if (existing) {
      this.sessions.delete(sessionId)
    }

    const session = new Session({
      sessionId,
      model: config?.model ?? this.config.defaultModel,
      mcpServerUrl:
        config?.mcpServerUrl ??
        (this.config.defaultMcpServerUrl || undefined),
      extraFlags: config?.extraFlags,
    })

    this.sessions.set(sessionId, session)

    session.once('session_closed', () => {
      this.sessions.delete(sessionId)
    })

    return session
  }

  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.sessions.delete(sessionId)
    await session.destroy()
  }

  async destroyAll(): Promise<void> {
    const destroyPromises = [...this.sessions.values()].map((s) => s.destroy())
    this.sessions.clear()

    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = undefined
    }

    await Promise.all(destroyPromises)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  // ── Idle timeout ──────────────────────────────────────────────────────────

  private _startIdleTimer(): void {
    this.idleTimer = setInterval(() => {
      this._reapIdleSessions()
    }, IDLE_CHECK_INTERVAL_MS)

    // Don't keep the Node.js process alive just for this timer
    this.idleTimer.unref?.()
  }

  private _reapIdleSessions(): void {
    const now = Date.now()
    const idleTimeoutMs = this.config.idleTimeoutMs

    for (const [id, session] of this.sessions) {
      const idleMs = now - session.lastActivityAt.getTime()
      if (idleMs > idleTimeoutMs) {
        console.info(
          `[SessionManager] Destroying idle session ${id} ` +
          `(idle for ${Math.round(idleMs / 1000)}s, reason: idle_timeout)`,
        )
        this.sessions.delete(id)
        session.destroy().catch((err) => {
          console.error(`[SessionManager] Error destroying session ${id}:`, err)
        })
      }
    }
  }
}
