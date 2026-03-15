import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type {
  ClaudeEvent,
  ClaudeEventType,
  UserInputMessage,
  UserMessage,
  PermissionResponseMessage,
} from '../types.js'

export interface SessionConfig {
  sessionId: string
  model?: string
  mcpServerUrl?: string
  extraFlags?: string[]
}

const DEFAULT_MODEL = 'claude-3-7-sonnet-20250219'

export class Session extends EventEmitter {
  readonly sessionId: string
  readonly createdAt: Date
  lastActivityAt: Date

  private readonly process: ChildProcess
  private _isAlive: boolean = true
  private stderrBuffer: string = ''

  constructor(config: SessionConfig) {
    super()

    this.sessionId = config.sessionId
    this.createdAt = new Date()
    this.lastActivityAt = new Date()

    const model = config.model ?? DEFAULT_MODEL

    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
    ]

    if (config.extraFlags) {
      args.push(...config.extraFlags)
    }

    if (config.mcpServerUrl) {
      args.push('--mcp-server', config.mcpServerUrl)
    }

    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this._setupStdout()
    this._setupStderr()
    this._setupProcessEvents()
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get isAlive(): boolean {
    return this._isAlive
  }

  send(message: UserMessage): void {
    if (!this._isAlive) {
      throw new Error(`Session ${this.sessionId} is no longer alive`)
    }

    const payload: UserInputMessage = { type: 'user', message }
    this._writeToStdin(payload)
  }

  respondToPermission(id: string, approved: boolean): void {
    if (!this._isAlive) return

    const payload: PermissionResponseMessage = {
      type: 'permission_response',
      id,
      approved,
    }
    this._writeToStdin(payload)
  }

  // Typed wrapper around EventEmitter.on for IDE discoverability
  onEvent(event: ClaudeEventType, listener: (event: ClaudeEvent) => void): this {
    return super.on(event, listener)
  }

  async destroy(): Promise<void> {
    if (!this._isAlive) return

    this._isAlive = false

    return new Promise<void>((resolve) => {
      const proc = this.process

      const onClose = () => {
        resolve()
      }

      proc.once('close', onClose)

      // Try graceful SIGTERM first
      proc.kill('SIGTERM')

      // Force kill after 5 seconds if still running
      const forceKillTimer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL')
        }
      }, 5000)

      proc.once('close', () => {
        clearTimeout(forceKillTimer)
      })
    })
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _writeToStdin(payload: unknown): void {
    const line = JSON.stringify(payload) + '\n'
    this.process.stdin?.write(line)
  }

  private _setupStdout(): void {
    if (!this.process.stdout) return

    const rl = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    })

    rl.on('line', (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let event: ClaudeEvent
      try {
        event = JSON.parse(trimmed) as ClaudeEvent
      } catch {
        // Skip malformed lines without crashing
        console.warn(
          `[Session:${this.sessionId}] Failed to parse stdout line:`,
          trimmed.slice(0, 200),
        )
        return
      }

      this.lastActivityAt = new Date()
      this.emit(event.type, event)
    })
  }

  private _setupStderr(): void {
    if (!this.process.stderr) return

    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString()
    })
  }

  private _setupProcessEvents(): void {
    this.process.on('close', (code: number | null) => {
      this._isAlive = false

      if (code !== 0 && code !== null) {
        const errorEvent: ClaudeEvent = {
          type: 'error',
          message: `Process exited with code ${code}`,
          exitCode: code,
          stderr: this.stderrBuffer,
        }
        this.emit('error', errorEvent)
      }

      const closedEvent: ClaudeEvent = {
        type: 'session_closed',
        sessionId: this.sessionId,
        exitCode: code,
      }
      this.emit('session_closed', closedEvent)
    })

    this.process.on('error', (err: Error) => {
      this._isAlive = false

      const errorEvent: ClaudeEvent = {
        type: 'error',
        message: err.message,
        error: err.name,
      }
      this.emit('error', errorEvent)
    })
  }
}
