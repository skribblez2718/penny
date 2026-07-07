# Error Logging

Penny's error logging is a structured system for capturing, transmitting, and querying what went wrong. Instead of free-form text like "something broke," every error carries a code, a severity, a component, and a context that makes debugging faster.

## What Structured Error Logging Is

A structured log entry is more than a message. It is a record with defined fields:

- **Level** — how serious the event is: DEBUG, INFO, WARN, ERROR, or CRITICAL.
- **Component** — which extension or subsystem produced the entry.
- **Message** — a human-readable description.
- **Error code** — a machine-readable identifier from a shared taxonomy.
- **Context** — extra details such as the tool name, session ID, or arguments.

This structure lets both humans and machines reason about errors consistently. A human can read the message; an observability query can filter by code and component; an agent can pattern-match a known failure mode.

## Why Structured Error Codes Matter

Without a shared taxonomy, error logs become a pile of similar-sounding strings. "Bridge timed out," "bridge process hung," and "mempalace bridge timeout" might describe the same failure, but a query has to guess which phrasing was used.

A single code such as `BRIDGE_TIMEOUT` removes that ambiguity:

- **Filtering** — find every bridge timeout across all sessions.
- **Correlation** — connect an error in one extension to related events in another.
- **Automation** — agents can recognize a known code and apply a known response.
- **Trending** — count how often each failure mode occurs over time.

Codes are written in `SCREAMING_SNAKE_CASE` and prefixed by subsystem, such as `BRIDGE_`, `PYTHON_`, `AGENT_`, `SEARCH_`, or `OBSERVABILITY_`. This prefix makes the owner of the error obvious at a glance.

## How Errors Flow from Extensions to the Server

Penny's extensions use a shared logger that streams structured entries to the observability server. The path looks like this:

```
Extension code calls createLogger("memory")
         │
         ▼
Logger builds a structured entry with code, level, context
         │
         ▼
Observability extension sends the entry over WebSocket as event: "log"
         │
         ▼
Observability server receives, parses, and writes to SQLite logs table
         │
         ▼
Logs become queryable via REST API and Penny tools
```

The logger is transparent to the extension developer. Once an extension imports `createLogger`, every log call is automatically forwarded to the observability server whenever the WebSocket is connected.

## Retention and Cleanup

Logs are useful for days, not forever. The observability server keeps structured logs for a default retention period and runs scheduled cleanup to remove older entries. This balances investigative power with storage growth.

## Querying Logs

There are two ways to read the log stream back out:

1. **Penny tools** — `observability_query_logs` lets Penny ask direct questions during a session, such as "show me ERROR entries from the memory component in the last hour."
2. **REST API** — external tools can query logs by level, component, session, or time range, which is useful for dashboards and alerts.

This dual access is intentional. Penny uses logs to diagnose a specific problem during a conversation; external tooling uses logs to monitor health and detect trends.

## Adding a New Error Code

The taxonomy is maintained deliberately. A new code is added in three places:

1. The `ErrorCode` union type in the logger source file, so TypeScript enforces it.
2. The human-readable error-codes reference, so people know what the code means.
3. Any relevant system checks, so verification can catch unregistered codes.

This discipline prevents code drift. If an extension invents an ad-hoc string, it will not match queries or checks, and the log becomes harder to use.

## Trade-offs

Structured logging adds a small upfront cost: every error needs a code and a component. The return is large at scale:

| With structure | Without structure |
| --- | --- |
| Known codes map to known remedies | Every error is a unique string to interpret |
| Trends and anomalies are queryable | Spot-checking logs one by one |
| Cross-component correlation is easy | Siloed logs per extension |

The cost is lowest when the code is chosen at the time the error is introduced. Retrofitting codes onto a sea of ad-hoc strings is much harder.

## Relationship to Other Capabilities

- [Observability Server](../observability-server/observability-server.md) — the server that receives, stores, and serves log entries.
- [Outcome Ledger](../outcome-ledger/outcome-ledger.md) — captures the results of consequential actions; error logs often help explain why an action failed.
- Agent reference: `docs/agents/capabilities/error-logging/error-codes.md` — the machine-readable code catalog.
