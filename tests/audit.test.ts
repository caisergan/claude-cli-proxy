import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { AuditLogger } from '../src/audit/AuditLogger.js'
import { MemorySink } from '../src/audit/sinks/MemorySink.js'
import { ConsoleSink } from '../src/audit/sinks/ConsoleSink.js'
import { JsonFileSink } from '../src/audit/sinks/JsonFileSink.js'
import type { AuditEntry } from '../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date().toISOString(),
    sessionId: 'session-1',
    direction: 'out',
    type: 'assistant',
    payload: { type: 'assistant', message: {}, partial: false },
    turnId: 'turn-abc',
    ...overrides,
  }
}

// ── AuditLogger ────────────────────────────────────────────────────────────

describe('AuditLogger', () => {
  it('dispatches to all sinks', () => {
    const sinkA = { write: vi.fn() }
    const sinkB = { write: vi.fn() }
    const logger = new AuditLogger([sinkA, sinkB])

    const entry = makeEntry()
    logger.log(entry)

    expect(sinkA.write).toHaveBeenCalledWith(entry)
    expect(sinkB.write).toHaveBeenCalledWith(entry)
  })

  it('does not throw when a sync sink throws', () => {
    const broken = {
      write: vi.fn().mockImplementation(() => { throw new Error('boom') }),
    }
    const logger = new AuditLogger([broken])
    expect(() => logger.log(makeEntry())).not.toThrow()
  })

  it('does not propagate async sink rejections', async () => {
    const asyncBroken = {
      write: vi.fn().mockReturnValue(Promise.reject(new Error('async boom'))),
    }
    const logger = new AuditLogger([asyncBroken])

    // log() is synchronous — give the micro-task queue a tick to settle
    logger.log(makeEntry())
    await new Promise((res) => setTimeout(res, 10))
    // If we got here without an unhandled rejection crash, we pass
    expect(true).toBe(true)
  })

  it('continues dispatching to subsequent sinks even if a prior sink throws', () => {
    const broken = { write: vi.fn().mockImplementation(() => { throw new Error('oops') }) }
    const good   = { write: vi.fn() }
    const logger = new AuditLogger([broken, good])

    logger.log(makeEntry())
    expect(good.write).toHaveBeenCalled()
  })
})

// ── MemorySink ─────────────────────────────────────────────────────────────

describe('MemorySink', () => {
  it('stores entries in insertion order', () => {
    const sink = new MemorySink(100)
    const e1 = makeEntry({ type: 'assistant' })
    const e2 = makeEntry({ type: 'result' })
    sink.write(e1)
    sink.write(e2)

    const entries = sink.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.type).toBe('assistant')
    expect(entries[1]!.type).toBe('result')
  })

  it('evicts the oldest entry when over capacity', () => {
    const sink = new MemorySink(3)
    sink.write(makeEntry({ type: 'assistant' }))
    sink.write(makeEntry({ type: 'tool_use' }))
    sink.write(makeEntry({ type: 'result' }))
    sink.write(makeEntry({ type: 'error' })) // 4th — should evict 'assistant'

    const entries = sink.getEntries()
    expect(entries).toHaveLength(3)
    expect(entries[0]!.type).toBe('tool_use')
    expect(entries[2]!.type).toBe('error')
  })

  it('returns a defensive copy from getEntries()', () => {
    const sink = new MemorySink(10)
    sink.write(makeEntry())
    const copy = sink.getEntries()
    copy.pop()
    expect(sink.getEntries()).toHaveLength(1) // original unchanged
  })

  it('clear() empties the buffer', () => {
    const sink = new MemorySink(10)
    sink.write(makeEntry())
    sink.clear()
    expect(sink.getEntries()).toHaveLength(0)
  })
})

// ── ConsoleSink ────────────────────────────────────────────────────────────

describe('ConsoleSink', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeSpy = vi.spyOn(process.stdout, 'write' as any).mockImplementation(() => true)
  })

  it('logs significant events at "info" level', () => {
    const sink = new ConsoleSink('info')
    sink.write(makeEntry({ type: 'result' }))
    expect(writeSpy).toHaveBeenCalled()
  })

  it('does NOT log assistant events at "info" level', () => {
    const sink = new ConsoleSink('info')
    sink.write(makeEntry({ type: 'assistant' }))
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('logs ALL events at "debug" level including assistant', () => {
    const sink = new ConsoleSink('debug')
    sink.write(makeEntry({ type: 'assistant' }))
    expect(writeSpy).toHaveBeenCalled()
  })

  it('logs permission_request events at "info" level', () => {
    const sink = new ConsoleSink('info')
    sink.write(makeEntry({ type: 'permission_request' }))
    expect(writeSpy).toHaveBeenCalled()
  })

  it('logs error events at "info" level', () => {
    const sink = new ConsoleSink('info')
    sink.write(makeEntry({ type: 'error' }))
    expect(writeSpy).toHaveBeenCalled()
  })
})

// ── JsonFileSink ───────────────────────────────────────────────────────────

describe('JsonFileSink', () => {
  it('writes a valid NDJSON line to a temp file', async () => {
    const filePath = join(tmpdir(), `audit-test-${Date.now()}.ndjson`)
    const sink = new JsonFileSink(filePath)

    const entry = makeEntry({ type: 'result', durationMs: 123 })
    sink.write(entry)

    // Give the stream a tick to flush
    await new Promise((res) => setTimeout(res, 50))

    expect(existsSync(filePath)).toBe(true)
    const raw = readFileSync(filePath, 'utf8').trim()
    const parsed = JSON.parse(raw) as AuditEntry
    expect(parsed.type).toBe('result')
    expect(parsed.durationMs).toBe(123)
  })

  it('creates the parent directory if it does not exist', () => {
    const filePath = join(
      tmpdir(),
      `audit-test-nested-${Date.now()}`,
      'deep',
      'audit.ndjson',
    )
    // Should not throw
    expect(() => new JsonFileSink(filePath)).not.toThrow()
  })
})
