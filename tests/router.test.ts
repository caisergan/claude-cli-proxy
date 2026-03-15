import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { StreamRouter } from '../src/router/StreamRouter.js'
import type {
  ClaudeEvent,
  IPermissionEngine,
  IAuditLogger,
  AuditEntry,
  PermissionRequest,
  PermissionDecision,
} from '../src/types.js'

// ── Mock SessionManager & Session ─────────────────────────────────────────

function makeMockSession(id: string) {
  const emitter = new EventEmitter()
  return {
    sessionId: id,
    isAlive: true,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    send: vi.fn(),
    respondToPermission: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    // helper to push events from test code
    _emit: (event: ClaudeEvent) => emitter.emit(event.type, event),
  }
}

type MockSession = ReturnType<typeof makeMockSession>

function makeMockSessionManager(session: MockSession) {
  return {
    getOrCreate: vi.fn().mockReturnValue(session),
    create: vi.fn(),
    get: vi.fn(),
    destroy: vi.fn(),
    destroyAll: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  }
}

// ── Mock PermissionEngine & AuditLogger ───────────────────────────────────

function makePermissions(approved = true): IPermissionEngine & { evaluate: ReturnType<typeof vi.fn> } {
  return {
    evaluate: vi.fn().mockResolvedValue({ approved, reason: 'test' } satisfies PermissionDecision),
  }
}

function makeLogger(): IAuditLogger & { log: ReturnType<typeof vi.fn>; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return {
    entries,
    log: vi.fn((entry: AuditEntry) => entries.push(entry)),
  }
}

// ── Helper: collect all events from the router ────────────────────────────

