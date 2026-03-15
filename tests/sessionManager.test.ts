import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

// ── Mock child_process ────────────────────────────────────────────────────

function makeMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable
    stdout: Readable
    stderr: Readable
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }

  proc.stdin = new Writable({ write(_c, _e, cb) { cb() } })
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  proc.killed = false
  proc.kill = vi.fn((_signal?: string) => {
    proc.killed = true
    setTimeout(() => proc.emit('close', 0), 10)
    return true
  })

  return proc
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => makeMockProcess()),
}))

import { SessionManager } from '../src/session/SessionManager.js'

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let manager: SessionManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SessionManager({ idleTimeoutMs: 0 }) // disable idle timer
  })

  afterEach(async () => {
    await manager.destroyAll()
  })

  it('create() returns a Session with a unique UUID', () => {
    const s1 = manager.create()
    const s2 = manager.create()

    expect(s1.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(s1.sessionId).not.toBe(s2.sessionId)
  })

  it('create() adds the session to the internal list', () => {
    manager.create()
    manager.create()
    expect(manager.list()).toHaveLength(2)
  })

  it('get() returns the session by ID', () => {
    const session = manager.create()
    expect(manager.get(session.sessionId)).toBe(session)
  })

  it('get() returns undefined for unknown IDs', () => {
    expect(manager.get('non-existent')).toBeUndefined()
  })

  it('getOrCreate() returns an existing session', () => {
    const session = manager.create()
    const same = manager.getOrCreate(session.sessionId)
    expect(same).toBe(session)
  })

  it('getOrCreate() creates a new session for an unknown ID', () => {
    const session = manager.getOrCreate('my-custom-id')
    expect(session.sessionId).toBe('my-custom-id')
    expect(session.isAlive).toBe(true)
  })

  it('destroy() removes the session from the pool', async () => {
    const session = manager.create()
    await manager.destroy(session.sessionId)
    expect(manager.get(session.sessionId)).toBeUndefined()
  })

  it('destroyAll() removes all sessions', async () => {
    manager.create()
    manager.create()
    manager.create()
    await manager.destroyAll()
    expect(manager.list()).toHaveLength(0)
  })

  it('enforces maxSessions limit', () => {
    const limited = new SessionManager({ maxSessions: 2, idleTimeoutMs: 0 })
    limited.create()
    limited.create()

    expect(() => limited.create()).toThrow(/Session limit reached/)
    return limited.destroyAll()
  })

  it('auto-removes session from pool when subprocess closes', async () => {
    return new Promise<void>(async (resolve) => {
      const session = manager.create()
      const id = session.sessionId

      // Simulate subprocess closing naturally
      session.once('session_closed', async () => {
        // Give the auto-cleanup listener a tick to run
        await Promise.resolve()
        expect(manager.get(id)).toBeUndefined()
        resolve()
      })

      await session.destroy()
    })
  })

  it('idle timeout: destroys sessions that have been idle too long', async () => {
    vi.useFakeTimers()

    const timedManager = new SessionManager({ idleTimeoutMs: 5000 })
    const session = timedManager.create()
    const id = session.sessionId

    // Wind back the lastActivityAt to simulate idleness
    session.lastActivityAt = new Date(Date.now() - 10_000)

    // Fast-forward the idle timer check interval (60s)
    vi.advanceTimersByTime(61_000)

    // Give micro tasks a chance to run
    await Promise.resolve()

    expect(timedManager.get(id)).toBeUndefined()

    vi.useRealTimers()
    await timedManager.destroyAll()
  })
})
