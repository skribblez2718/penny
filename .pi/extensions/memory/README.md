# Penny Memory Extension

HTTP-only, role-scoped access to a MemPalace 3.7.1 MCP hub. Ordinary recall/curation consumes the versioned `platform-memory` config, capability policy, and HTTP client contract. The optional primary advisory logstream surface is implemented locally because `platform-memory` intentionally continues to forbid logstream operations for generic harness clients. Both paths apply Pi-specific normalization and the same final-envelope budget/continuation machinery. The production extension never imports Python, spawns a bridge, opens palace bytes, or falls back to direct/prefer storage.

## Runtime policy

- **Primary:** only an unmarked trusted main Pi runtime is primary.
- **Denied:** any `PENNY_RUNTIME_ROLE` marker—including `worker`, `skill-driver`, or `primary`—is deny-only. The extension registers zero tools and zero lifecycle hooks.
- **Disabled:** `PENNY_MEMORY_MODE=disabled` registers nothing.
- **Hub:** production otherwise requires `PENNY_MEMORY_MODE=hub` (the default). `legacy`, `shadow`, `direct`, and `prefer` are rejected. No temporary mode remains; compatibility retirement is owned by the memory platform under MEM-07.
- **Write gate:** `PENNY_MEMORY_WRITE_MODE` defaults to `disabled`. Read-only qualification omits every mutating tool, suppresses automatic diary writes, and rejects direct adapter writes before HTTP. The owner enables writes only after the journaled canary and reconciliation gate.
- **Advisory logstream gate:** `PENNY_MEMORY_LOGSTREAM_MODE` defaults to `disabled`. `primary-advisory` is valid only with hub mode, a safe configured stream, and a nonempty safe room allowlist. It is independent of curated-write mode for list/wait; append/ack additionally require the ordinary write gate.

A model cannot grant itself tools, enable writes, select a stream/principal, or address another principal by emitting role, bundle, or routing text.

## Configuration

| Variable                              | Contract                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `PENNY_MEMORY_MODE`                   | `hub` or `disabled` only                                                    |
| `PENNY_MEMORY_WRITE_MODE`             | `disabled` (default) or owner-enabled `enabled` after canary reconciliation |
| `PENNY_MEMORY_LOGSTREAM_MODE`         | `disabled` (default) or `primary-advisory`                                  |
| `PENNY_MEMORY_LOGSTREAM_STREAM`       | Required safe lowercase slash-separated stream when advisory mode is active |
| `PENNY_MEMORY_LOGSTREAM_ROOMS`        | Required nonempty comma-separated safe room allowlist; no duplicates        |
| `PENNY_MEMORY_TRUST_MODE`             | `isolated` or `shared-trust-domain`                                         |
| `PENNY_MEMORY_PRINCIPAL_ID`           | Caller-registry principal identifier                                        |
| `PENNY_MEMORY_MCP_ENDPOINT`           | Absolute `http://` or `https://` endpoint; the adapter posts only to `/mcp` |
| `PENNY_MEMORY_PALACE_ID`              | Caller-registry palace identifier                                           |
| `PENNY_MEMORY_DATA_ROOT_ID`           | Opaque caller-registry data-custody/root identifier                         |
| `PENNY_MEMORY_ISOLATION_BOUNDARY_ID`  | Required isolated-palace boundary identifier                                |
| `PENNY_MEMORY_TRUST_DOMAIN_ID`        | Required shared trust-domain identifier                                     |
| `PENNY_MEMORY_WHOLE_PALACE_TRUST_ACK` | Must be `whole-palace` for shared-trust-domain                              |
| `PENNY_MEMORY_OWNER_ID`               | Data/service owner identifier                                               |
| `PENNY_MEMORY_BACKUP_POLICY_REF`      | Caller-owned backup policy reference                                        |
| `PENNY_MEMORY_MIGRATION_POLICY_REF`   | Caller-owned migration policy reference                                     |
| `PENNY_MEMORY_RETENTION_POLICY_REF`   | Caller-owned retention policy reference                                     |
| `PENNY_MEMORY_UNINSTALL_DISPOSITION`  | Must be `preserve`; code uninstall never mutates data                       |
| `PENNY_MEMORY_MCP_TOKEN_FILE`         | Owner-only, non-symlink bearer-token file                                   |
| `PENNY_MEMORY_MCP_TOKEN_ENV`          | Name of the owner-supplied environment variable containing the bearer token |
| `PENNY_MEMORY_REQUEST_TIMEOUT_MS`     | 100–30000 ms; default 10000                                                 |
| `PENNY_MEMORY_MAX_READ_ATTEMPTS`      | 1–3; retries apply only to safe idempotent reads                            |
| `PENNY_MEMORY_CURSOR_TTL_SECONDS`     | 30–900 seconds; default 300                                                 |
| `PENNY_MEMORY_MAX_RESPONSE_BYTES`     | Lower cap up to 16 MiB for an upstream HTTP response                        |
| `PENNY_MEMORY_SOURCE_CACHE_MAX_BYTES` | Bounded cache cap, 16–32 MiB; used only where upstream has no range API     |
| `PENNY_TOOL_RESULT_MAX_BYTES`         | Optional lower cap; hard maximum 32768                                      |
| `PENNY_TOOL_RESULT_MAX_CHARACTERS`    | Optional lower cap; hard maximum 32768                                      |
| `PENNY_TOOL_RESULT_MAX_TOKENS`        | Optional lower cap; hard maximum 8192 estimated tokens                      |

Exactly one token reference (`*_TOKEN_FILE` or `*_TOKEN_ENV`) is required in hub mode. Direct token configuration is intentionally unsupported. Cursor HMAC keys are domain-separated from the loaded bearer secret and never emitted.

