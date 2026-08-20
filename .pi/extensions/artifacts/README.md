# Artifacts Extension

Constrained, read-only model access to exact immutable artifacts granted by an execution owner. The extension implements the model-facing portion of GOV-02; it does not select, register, list, search, mutate, or recover artifacts.

Track-A dispatch control is separate. `PENNY_ARTIFACT_DISPATCH_MODE=paused` stops new workflow agent/tool/fan-out dispatch, but exact artifact reads from already granted refs remain available. Returning the mode to `active` uses forward-only checkpoint recovery; there is no semantic-memory fallback or payload injection.

Reusable owner helpers in `owner-client.ts` persist exact bytes through the TypeScript `ArtifactStore`, verify canonical refs, and reopen durable objects for chain projection. `handoff.ts` builds closed exact-ref grants and measures model-visible ref instructions with the shared result-budget helper. These owner helpers expose no model tool or enumeration surface.

## Tool

### `artifact_read`

Reads one exact artifact by immutable ID or full ref. A caller may supply an inclusive/exclusive UTF-8 byte range or reuse an opaque continuation cursor. `range` and `cursor` are mutually exclusive.

| Parameter  | Type                    | Required | Description                                                                                             |
| ---------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `artifact` | string or immutable ref | Yes      | Exact `art_<64hex>` ID or full canonical `ArtifactRef` v1                                               |
| `range`    | `{start, end?}`         | No       | UTF-8 byte range; both offsets must be code-point boundaries                                            |
| `cursor`   | string                  | No       | HMAC-authenticated opaque continuation from the same operation, caller, query, revision, and invocation |

There is deliberately no list, search, guess, prefix, wildcard, or grant parameter. IDs absent from the trusted grant set return `ARTIFACT_NOT_GRANTED` without probing storage.

## Trusted Invocation Contract

The execution owner supplies grants outside model arguments. A **worker** receives a per-spawn invocation snapshot in its process environment. Set exactly one of:

- `PENNY_ARTIFACT_INVOCATION_FILE`: absolute path to an owner-only (`0600`) regular JSON file; or
- `PENNY_ARTIFACT_INVOCATION_JSON`: JSON placed in the worker process environment by the owner.

Setting both is `ARTIFACT_CONFIG_INVALID`. Setting neither is the **primary runtime**, which resolves owner-held grants from the grant book described below. An empty value counts as absent.

The closed schema is:

```json
{
  "schema_version": 1,
  "caller": {
    "run_id": "run-id",
    "consumer_ref": "worker-ref",
    "invocation_id": "invocation-id"
  },
  "grants": [
    {
      "artifact": {
        "schema_version": 1,
        "artifact_id": "art_b560b5f57cbdbd936c9008bbbba76abccc0e396c67f93903b291c9a1a8491148",
        "run_id": "run-id",
        "phase": "phase",
        "branch_id": null,
        "kind": "agent-output",
        "operation_id": "operation-id",
        "version": 1,
        "producer": "producer-ref",
        "consumer_scope": ["worker-ref"],
        "media_type": "text/plain; charset=utf-8",
        "byte_length": 12,
        "content_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "store_ref": "artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "expires_at": "2026-01-01T00:15:00.000Z"
    }
  ]
}
```

This invocation snapshot is the narrow bridge from owner-selected directive refs. Each `artifact` is the exact canonical `ArtifactRef` v1, not a full manifest envelope. IDs are verified against the canonical identity tuple `(run_id, phase, branch_id, kind, operation_id, version)`; store path, digest, run, and consumer scope are then validated before bytes are returned. The snapshot carries only exact grants needed by the current worker and remains independent of manifest enumeration or database access.

## Owner Grant Book (primary runtime)

The unmarked primary runtime is the execution owner, so it has no spawn boundary on which to receive an invocation snapshot. Its grants are recorded by owner code in a grant book:

