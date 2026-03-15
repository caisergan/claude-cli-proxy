import { randomUUID } from 'node:crypto'
import type { SessionManager } from '../session/SessionManager.js'
import type { SessionConfig } from '../session/Session.js'
import type {
  ClaudeEvent,
  PermissionRequestEvent,
  IPermissionEngine,
  IAuditLogger,
  AuditEntry,
} from '../types.js'

// ── Internal async event queue ─────────────────────────────────────────────
//
// Bridges an EventEmitter (the Session) to an AsyncIterableIterator.
// Events pushed into the queue are consumed by the async generator on demand.
// When `finish()` is called the generator terminates cleanly.

class EventQueue {
  private readonly buffer: ClaudeEvent[] = []
  private resolve: ((value: ClaudeEvent | null) => void) | null = null
  private done = false

  push(event: ClaudeEvent): void {
    if (this.done) return

    if (this.resolve) {
      // Generator is awaiting — deliver immediately
      const res = this.resolve
      this.resolve = null
      res(event)
    } else {
      this.buffer.push(event)
    }
  }

  finish(): void {
    this.done = true
    if (this.resolve) {
      const res = this.resolve
      this.resolve = null
      res(null)
    }
  }

  next(): Promise<ClaudeEvent | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!)
    }
    if (this.done) {
      return Promise.resolve(null)
    }
    return new Promise<ClaudeEvent | null>((res) => {
      this.resolve = res
    })
  }
}

// ── StreamRouter ───────────────────────────────────────────────────────────

export class StreamRouter {
  /** Sessions currently mid-turn (concurrency guard) */
  private readonly activeSessions = new Set<string>()

  constructor(
    private readonly sessions: SessionManager,
    private readonly permissions: IPermissionEngine,
    private readonly logger: IAuditLogger,
  ) {}

  async *sendMessage(
    sessionId: string,
    content: string,
    sessionConfig?: Partial<Omit<SessionConfig, 'sessionId'>>,
  ): AsyncIterableIterator<ClaudeEvent> {
    // ── Concurrency guard ────────────────────────────────────────────────
    if (this.activeSessions.has(sessionId)) {
      console.warn(
        `[StreamRouter] Warning: sendMessage called on session ${sessionId} ` +
        'which is already mid-turn. Events may interleave.',
      )
    }
    this.activeSessions.add(sessionId)

    const turnId = randomUUID()
    const turnStartMs = Date.now()

    const session = this.sessions.getOrCreate(sessionId, sessionConfig)

    const queue = new EventQueue()

    // ── Event listener attached for the duration of this turn ─────────────
    const allEventTypes = [
      'assistant',
      'tool_use',
      'tool_result',
      'permission_request',
      'result',
      'error',
      'session_closed',
    ] as const

    const onEvent = (event: ClaudeEvent) => queue.push(event)

    for (const eventType of allEventTypes) {
      session.on(eventType, onEvent)
    }

    const cleanup = () => {
      for (const eventType of allEventTypes) {
        session.removeListener(eventType, onEvent)
      }
      this.activeSessions.delete(sessionId)
    }

    // ── Log the outbound user message ─────────────────────────────────────
    this._log({
      ts: new Date().toISOString(),
      sessionId,
      direction: 'in',
      type: 'user',
      payload: { role: 'user', content },
      turnId,
    })

    // ── Send the message ──────────────────────────────────────────────────
    session.send({ role: 'user', content })

    // ── Yield loop ────────────────────────────────────────────────────────
    try {
      while (true) {
        const event = await queue.next()

        // Queue finished without a result (shouldn't happen normally)
        if (event === null) break

        // ── Audit log every inbound event ────────────────────────────────
        const auditEntry: AuditEntry = {
          ts: new Date().toISOString(),
          sessionId,
          direction: 'out',
          type: event.type,
          payload: event,
          turnId,
        }

        if (event.type === 'result') {
          auditEntry.durationMs = Date.now() - turnStartMs
        }

        this._log(auditEntry)

        // ── Handle permission requests ────────────────────────────────────
        if (event.type === 'permission_request') {
          const permEvent = event as unknown as PermissionRequestEvent
          const decision = await this.permissions.evaluate({
            id: permEvent.id,
            tool: permEvent.tool,
            input: permEvent.input,
            sessionId,
          })

          // Log the permission decision
          this._log({
            ts: new Date().toISOString(),
            sessionId,
            direction: 'in',
            type: 'permission_response',
            payload: { id: permEvent.id, approved: decision.approved, reason: decision.reason },
            turnId,
          })

          session.respondToPermission(permEvent.id, decision.approved)

          // Yield the permission_request event so caller can observe it
          yield event
          continue
        }

        // ── Yield the event to the caller ─────────────────────────────────
        yield event

        // ── Turn-ending events ─────────────────────────────────────────────
        if (event.type === 'result' || event.type === 'error') {
          break
        }

        // ── Session closed mid-turn ───────────────────────────────────────
        if (event.type === 'session_closed') {
          // Yield a synthetic error so the caller knows the turn was aborted
          const syntheticError: ClaudeEvent = {
            type: 'error',
            message: `Session ${sessionId} was closed before the turn completed`,
            sessionId,
          }
          this._log({
            ts: new Date().toISOString(),
            sessionId,
            direction: 'out',
            type: 'error',
            payload: syntheticError,
            turnId,
            durationMs: Date.now() - turnStartMs,
          })
          yield syntheticError
          break
        }
      }
    } finally {
      queue.finish()
      cleanup()
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _log(entry: AuditEntry): void {
    try {
      this.logger.log(entry)
    } catch {
      // Audit logger must never disrupt the stream
    }
  }
}
