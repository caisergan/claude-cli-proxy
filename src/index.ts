/**
 * Entry point — wires all modules together and exports the public API.
 */
import { SessionManager } from './session/SessionManager.js'
import { StreamRouter } from './router/StreamRouter.js'
import { PermissionEngine } from './permissions/PermissionEngine.js'
import { defaultPolicies } from './permissions/policies.js'
import { AuditLogger } from './audit/AuditLogger.js'
import { ConsoleSink } from './audit/sinks/ConsoleSink.js'
import { JsonFileSink } from './audit/sinks/JsonFileSink.js'

// ── Module wiring ──────────────────────────────────────────────────────────

const sessions = new SessionManager({
  idleTimeoutMs: 30 * 60 * 1000,
})

const permissions = new PermissionEngine(defaultPolicies)
const logger = new AuditLogger([
  new ConsoleSink('info'),
  new JsonFileSink('./logs/audit.ndjson'),
])

export const router = new StreamRouter(sessions, permissions, logger)

/**
 * Primary public API.
 * Streams Claude events for a given session and message content.
 */
export async function* sendMessage(sessionId: string, content: string) {
  yield* router.sendMessage(sessionId, content)
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.info(`[Proxy] Received ${signal}, shutting down…`)
  await sessions.destroyAll()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
