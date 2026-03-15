# Claude Code CLI Proxy

A long-running proxy process that wraps the `claude` CLI binary to provide persistent, programmatic access via a stream-based API.

## What is this?

The `claude` CLI accepts `--input-format stream-json` and `--output-format stream-json`, which enables a persistent subprocess model. Rather than restarting `claude` for every prompt, this proxy keeps a `claude` instance alive in the background. It routes new messages to its `stdin` and reads streaming events from its `stdout`.

### Key Features
- **Persistent Sessions**: Keeps processes warm for faster response times and context retention.
- **Stateless API**: From the caller's perspective, you just send messages to a `sessionId`. The proxy manages the background lifecycle.
- **Permission Engine**: Automatically intercepts and evaluates tool permission requests (e.g. `bash`, `read_file`) based on a configured policy engine.
- **Audit Logging**: Captures structured NDJSON logs of all inbound and outbound events.
- **Extensible**: Ready for `mcp` server integration to expose custom tools.

## Installation

1. Make sure you have the Official Claude CLI installed and authenticated.
2. Clone this repository:
   ```bash
   git clone https://github.com/caisergan/claude-cli-proxy.git
   cd claude-cli-proxy
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build or run tests (requires `vitest` or `tsx`):
   ```bash
   npm test
   ```

## Usage Example

The main entry point exports a `sendMessage` async generator. You interact with Claude over NDJSON events:

```typescript
import { sendMessage } from './src/index'

async function run() {
  const sessionId = "my-unique-session-id"

  console.log("Sending prompt to Claude...")
  const stream = sendMessage(sessionId, "List all the .ts files in src/")
  
  for await (const event of stream) {
    if (event.type === "assistant" && !event.partial) {
      console.log("Claude says:", event.message.content)
    }
    
    if (event.type === "permission_request") {
      console.log(`Claude requested permission for tool: ${event.tool}`)
      // The proxy's PermissionEngine handles the approval automatically 
      // based on its configured rules (`src/permissions/policies.ts`).
    }
    
    if (event.type === "result") {
      console.log(`Turn complete. Cost: $${event.cost_usd || 0}`)
      break
    }
  }
}

run()
```

## How It Works

1. **Session Management**: Whenever `sendMessage` is called for a new `sessionId`, it spins up a new `claude` subprocess configured for raw NDJSON I/O.
2. **Event Routing**: User messages are written to the subprocess' `stdin`. Claude's `stdout` is continuously parsed line-by-line and yielded back to the caller.
3. **Permissions**: When tools request approval, the execution flow pauses. The Proxy's `PermissionEngine` evaluates the pattern against rules and pushes a response back into `stdin` to unblock Claude.
4. **Cleanup**: Idle sessions are automatically cleaned up after a period of inactivity to save system resources.

## Development

- `src/session/`: Subprocess lifecycle and I/O wrappers.
- `src/router/`: Central message bus and turn management.
- `src/permissions/`: Rule evaluation engine for Claude tool uses.
- `src/audit/`: Side-effect log sink infrastructure.
- `tests/`: Vitest test suites.

## License

MIT
