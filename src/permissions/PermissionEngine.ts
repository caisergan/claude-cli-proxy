import type {
  IPermissionEngine,
  PermissionRequest,
  PermissionDecision,
} from '../types.js'
import type { PolicyRule, PermissionAction } from './policies.js'

export type { PolicyRule, PermissionAction }

export type EscalationHandler = (
  request: PermissionRequest,
) => Promise<PermissionDecision>

export class PermissionEngine implements IPermissionEngine {
  constructor(
    private readonly rules: PolicyRule[],
    private readonly escalationHandler?: EscalationHandler,
  ) {}

  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    for (const rule of this.rules) {
      if (!this._matches(rule, request)) continue

      return this._resolve(rule.action, request)
    }

    // No rule matched — safe default: deny
    return { approved: false, reason: 'no matching rule' }
  }

  // ── Rule matching ──────────────────────────────────────────────────────

  private _matches(rule: PolicyRule, request: PermissionRequest): boolean {
    // tool: exact match or "*" wildcard
    if (rule.tool !== undefined) {
      if (rule.tool !== '*' && rule.tool !== request.tool) return false
    }

    // inputPattern: regex against JSON-stringified input
    if (rule.inputPattern !== undefined) {
      const serialized = JSON.stringify(request.input)
      try {
        if (!new RegExp(rule.inputPattern).test(serialized)) return false
      } catch {
        // Malformed regex — treat as no-match
        return false
      }
    }

    // pathPrefix: check input.path starts with prefix
    if (rule.pathPrefix !== undefined) {
      const inputPath = String(
        (request.input as Record<string, unknown>).path ?? '',
      )
      if (!inputPath.startsWith(rule.pathPrefix)) return false
    }

    return true
  }

  // ── Action resolution ──────────────────────────────────────────────────

  private async _resolve(
    action: PermissionAction,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    switch (action) {
      case 'approve':
        return { approved: true }

      case 'deny':
        return { approved: false, reason: 'denied by policy' }

      case 'escalate':
        if (this.escalationHandler) {
          return this.escalationHandler(request)
        }
        // No handler registered — falls through to deny (safe default)
        return { approved: false, reason: 'escalation required but no handler registered' }
    }
  }
}