```text
$XDG_STATE_HOME/penny/artifact-grants/<sha256(session_id)[0:32]>.json   # 0600, directory 0700
```

The grant root is **deliberately outside `PENNY_ARTIFACT_ROOT`**, as a sibling of the `skill-chains` state root. The TypeScript artifact owner treats its root as a managed persistence boundary, so grant state belongs outside it. Override with `PENNY_ARTIFACT_GRANT_ROOT` (absolute).

Owner code (`owner-grants.ts`) appends a grant after it has already persisted and verified exact bytes — when a `subagent` delegation or `skill` run returns an artifact ref to the orchestrator. The model never writes the book and there is no tool that does.

Resolution is by **exact artifact ID only**. An ID absent from the book returns `ARTIFACT_NOT_GRANTED`, identically to an ungranted ID in a worker: the surface neither confirms nor denies that an artifact exists, so no enumeration or probing oracle is introduced.

Properties:

| Property            | Behavior                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Consumer identity   | `penny-primary:owner`, distinct from every worker vocabulary (`state:*`, `subagent-chain:*`)   |
| Scope authorization | The granted ref carries the owner consumer merged into canonical sorted `consumer_scope`       |
| Artifact identity   | Unchanged — identity hashes only the identity tuple, never `consumer_scope` or `producer`      |
| Content binding     | Unchanged — digest, byte length, store ref, and UTF-8 are verified exactly as for workers      |
| Run check           | Exact — the caller run is taken from the granted ref, so one session may read across runs      |
| Lifetime            | 24 hours per grant, bounded to the newest `512` grants; expired entries are dropped on write   |
| Isolation           | Book path derives from the session ID; another session's book is not consulted                 |
| Durability          | Survives compaction and process restart, so a ref stays readable after its inline copy is gone |

Because `validateGrant` compares a model-supplied full ref for exact equality against the grant, owner code surfaces the **granted** ref. Reading by bare `artifact_id` always works and is the simpler path.

## Object Store Contract

`PENNY_ARTIFACT_ROOT` may set an absolute artifact root. Otherwise the extension uses `$XDG_STATE_HOME/penny/artifacts`, or the platform home state directory when `XDG_STATE_HOME` is absent.

An artifact object is read only from the digest-derived path:

```text
$PENNY_ARTIFACT_ROOT/objects/sha256/<first-two-digest-chars>/<remaining-digest>
```

The configured root, object directories, and object must be owner-only filesystem objects; symbolic links and paths escaping the root fail closed. The extension verifies byte length, SHA-256, and strict UTF-8 before returning content. The only accepted `store_ref` is the canonical `artifact://sha256/<digest>` URI; the reader resolves that URI to the sharded relative object path shown above.

## Configuration

| Variable                                         | Default                                 | Constraint                                                      |
| ------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------- |
| `PENNY_ARTIFACT_ROOT`                            | platform/XDG state root                 | Absolute when supplied                                          |
| `PENNY_ARTIFACT_GRANT_ROOT`                      | `$XDG_STATE_HOME/penny/artifact-grants` | Absolute; must not be inside the artifact root                  |
| `PENNY_ARTIFACT_DISPATCH_MODE`                   | `active`                                | Owner dispatch mode; `paused` blocks new work, not reads        |
| `PENNY_ARTIFACT_INVOCATION_FILE`                 | none                                    | Mutually exclusive with JSON; absolute owner-only file          |
| `PENNY_ARTIFACT_INVOCATION_JSON`                 | none                                    | Mutually exclusive with file                                    |
| `PENNY_ARTIFACT_CURSOR_HMAC_KEY`                 | generated per process                   | Owner-supplied for workers; at least 32 bytes, hex or base64url |
| `PENNY_ARTIFACT_CURSOR_TTL_SECONDS`              | `900`                                   | 30–900; cannot raise the hard maximum                           |
| `PENNY_TOOL_RESULT_MAX_BYTES`                    | `32768`                                 | 512–32768; lower caps only                                      |
| `PENNY_TOOL_RESULT_MAX_CHARACTERS`               | `32768`                                 | 512–32768; lower caps only                                      |
| `PENNY_TOOL_RESULT_MAX_TOKENS`                   | `8192`                                  | 256–8192 estimated tokens; lower caps only                      |
| `PENNY_ARTIFACT_MATERIALIZATION_ENABLED`         | `false`                                 | Exact `true`/`false`                                            |
| `PENNY_ARTIFACT_MATERIALIZATION_THRESHOLD_BYTES` | `1048576`                               | 65536–1048576; lower threshold only                             |
| `PENNY_ARTIFACT_MATERIALIZATION_TTL_SECONDS`     | `900`                                   | 30–900                                                          |

