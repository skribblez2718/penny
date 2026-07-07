# Observability Extension

Captures 100% of Pi conversation messages and sends them to an observability WebSocket server for real-time tracking and analysis.

## Features

- Captures all user ↔ LLM messages
- Captures all tool calls and results
- Captures agent lifecycle events
- Captures context and provider request metadata
- Buffers messages on disconnect with automatic replay
- Exponential backoff reconnection
- Filters binary image data
- Truncates large tool outputs

## Configuration

Configure via `.env` file or environment variables:

| Variable                             | Default                  | Description                         |
| ------------------------------------ | ------------------------ | ----------------------------------- |
| `PI_OBSERVABILITY_URL`               | `ws://localhost:8765/ws` | WebSocket server URL                |
| `PI_OBSERVABILITY_API_KEY`           | (empty)                  | API key for authentication          |
| `PI_OBSERVABILITY_ENABLED`           | `true`                   | Enable/disable the extension        |
| `PI_OBSERVABILITY_MAX_OUTPUT_LENGTH` | `10000`                  | Max length before truncating output |

## Message Format

All messages sent to the server have this structure:

```typescript
interface ObservabilityMessage {
  event: string; // Event type (see below)
  sessionId: string; // Pi session ID
  timestamp: number; // Unix timestamp in ms
  data: unknown; // Event-specific payload
}
```

## Captured Events

### Session Lifecycle

| Event              | Description                |
| ------------------ | -------------------------- |
| `session_start`    | Session started or resumed |
| `session_shutdown` | Session ended              |

### Agent Lifecycle

| Event                | Description              |
| -------------------- | ------------------------ |
| `before_agent_start` | Before agent loop starts |
| `agent_start`        | Agent loop started       |
| `agent_end`          | Agent loop finished      |

### Turn Lifecycle

| Event        | Description   |
| ------------ | ------------- |
| `turn_start` | Turn started  |
| `turn_end`   | Turn finished |

### Message Lifecycle

| Event            | Description                 |
| ---------------- | --------------------------- |
| `message_start`  | Message started             |
| `message_update` | Message updated (streaming) |
| `message_end`    | Message finished            |

### Tool Lifecycle

| Event                  | Description                            |
| ---------------------- | -------------------------------------- |
| `tool_execution_start` | Tool execution started                 |
| `tool_call`            | Tool about to execute (can be blocked) |
| `tool_result`          | Tool result available                  |
| `tool_execution_end`   | Tool execution finished                |

### Other Events

| Event                     | Description             |
| ------------------------- | ----------------------- |
| `model_select`            | Model changed           |
| `context`                 | Context built for LLM   |
| `before_provider_request` | Request to LLM provider |

## Commands

| Command                    | Description             |
| -------------------------- | ----------------------- |
| `/observability-status`    | Check connection status |
| `/observability-reconnect` | Force reconnection      |

## Data Filtering

### Excluded Data

- Binary image data (images are replaced with `{ type: "image", filtered: true }`)
- Admin/internal extension messages

### Truncated Data

- Tool outputs exceeding `PI_OBSERVABILITY_MAX_OUTPUT_LENGTH`
- Text content exceeding max length

## Development

The extension installs `ws` as a dependency. Run:

```bash
cd .pi/extensions/observability
bun install
```

## Usage with Observability Server

1. Start the observability server:

```bash
cd ~/projects/observability
bun install
bun run start
```

2. Configure Pi to connect:

```env
# In your .env
PI_OBSERVABILITY_URL=ws://localhost:8765/ws
PI_OBSERVABILITY_ENABLED=true
```

3. Start Pi - the extension will automatically connect and stream events.
