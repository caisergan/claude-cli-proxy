import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEntry, LogSink } from '../../types.js'

export class JsonFileSink implements LogSink {
  private readonly stream: WriteStream

  constructor(filePath: string) {
    // Ensure parent directory exists
    mkdirSync(dirname(filePath), { recursive: true })

    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })

    this.stream.on('error', (err) => {
      console.error('[JsonFileSink] Stream error:', err.message)
    })
  }

  write(entry: AuditEntry): void {
    try {
      this.stream.write(JSON.stringify(entry) + '\n')
    } catch (err) {
      console.error('[JsonFileSink] Write error:', err)
    }
  }
}