`PENNY_ARTIFACT_CURSOR_HMAC_KEY` is not an operator setting. `handoff.ts` mints a fresh random key per worker invocation, and the primary runtime generates one per process when none is supplied. Pinning a long-lived static key would weaken cursor binding, not strengthen it.

Token budgeting charges one estimated token per serialized UTF-8 byte. This tokenizer-independent upper bound does not discount ASCII, escapes, multibyte content, or envelope framing, so the unchanged 8,192 estimated-token cap permits at most 8,192 serialized bytes. Byte, character, and estimated-token limits remain independent; the tighter configured limit wins. Budget checks measure the final serialized Pi tool-result envelope, including text framing, metadata, continuation, and error fields.

The release minimum context headroom is 16,384 tokens. Every conforming artifact result therefore consumes no more than half that minimum and leaves at least 8,192 tokens reserved after the result.

When protected materialization is enabled, an un-ranged read over the threshold returns an owner-only `file:` reference instead of inline content. The copy is placed under the configured artifact root, uses mode `0600`, expires no later than its grant, is scheduled for deletion at expiry, and is also covered by lazy cleanup during later materializations. Explicit range and cursor reads remain inline and bounded.

## Typed Results and Failures

Successful inline and materialization results include the complete canonical `ArtifactRef` v1, not an abbreviated locator. Inline results also include total bytes, requested and returned `[start,end)` byte ranges, digest, content, and either `continuation: null` or an HMAC-authenticated continuation. Pages end only on UTF-8 boundaries and can be concatenated byte-for-byte.

Typed failures include:

- `ARTIFACT_NOT_GRANTED`
- `ARTIFACT_WRONG_RUN`
- `ARTIFACT_WRONG_CONSUMER`
- `ARTIFACT_STALE`
- `ARTIFACT_MISSING`
- `ARTIFACT_DIGEST_MISMATCH`
- `ARTIFACT_ENCODING_INVALID`
- `ARTIFACT_RANGE_INVALID`
- `ARTIFACT_CURSOR_INVALID`
- `ARTIFACT_CURSOR_EXPIRED`
- `ARTIFACT_RESULT_BUDGET_EXCEEDED`
- `ARTIFACT_MATERIALIZATION_FAILED`
- `ARTIFACT_CONFIG_INVALID`

Structured telemetry contains metadata only: operation status, artifact ID/ref metadata, range sizes, digest, serialized bytes, estimated tokens, release-headroom assessment, timing, and error code. `compactionCorrelation` carries `status: not_evaluated` plus run/artifact metadata keys for later correlation; it is not a claim that a live model trial ran or that no later compaction occurred. Telemetry never logs artifact content, invocation JSON, grant contents, HMAC keys, or cursor values.

## Testing

```bash
bun run --cwd .pi/extensions/artifacts test:all
# Individual gates:
bun run --cwd .pi/extensions/artifacts lint
bun run --cwd .pi/extensions/artifacts format:check
bun run --cwd .pi/extensions/artifacts typecheck
bun run --cwd .pi/extensions/artifacts test:unit
bun run --cwd .pi/extensions/artifacts test:integration
```
