import type { IAuditLogger, AuditEntry, LogSink } from '../types.js'

export type { LogSink }

export class AuditLogger implements IAuditLogger {
  constructor(private readonly sinks: LogSink[]) {}

  /**
   * Fire-and-forget log dispatch.
   * Never throws — errors from individual sinks are swallowed and printed to stderr.
   */
  log(entry: AuditEntry): void {
    for (const sink of this.sinks) {
      try {
        const result = sink.write(entry)

        // For async sinks: prevent unhandled rejections from surfacing
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            console.error('[AuditLogger] Async sink error:', err)
          })
        }
      } catch (err) {
        // Sync sink threw — swallow it
        console.error('[AuditLogger] Sync sink error:', err)
      }
    }
  }
}