`shared-trust-domain` means **whole-palace trust**: the bearer credential can access the entire configured palace. Wings, rooms, principal IDs, and routing headers are not ACLs. Use an isolated endpoint/root/credential or disable memory for any principal that is not trusted with all palace data.

## Primary tool bundles

During read-only qualification, write operations below are omitted while read operations—including duplicate checks and diary reads—remain available.

- **Recall read:** `memory_smart_search`, compatibility `memory_search`, `memory_get_drawer`, bounded `memory_list_drawers`, bounded `memory_get_taxonomy`
- **Curated write:** `memory_check_duplicate`, `memory_add_drawer`
- **Diary:** `memory_diary_read`, `memory_diary_write` (primary `penny` diary only)
- **KG read:** `memory_kg_query`, `memory_kg_timeline`, `memory_kg_stats`
- **KG write:** `memory_kg_add`, `memory_kg_invalidate`, `memory_kg_supersede`

Delete/bulk-delete, unrestricted enumeration, export, archive, backup, repair, migration, and retention apply are not model-visible.

## Primary advisory logstream

When `PENNY_MEMORY_LOGSTREAM_MODE=primary-advisory`, the extension adds exactly four tools:

- `memory_logstream_append`
- `memory_logstream_list`
- `memory_logstream_wait`
- `memory_logstream_ack`

Only `advisory.note`, `advisory.status`, `advisory.question`, and `advisory.reply` may be selected, with upstream event statuses, an 8,192-byte/character body bound, list limit at most 20, and wait timeout at most 5,000 ms. Append/list/wait pin the configured stream and `platformConfig.principalId`; acknowledgement first proves that same scope, then sends only the target ID and pinned sender. The model has no stream, sender, recipient, metadata, or artifact-ID argument. Rooms are schema- and runtime-limited to the configured allowlist. List/wait responses must match requested type, status, and anchor exclusion, with unique event IDs in strictly increasing positive sequence order.

Ack first performs one bounded, pinned event-list proof. The target ID must appear under the exact configured stream, sender/recipient principal, allowed room, and supplied correlation before the one-attempt upstream ack. An absent, ambiguous, over-bound, or mismatched proof rejects without acking. This surface is strictly self-addressed and not broadcast-capable; a raw upstream broadcast fails closed.

Bodies are bounded free-form advisory text and can technically contain arbitrary small text. Policy makes them non-authoritative: they are never consumed as artifact handoff, workflow state, a persistence receipt, or recovery input. Dedicated artifact/patch endpoints and refs are absent, as are live-stream, sync, replication, broadcast, and administration operations. The immutable artifact store remains the exact stage-output authority; the orchestration checkpointer remains the run-control and recovery authority. Workers and skill drivers receive no logstream tools or configuration. No heuristic body-content detection is performed.

Search defaults to summary/metadata candidates. `include_full`/`verbatim`, exact drawer reads, list, taxonomy, diary, KG queries, KG timelines, and advisory results all pass through the same final-envelope budget.

## Continuation and integrity

Every complete Pi tool result is measured after envelope construction. The tokenizer-independent estimate charges one token per serialized UTF-8 byte, so the unchanged 8,192 estimated-token hard cap permits at most 8,192 serialized bytes. Byte and character caps remain independent. The release minimum context headroom is 16,384 tokens; one conforming result consumes no more than half and leaves at least 8,192 tokens reserved after the result.

Oversized exact content returns:

- source digest and revision;
- total and returned UTF-8 byte counts;
- exact content range;
- `truncated: true`;
- an expiring opaque HMAC cursor bound to operation, primary session, query, filters, source, and next range.

Oversized structured results use exact UTF-8 fragments of the normalized JSON source. Concatenating fragments reassembles that source byte-for-byte. Invalid, wrong-caller, wrong-query, stale, evicted, changed-revision, and expired cursors fail with typed errors. Nothing is silently truncated. Summary shortening is explicitly labeled with original and returned byte metadata.

Upstream-ranged drawer-list responses are re-fetched and digest-checked on continuation. Operations without upstream ranges—including advisory event reads and write responses—use a bounded expiring source cache so continuation never replays writes or unrestricted calls. Advisory HTTP responses are independently capped at 512 KiB; append/ack make one mutation attempt, list alone may use at most one bounded safe retry, and wait remains one bounded request.

## Result telemetry

Metadata-only result events record tool/operation, request ID, serialized bytes, estimated tokens, release-headroom assessment, truncation, page, status, and duration. `compactionCorrelation` records `status: not_evaluated` and a session correlation key for later analysis. That field does not assert a live supported-model trial, a compaction outcome, or causation. Content, cursor values, credentials, and HMAC material are excluded.

## Typed failures

The adapter distinguishes unavailable, unauthorized, timeout, cancellation, conflict, invalid request, integrity, invalid cursor, stale cursor, expired cursor, and result-budget failures. Hub outages fail closed.

## KG governance

KG predicate schema **v1** is an exact allowlist implemented in `kg-policy.ts`, matching `docs/agents/memory/kg-patterns.md`. Add, invalidate, and supersede reject unknown predicates before HTTP dispatch.

## Automatic diary

Only the unmarked primary runtime with writes explicitly enabled installs effective shutdown-write behavior. It builds one bounded entry from content-free observability metadata, duplicate-checks it, writes at most once per session, logs metadata only, and tolerates observability or hub failure. Read-only qualification closes without a memory request. Worker and skill-driver processes make zero diary or KG shutdown calls.

## Tests

```bash
cd $PROJECT_ROOT/.pi/extensions/memory
bun run test:all
bun run test:e2e
```

All unit and integration suites are hermetic. The HTTP integration test uses an in-process fake MCP endpoint and never opens or mutates a palace.
