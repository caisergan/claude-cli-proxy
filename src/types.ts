// Shared types for the Claude CLI Proxy

export type ClaudeEventType =
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'result'
  | 'error'
  | 'session_closed'

export interface ClaudeEvent {
  type: ClaudeEventType
  [key: string]: unknown
}

export interface UserMessage {
  role: 'user'
  content: string
}

export interface PermissionResponseMessage {
  type: 'permission_response'
  id: string
  approved: boolean
}

/** The message shape written to claude stdin for a user turn */
export interface UserInputMessage {
  type: 'user'
  message: UserMessage
}

/** Shape of a raw permission_request event from claude stdout */
export interface PermissionRequestEvent extends ClaudeEvent {
  type: 'permission_request'
  id: string
  tool: string
  input: Record<string, unknown>
}

/** Shape of a result event from claude stdout */
export interface ResultEvent extends ClaudeEvent {
  type: 'result'
  subtype: string
  cost_usd?: number
}

/** Shape of an assistant event from claude stdout */
export interface AssistantEvent extends ClaudeEvent {
  type: 'assistant'
  message: {
    role: string
    content: unknown
  }
  partial: boolean
}

// ── Permission types ───────────────────────────────────────────────────────

export interface PermissionRequest {
  id: string
  tool: string
  input: Record<string, unknown>
  sessionId: string
}

export interface PermissionDecision {
  approved: boolean
  reason?: string
}

/** Minimal interface StreamRouter depends on — real impl comes in Part 3 */
export interface IPermissionEngine {
  evaluate(request: PermissionRequest): Promise<PermissionDecision>
}

// ── Audit types ────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string                  // ISO 8601
  sessionId: string
  direction: 'in' | 'out'    // "in" = sent to claude, "out" = received from claude
  type: string                // ClaudeEvent type
  payload: unknown            // full event object
  turnId?: string             // UUID per sendMessage call, for grouping events
  durationMs?: number         // only on "result" events: time from first user message
}

/** Minimal interface StreamRouter depends on — real impl comes in Part 4 */
export interface IAuditLogger {
  log(entry: AuditEntry): void
}

/** Sink that receives audit entries for writing */
export interface LogSink {
  write(entry: AuditEntry): void | Promise<void>
}


