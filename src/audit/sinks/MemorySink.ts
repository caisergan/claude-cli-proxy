import type { AuditEntry, LogSink } from '../../types.js'

export class MemorySink implements LogSink {
  private readonly buffer: AuditEntry[] = []

  constructor(private readonly maxEntries: number = 1000) {}

  write(entry: AuditEntry): void {
    if (this.buffer.length >= this.maxEntries) {
      this.buffer.shift() // evict oldest
    }
    this.buffer.push(entry)
  }

  /** Returns a copy of stored entries in insertion order. */
  getEntries(): AuditEntry[] {
    return [...this.buffer]
  }

  /** Clears the buffer. Useful between test cases. */
  clear(): void {
    this.buffer.length = 0
  }
}
