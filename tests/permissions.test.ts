import { describe, it, expect, vi } from 'vitest'
import { PermissionEngine } from '../src/permissions/PermissionEngine.js'
import { defaultPolicies } from '../src/permissions/policies.js'
import type { PermissionRequest } from '../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'test-id',
    tool: 'unknown_tool',
    input: {},
    sessionId: 'session-1',
    ...overrides,
  }
}

// ── Default policy tests ───────────────────────────────────────────────────

describe('PermissionEngine — default policies', () => {
  const engine = new PermissionEngine(defaultPolicies)

  it('approves read_file', async () => {
    const result = await engine.evaluate(req({ tool: 'read_file' }))
    expect(result.approved).toBe(true)
  })

  it('approves list_files', async () => {
    const result = await engine.evaluate(req({ tool: 'list_files' }))
    expect(result.approved).toBe(true)
  })

  it('denies bash with rm -rf', async () => {
    const result = await engine.evaluate(
      req({ tool: 'bash', input: { command: 'rm -rf /home/user' } }),
    )
    expect(result.approved).toBe(false)
  })

  it('denies bash with sudo', async () => {
    const result = await engine.evaluate(
      req({ tool: 'bash', input: { command: 'sudo apt install vim' } }),
    )
    expect(result.approved).toBe(false)
  })

  it('approves write_file under /tmp', async () => {
    const result = await engine.evaluate(
      req({ tool: 'write_file', input: { path: '/tmp/output.txt' } }),
    )
    expect(result.approved).toBe(true)
  })

  it('escalates (→ deny) write_file outside /tmp when no escalation handler', async () => {
    const result = await engine.evaluate(
      req({ tool: 'write_file', input: { path: '/etc/passwd' } }),
    )
    // Falls through to "*" catch-all escalate rule → no handler → deny
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/escalation/)
  })

  it('escalates (→ deny) an unknown tool when no handler is registered', async () => {
    const result = await engine.evaluate(req({ tool: 'unknown_tool' }))
    // Hits "*" catch-all
    expect(result.approved).toBe(false)
  })
})

// ── Rule matching tests ────────────────────────────────────────────────────

describe('PermissionEngine — rule matching', () => {
  it('denies when no rules match', async () => {
    const engine = new PermissionEngine([]) // empty rules
    const result = await engine.evaluate(req({ tool: 'anything' }))
    expect(result.approved).toBe(false)
    expect(result.reason).toBe('no matching rule')
  })

  it('"*" catch-all matches any tool', async () => {
    const engine = new PermissionEngine([{ tool: '*', action: 'approve' }])
    const result = await engine.evaluate(req({ tool: 'whatever' }))
    expect(result.approved).toBe(true)
  })

  it('first matching rule wins — earlier approve overrides later deny', async () => {
    const engine = new PermissionEngine([
      { tool: 'bash', action: 'approve' },
      { tool: 'bash', action: 'deny' },
    ])
    const result = await engine.evaluate(req({ tool: 'bash' }))
    expect(result.approved).toBe(true)
  })

  it('first matching rule wins — earlier deny overrides later approve', async () => {
    const engine = new PermissionEngine([
      { tool: 'bash', action: 'deny' },
      { tool: 'bash', action: 'approve' },
    ])
    const result = await engine.evaluate(req({ tool: 'bash' }))
    expect(result.approved).toBe(false)
  })

  it('inputPattern matches against JSON.stringify(input)', async () => {
    const engine = new PermissionEngine([
      { tool: 'bash', inputPattern: 'dangerous', action: 'deny' },
    ])
    const result = await engine.evaluate(
      req({ tool: 'bash', input: { command: 'run dangerous script' } }),
    )
    expect(result.approved).toBe(false)
  })

  it('inputPattern does not match unrelated input', async () => {
    const engine = new PermissionEngine([
      { tool: 'bash', inputPattern: 'dangerous', action: 'deny' },
      { tool: 'bash', action: 'approve' }, // fallback
    ])
    const result = await engine.evaluate(
      req({ tool: 'bash', input: { command: 'echo hello' } }),
    )
    expect(result.approved).toBe(true)
  })

  it('pathPrefix matches on input.path', async () => {
    const engine = new PermissionEngine([
      { tool: 'write_file', pathPrefix: '/safe/', action: 'approve' },
    ])
    const result = await engine.evaluate(
      req({ tool: 'write_file', input: { path: '/safe/output.txt' } }),
    )
    expect(result.approved).toBe(true)
  })

  it('pathPrefix does not match wrong path', async () => {
    const engine = new PermissionEngine([
      { tool: 'write_file', pathPrefix: '/safe/', action: 'approve' },
    ])
    const result = await engine.evaluate(
      req({ tool: 'write_file', input: { path: '/unsafe/output.txt' } }),
    )
    // No match → deny
    expect(result.approved).toBe(false)
  })

  it('all conditions must match simultaneously', async () => {
    const engine = new PermissionEngine([
      { tool: 'bash', inputPattern: 'secret', pathPrefix: '/tmp', action: 'deny' },
      { tool: 'bash', action: 'approve' }, // fallback
    ])
    // Tool matches "bash", inputPattern matches "secret" but pathPrefix won't apply
    // (pathPrefix checks input.path, not present here)
    const result = await engine.evaluate(
      req({ tool: 'bash', input: { command: 'echo secret' } }),
    )
    // pathPrefix /tmp doesn't match "" → first rule doesn't fire → fallback approve
    expect(result.approved).toBe(true)
  })
})

// ── Escalation handler tests ───────────────────────────────────────────────

describe('PermissionEngine — escalation handler', () => {
  it('calls the escalation handler when action is "escalate"', async () => {
    const handler = vi.fn().mockResolvedValue({ approved: true, reason: 'human said yes' })
    const engine = new PermissionEngine(
      [{ tool: '*', action: 'escalate' }],
      handler,
    )

    const request = req({ tool: 'bash', input: { command: 'ls' } })
    await engine.evaluate(request)

    expect(handler).toHaveBeenCalledWith(request)
  })

  it('returns the escalation handler result', async () => {
    const handler = vi.fn().mockResolvedValue({ approved: true, reason: 'operator approved' })
    const engine = new PermissionEngine(
      [{ tool: '*', action: 'escalate' }],
      handler,
    )

    const result = await engine.evaluate(req({ tool: 'bash' }))
    expect(result.approved).toBe(true)
    expect(result.reason).toBe('operator approved')
  })

  it('denies with a clear reason when escalation is needed but no handler is registered', async () => {
    const engine = new PermissionEngine([{ tool: '*', action: 'escalate' }])
    const result = await engine.evaluate(req())
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/no handler/)
  })
})
