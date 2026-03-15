import type { AuditEntry, LogSink } from '../../types.js'

// ANSI color codes — no external dependencies
const RESET  = '\x1b[0m'
const CYAN   = '\x1b[36m'
const GREEN  = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED    = '\x1b[31m'
const DIM    = '\x1b[2m'

const INFO_EVENT_TYPES = new Set([
  'result',
  'error',
  'permission_request',
  'permission_response',
  'session_closed',
])

function colorForType(type: string): string {
  switch (type) {
    case 'assistant':          return CYAN
    case 'permission_request':
    case 'permission_response': return YELLOW
    case 'error':
    case 'session_closed':     return RED
    case 'result':             return GREEN
    default:                   return DIM
  }
}

export class ConsoleSink implements LogSink {
  constructor(private readonly level: 'debug' | 'info' = 'info') {}

  write(entry: AuditEntry): void {
    if (this.level === 'info' && !INFO_EVENT_TYPES.has(entry.type)) {
      return // Skip noisy events at info level
    }

    const color = colorForType(entry.type)
    const dirTag = entry.direction === 'in' ? '→ claude' : '← claude'
    const turnTag = entry.turnId ? ` [${entry.turnId.slice(0, 8)}]` : ''
    const durTag = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''

    const line =
      `${color}[${entry.ts}]${RESET} ` +
      `${DIM}${dirTag}${turnTag}${RESET} ` +
      `${color}${entry.type}${RESET}${durTag} ` +
      `${DIM}session:${entry.sessionId}${RESET}`

    process.stdout.write(line + '\n')
  }
}