async function collectEvents(
  router: StreamRouter,
  sessionId: string,
  content: string,
): Promise<ClaudeEvent[]> {
  const events: ClaudeEvent[] = []
  for await (const event of router.sendMessage(sessionId, content)) {
    events.push(event)
  }
  return events
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('StreamRouter', () => {
  let session: MockSession
  let manager: ReturnType<typeof makeMockSessionManager>
  let permissions: ReturnType<typeof makePermissions>
  let logger: ReturnType<typeof makeLogger>
  let router: StreamRouter

  beforeEach(() => {
    session = makeMockSession('session-1')
    manager = makeMockSessionManager(session)
    permissions = makePermissions(true)
    logger = makeLogger()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router = new StreamRouter(manager as any, permissions, logger)
  })

  // ── Basic event forwarding ────────────────────────────────────────────

  it('yields assistant events from session', async () => {
    const assistantEvent: ClaudeEvent = {
      type: 'assistant',
      message: { role: 'assistant', content: 'Hello!' },
      partial: false,
    }
    const resultEvent: ClaudeEvent = { type: 'result', subtype: 'success', cost_usd: 0.001 }

    // Push events after a tick so the generator has time to subscribe
    setImmediate(() => {
      session._emit(assistantEvent)
      session._emit(resultEvent)
    })

    const events = await collectEvents(router, 'session-1', 'Hi')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'assistant' })
    expect(events[1]).toMatchObject({ type: 'result' })
  })

  it('terminates on result event', async () => {
    const resultEvent: ClaudeEvent = { type: 'result', subtype: 'success' }

    setImmediate(() => {
      session._emit(resultEvent)
      // Push more events AFTER result — they should NOT be yielded
      session._emit({ type: 'assistant', partial: false } as ClaudeEvent)
    })

    const events = await collectEvents(router, 'session-1', 'Hi')
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('result')
  })

  it('terminates on error event', async () => {
    setImmediate(() => {
      session._emit({ type: 'error', message: 'Something went wrong' })
    })

    const events = await collectEvents(router, 'session-1', 'Hi')
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
  })

  // ── Permission handling ───────────────────────────────────────────────

  it('evaluates a permission_request and responds to the session', async () => {
    const permEvent: ClaudeEvent = {
      type: 'permission_request',
      id: 'perm-001',
      tool: 'bash',
      input: { command: 'ls' },
    }

    setImmediate(() => {
      session._emit(permEvent)
      session._emit({ type: 'result', subtype: 'success' })
    })

    const events = await collectEvents(router, 'session-1', 'run ls')

    expect(permissions.evaluate).toHaveBeenCalledWith({
      id: 'perm-001',
      tool: 'bash',
      input: { command: 'ls' },
      sessionId: 'session-1',
    } satisfies PermissionRequest)

    expect(session.respondToPermission).toHaveBeenCalledWith('perm-001', true)
    // permission_request event is still yielded
    expect(events.find((e) => e.type === 'permission_request')).toBeDefined()
  })

  it('sends respondToPermission(false) when permission is denied', async () => {
    const deniedRouter = new StreamRouter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager as any,
      makePermissions(false),
      logger,
    )

    setImmediate(() => {
      session._emit({ type: 'permission_request', id: 'perm-002', tool: 'write_file', input: {} })
      session._emit({ type: 'result', subtype: 'success' })
    })

    await collectEvents(deniedRouter, 'session-1', 'write something')
    expect(session.respondToPermission).toHaveBeenCalledWith('perm-002', false)
  })

  // ── Session closed mid-turn ───────────────────────────────────────────

  it('yields a synthetic error when session closes mid-turn', async () => {
    setImmediate(() => {
      session._emit({ type: 'session_closed', sessionId: 'session-1' })
    })

    const events = await collectEvents(router, 'session-1', 'Hi')
    // session_closed plus the synthetic error
    const synth = events.find((e) => e.type === 'error')
    expect(synth).toBeDefined()
    expect((synth as Record<string, unknown>).message).toMatch(/closed before/)
  })

  // ── Concurrency guard ─────────────────────────────────────────────────

  it('logs a warning when two sendMessage calls overlap on the same session', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // First turn: will hang until we emit result
    let resolveFirst!: () => void
    const firstDone = new Promise<void>((res) => { resolveFirst = res })

    const firstIter = router.sendMessage('session-1', 'first message')

    // Start iteration in background
    void (async () => {
      for await (const event of firstIter) {
        if (event.type === 'result') break
      }
      resolveFirst()
    })()

    // Give the first sendMessage time to register itself as active
    await new Promise((res) => setImmediate(res))

    // Second call on same session — should trigger warning
    const secondIter = router.sendMessage('session-1', 'second message')
    // Pull one item to actually execute the generator preamble
    const secondIterPromise = secondIter.next()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already mid-turn'))

    // Clean up: emit result for both
    session._emit({ type: 'result', subtype: 'success' })
    await secondIterPromise
    session._emit({ type: 'result', subtype: 'success' })
    await firstDone

    warnSpy.mockRestore()
  })

  // ── Audit logging ─────────────────────────────────────────────────────

  it('logs the outbound user message with direction "in"', async () => {
    setImmediate(() => session._emit({ type: 'result', subtype: 'success' }))

    await collectEvents(router, 'session-1', 'Hello')

    const inEntry = logger.entries.find((e) => e.direction === 'in' && e.type === 'user')
    expect(inEntry).toBeDefined()
    expect(inEntry!.sessionId).toBe('session-1')
  })

  it('logs every received event with direction "out"', async () => {
    setImmediate(() => {
      session._emit({ type: 'assistant', message: {}, partial: true })
      session._emit({ type: 'result', subtype: 'success' })
    })

    await collectEvents(router, 'session-1', 'Hi')

    const outEntries = logger.entries.filter((e) => e.direction === 'out')
    expect(outEntries.some((e) => e.type === 'assistant')).toBe(true)
    expect(outEntries.some((e) => e.type === 'result')).toBe(true)
  })

  it('includes durationMs on the result audit entry', async () => {
    setImmediate(() => session._emit({ type: 'result', subtype: 'success' }))

    await collectEvents(router, 'session-1', 'Hi')

    const resultEntry = logger.entries.find((e) => e.type === 'result')
    expect(resultEntry?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('stamps all entries in a turn with the same turnId', async () => {
    setImmediate(() => {
      session._emit({ type: 'assistant', message: {}, partial: false })
      session._emit({ type: 'result', subtype: 'success' })
    })

    await collectEvents(router, 'session-1', 'Hi')

    const turnIds = new Set(logger.entries.map((e) => e.turnId).filter(Boolean))
    expect(turnIds.size).toBe(1)
  })

  it('calls session.send() with the correct content', async () => {
    setImmediate(() => session._emit({ type: 'result', subtype: 'success' }))

    await collectEvents(router, 'session-1', 'Do something')
    expect(session.send).toHaveBeenCalledWith({ role: 'user', content: 'Do something' })
  })
})
