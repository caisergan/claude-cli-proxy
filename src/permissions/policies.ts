import type { PermissionRequest, PermissionDecision } from '../types.js'

export type PermissionAction = 'approve' | 'deny' | 'escalate'

export interface PolicyRule {
  /** Tool name to match. Use "*" as a catch-all wildcard. */
  tool?: string
  /** Regex pattern matched against JSON.stringify(input). */
  inputPattern?: string
  /** For file tools: only match if input.path starts with this prefix. */
  pathPrefix?: string
  action: PermissionAction
}

export const defaultPolicies: PolicyRule[] = [
  { tool: 'read_file',  action: 'approve' },
  { tool: 'list_files', action: 'approve' },
  { tool: 'bash', inputPattern: 'rm\\s+-rf', action: 'deny' },
  { tool: 'bash', inputPattern: 'sudo',      action: 'deny' },
  { tool: 'write_file', pathPrefix: '/tmp',  action: 'approve' },
  { tool: '*', action: 'escalate' },   // everything else: ask
]
