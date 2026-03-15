import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

// ── Mock child_process before importing Session ───────────────────────────

let mockProcess: ReturnType<typeof makeMockProcess>

function makeMockProcess() {
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable
    stdout: Readable
    stderr: Readable
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }

  proc.stdin = stdin
  proc.stdout = stdout
  proc.stderr = stderr
  proc.killed = false
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true
    // Simulate SIGTERM close after a tick
    if (signal !== 'SIGKILL') {
      setTimeout(() => proc.emit('close', 0), 10)
    }
    return true
  })

  return proc
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    mockProcess = makeMockProcess()
    return mockProcess
  }),
}))

// Import AFTER mocking
import { Session } from '../src/session/Session.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function pushLine(line: string) {
  mockProcess.stdout.push(line + '\n')
}

function captureStdinWrites(): string[] {
  const writes: string[] = []
  const originalWrite = mockProcess.stdin.write.bind(mockProcess.stdin)
  mockProcess.stdin.write = (chunk: unknown, ...args: unknown[]) => {
    writes.push(chunk as string)
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args)
  }
  return writes
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Session', () => {
  let session: Session

  beforeEach(() => {
    // Reset mock process for each test
    vi.clearAllMocks()
    session = new Session({ sessionId: 'test-session-001' })
  })

  afterEach(async () => {
    // Clean up
    if (session.isAlive) {
      await session.destroy()
    }
  })

  it('starts alive', () => {
    expect(session.isAlive).toBe(true)
  })

  it('has the configured sessionId', () => {
    expect(session.sessionId).toBe('test-session-001')
  })

  it('has a createdAt date', () => {
    expect(session.createdAt).toBeInstanceOf(Date)
  })

  it('spawns claude with correct CLI flags', async () => {
    const { spawn } = await import('node:child_process')
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--permission-prompt-tool', 'stdio',
        '--permission-mode', 'default',
        '--verbose',
        '--include-partial-messages',
        '--model', 'claude-3-7-sonnet-20250219',
      ]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    )
  })

  it('send() writes a JSON user message line to stdin', () => {
    const writes = captureStdinWrites()
    session.send({ role: 'user', content: 'Hello Claude!' })

    expect(writes).toHaveLength(1)
    const parsed = JSON.parse(writes[0]!)
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Hello Claude!' },
    })
  })

  it('respondToPermission() writes a permission_response to stdin', () => {
    const writes = captureStdinWrites()
    session.respondToPermission('perm-id-123', true)

    const parsed = JSON.parse(writes[0]!)
    expect(parsed).toEqual({
      type: 'permission_response',
      id: 'perm-id-123',
      approved: true,
    })
  })

  it('parses a valid stdout NDJSON line and emits the event', () => {
    return new Promise<void>((resolve) => {
      session.on('assistant', (event) => {
        expect(event.type).toBe('assistant')
        expect((event as Record<string, unknown>).partial).toBe(false)
        resolve()
      })

      pushLine(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'Hi!' },
        partial: false,
      }))
    })
  })

  it('updates lastActivityAt when an event arrives', () => {
    return new Promise<void>((resolve) => {
      const before = session.lastActivityAt.getTime()

      setTimeout(() => {
        session.on('result', () => {
          expect(session.lastActivityAt.getTime()).toBeGreaterThan(before)
          resolve()
        })
        pushLine(JSON.stringify({ type: 'result', subtype: 'success' }))
      }, 5)
    })
  })

  it('skips invalid JSON on stdout without crashing', () => {
    // Should not throw; logger warned but no crash
    expect(() => {
      pushLine('this is not json {{{')
    }).not.toThrow()
    expect(session.isAlive).toBe(true)
  })

  it('sets isAlive = false and emits session_closed on process exit', () => {
    return new Promise<void>((resolve) => {
      session.on('session_closed', (event) => {
        expect(event.type).toBe('session_closed')
        expect(session.isAlive).toBe(false)
        resolve()
      })

      mockProcess.emit('close', 0)
    })
  })

  it('emits error event on non-zero exit', () => {
    return new Promise<void>((resolve) => {
      session.on('error', (event) => {
        expect(event.type).toBe('error')
        expect((event as Record<string, unknown>).exitCode).toBe(1)
        resolve()
      })

      mockProcess.emit('close', 1)
    })
  })

  it('destroy() sets isAlive = false', async () => {
    await session.destroy()
    expect(session.isAlive).toBe(false)
  })

  it('destroy() sends SIGTERM to the process', async () => {
    await session.destroy()
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('send() throws if the session is dead', async () => {
    await session.destroy()
    expect(() =>
      session.send({ role: 'user', content: 'test' }),
    ).toThrow(/no longer alive/)
  })
})
