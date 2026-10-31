# Error Codes — Structured error taxonomy for all extensions

## What

The [`ErrorCode` union](../../../../.pi/lib/logger/logger.ts) owns the exact registered taxonomy. Codes are `SCREAMING_SNAKE_CASE`, prefixed by subsystem. `LogEntry.error` and its `code` are structurally optional; the logger API accepts uncoded entries and does not validate taxonomy membership at runtime. That optional wire shape is distinct from the emission policy below.

## Why

Without a shared taxonomy, error logs are inconsistent strings. With it, observability queries can filter by subsystem and severity, and agents can pattern-match error codes to known failure modes.

## Rules

1. **Emission policy: all error logs must include a code from the taxonomy.** Do not invent an ad-hoc code. A free-form diagnostic message does not replace a registered identifier; code presence alone does not establish the cause or outcome.
2. **New codes must be added to the `ErrorCode` union type first.** Reconcile any affected diagnostic guidance here; this selective reference does not redefine the union.
3. **Severity follows the logger convention:** DEBUG, INFO, WARN, ERROR, CRITICAL.

## Selected Diagnostic Reference

This table is not exhaustive. The union owns membership; severity shown here is diagnostic guidance, not a fixed per-code mapping enforced by the type. Compatibility names such as `BRIDGE_*` and `PYTHON_*` remain valid identifiers, not evidence that those transports are active. Do not rename compatibility codes or infer successful recovery from a logged code.

| Code                                 | Severity | Extension     | Description                                                 |
| ------------------------------------ | -------- | ------------- | ----------------------------------------------------------- |
| `BRIDGE_TIMEOUT`                     | ERROR    | memory        | Bridge process hung >30s                                    |
| `BRIDGE_SPAWN_ERROR`                 | ERROR    | memory        | Failed to spawn bridge                                      |
| `BRIDGE_PARSE_ERROR`                 | WARN     | memory        | Bridge stdout not valid JSON                                |
| `PYTHON_TIMEOUT`                     | ERROR    | skill         | Orchestrator timed out                                      |
| `PYTHON_SPAWN_ERROR`                 | ERROR    | skill         | Failed to spawn orchestrator                                |
| `PYTHON_PARSE_ERROR`                 | WARN     | skill         | Orchestrator stdout not valid JSON                          |
| `AGENT_TIMEOUT`                      | ERROR    | agent-runner  | Agent subprocess timed out                                  |
| `AGENT_SPAWN_ERROR`                  | ERROR    | agent-runner  | Failed to spawn agent                                       |
| `AGENT_INCOMPLETE`                   | WARN     | agent-runner  | Agent exited without `message_end`                          |
| `COMPACTION_ENGINE_QUERY_FAILED`     | ERROR    | compaction    | Engine checkpointer read failed (runs omitted from summary) |
| `COMPACTION_MEMPALACE_QUERY_FAILED`  | ERROR    | compaction    | Mempalace query failed                                      |
| `COMPACTION_KG_QUERY_FAILED`         | ERROR    | compaction    | KG query failed                                             |
| `COMPACTION_VALIDATION_FAILED`       | ERROR    | compaction    | Artifact failed zod validation (summary still emitted)      |
| `COMPACTION_BUDGET_OVERFLOW`         | ERROR    | compaction    | Summary truncated after degrade loop hit its floor          |
| `COMPACTION_POST_FAILED`             | ERROR    | compaction    | Artifact archive POST to observability failed               |
| `SEARCH_API_KEY_MISSING`             | ERROR    | search        | `OLLAMA_API_KEY` not set                                    |
| `SEARCH_CLIENT_ERROR`                | WARN     | search        | HTTP 4xx from search API                                    |
| `SEARCH_SERVER_ERROR`                | ERROR    | search        | HTTP 5xx from search API                                    |
| `OBSERVABILITY_SERVER_SPAWN_FAILED`  | ERROR    | observability | Canonical TypeScript service failed to start                |
| `OBSERVABILITY_QUERY_LOGS_FAILED`    | ERROR    | observability | Structured-log query failed                                 |
| `OBSERVABILITY_QUERY_HISTORY_FAILED` | ERROR    | observability | Direct Pi JSONL history query failed                        |

## Adding a Code

1. Add to `ErrorCode` union in `.pi/lib/logger/logger.ts`
2. Update affected selected diagnostics above when needed; preserve compatibility identifiers and failure dispositions.
3. Update `scripts/system/checks/check_error_logging.py` if needed. It is a source-pattern policy check, not proof of runtime membership or universal coded emission.

## Verification

- [ ] All `logger.error()` calls use a code from the taxonomy
- [ ] New codes exist in the logger union; affected selected diagnostics agree with it
- [ ] Severity matches logger convention

## Files

| File                       | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `.pi/lib/logger/logger.ts` | `ErrorCode` union type (source of truth) |
