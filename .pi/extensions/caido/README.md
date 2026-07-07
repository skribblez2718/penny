# Caido Extension

Penny extension that wraps the Caido SDK (`@caido/sdk-client`) to interact with a Caido instance directly — no shell-out, no CLI dependencies.

## Tools

| Tool | Description |
|------|-------------|
| `caido_info` | Health, viewer, or plugins — use `mode=health` as smoke test |
| `caido_search` | Search HTTP history with filters, pagination, ids-only mode |
| `caido_request` | Get request/response details or generate a curl command |
| `caido_intercept` | Get intercept status, enable, or disable |
| `caido_scopes` | CRUD scope management (allowlist / denylist) |
| `caido_filters` | CRUD filter presets |
| `caido_environments` | Manage environments and variables |
| `caido_findings` | List, get, create, update findings |
| `caido_sessions` | Replay session management |
| `caido_collections` | Replay collection management |
| `caido_edit` | Edit a request and replay it (method, path, headers, body, replacements) |
| `caido_send` | Send raw HTTP or replay existing via replay |
| `caido_fuzz` | Create automate session and start fuzzing (returns task ID) |
| `caido_projects` | List or select projects |
| `caido_tasks` | List or cancel tasks |
| `caido_files` | List or delete hosted files |

## Configuration

Add to your `.env`:

```dotenv
# Required (can be empty — tools will return an error asking for it)
CAIDO_PAT=
CAIDO_URL=http://localhost:8080
```

- **CAIDO_PAT**: Personal Access Token from Caido → Settings → Developer → Personal Access Tokens
- **CAIDO_URL**: Caido instance URL (default: `http://localhost:8080`)

## Authentication

The extension uses the SDK's built-in PAT-based authentication with an `InMemoryTokenCache`. The first connection exchanges the PAT for a short-lived access token automatically. No manual token management is required.

## Error Handling

Errors are classified into categories with user-friendly messages:

| Category | Trigger | Retryable |
|----------|---------|-----------|
| `CONNECTION_REFUSED` | `ECONNREFUSED`, `ENOTFOUND` | ✅ |
| `NOT_READY` | Caido still initializing | ✅ |
| `AUTH_FAILURE` | `401`, `Unauthorized` | ❌ |
| `TIMEOUT` | `timeout`, `ETIMEDOUT` | ✅ |
| `UNKNOWN` | Everything else | ❌ |

When `CAIDO_PAT` is missing, tools return an immediate error without attempting a connection.

## Testing

```bash
# Unit tests (pure utilities, no Caido required)
bun run test:unit

# Integration tests (skipped unless CAIDO_PAT is configured)
bun run test:integration
```

## Requirements

- Node.js ≥ 20
- `bun` for package management
- A running Caido instance and PAT for integration tests

## Architecture

- `tools/*.ts` — pure tool implementations that receive a `Client` parameter
- `client.ts` — lazy singleton `getClient()`, `InMemoryTokenCache`, and `withCaidoClient` wrapper
- `graphql.ts` — GraphQL documents for features not exposed in the high-level SDK
- `output.ts` — raw HTTP formatting helpers (`decodeRaw`, `truncateBody`, `rawToCurl`)
- `edit-helpers.ts` — pure HTTP parsing/modification functions for `caido_edit`
- `index.ts` — extension factory: registers all 16 tools + `caido-status` command

## Notes

- This extension replaces the legacy CLI-based `caido-mode` with Pi-native patterns.
- No `process.exit`, no `npx tsx`, no `secrets.json` — everything flows through `.env`, `registerTool()`, and the shared logger.
