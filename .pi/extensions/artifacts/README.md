# Artifacts Extension

Constrained, read-only model access to exact immutable artifacts granted by an execution owner. The extension implements the model-facing portion of GOV-02; it does not select, register, list, search, mutate, or recover artifacts.

Track-A dispatch control is separate. `PENNY_ARTIFACT_DISPATCH_MODE=paused` stops new workflow agent/tool/fan-out dispatch, but exact artifact reads from already granted refs remain available. Returning the mode to `active` uses forward-only checkpoint recovery; there is no semantic-memory fallback or payload injection.

Reusable owner helpers in `owner-client.ts` persist exact bytes through `orchestration.artifact_cli`, verify canonical refs, reopen durable objects for chain projection, and resolve only caller/platform-derived paths. `handoff.ts` builds closed exact-ref grants and measures model-visible ref instructions with the shared result-budget helper. These owner helpers expose no model tool or enumeration surface.

## Tool

### `artifact_read`

Reads one exact artifact by immutable ID or full ref. A caller may supply an inclusive/exclusive UTF-8 byte range or reuse an opaque continuation cursor. `range` and `cursor` are mutually exclusive.

| Parameter  | Type                    | Required | Description                                                                                             |
| ---------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `artifact` | string or immutable ref | Yes      | Exact `art_<64hex>` ID or full canonical Python `ArtifactRef` v1                                        |
| `range`    | `{start, end?}`         | No       | UTF-8 byte range; both offsets must be code-point boundaries                                            |
| `cursor`   | string                  | No       | HMAC-authenticated opaque continuation from the same operation, caller, query, revision, and invocation |

There is deliberately no list, search, guess, prefix, wildcard, or grant parameter. IDs absent from the trusted grant set return `ARTIFACT_NOT_GRANTED` without probing storage.

## Trusted Invocation Contract

The execution owner supplies grants outside model arguments. Set exactly one of:

- `PENNY_ARTIFACT_INVOCATION_FILE`: absolute path to an owner-only (`0600`) regular JSON file; or
- `PENNY_ARTIFACT_INVOCATION_JSON`: JSON placed in the worker process environment by the owner.

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

This invocation snapshot is the narrow bridge from owner-selected directive refs. Each `artifact` is the exact canonical Python `ArtifactRef` v1, not a full manifest envelope. IDs are verified against the canonical identity tuple `(run_id, phase, branch_id, kind, operation_id, version)`; store path, digest, run, and consumer scope are then validated before bytes are returned. The snapshot carries only exact grants needed by the current worker and remains independent of manifest enumeration or database access.

## Object Store Contract

`PENNY_ARTIFACT_ROOT` may set an absolute artifact root. Otherwise the extension uses `$XDG_STATE_HOME/penny/artifacts`, or the platform home state directory when `XDG_STATE_HOME` is absent.

An artifact object is read only from the digest-derived path:

```text
$PENNY_ARTIFACT_ROOT/objects/sha256/<first-two-digest-chars>/<remaining-digest>
```

The configured root, object directories, and object must be owner-only filesystem objects; symbolic links and paths escaping the root fail closed. The extension verifies byte length, SHA-256, and strict UTF-8 before returning content. The only accepted `store_ref` is Python's canonical `artifact://sha256/<digest>` URI; the reader resolves that URI to the sharded relative object path shown above.

## Configuration

| Variable                                         | Default                 | Constraint                                               |
| ------------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| `PENNY_ARTIFACT_ROOT`                            | platform/XDG state root | Absolute when supplied                                   |
| `PENNY_ARTIFACT_DISPATCH_MODE`                   | `active`                | Owner dispatch mode; `paused` blocks new work, not reads |
| `PENNY_ARTIFACT_INVOCATION_FILE`                 | none                    | Mutually exclusive with JSON; absolute owner-only file   |
| `PENNY_ARTIFACT_INVOCATION_JSON`                 | none                    | Mutually exclusive with file                             |
| `PENNY_ARTIFACT_CURSOR_HMAC_KEY`                 | none                    | Required; at least 32 bytes, hex or base64url            |
| `PENNY_ARTIFACT_CURSOR_TTL_SECONDS`              | `900`                   | 30–900; cannot raise the hard maximum                    |
| `PENNY_TOOL_RESULT_MAX_BYTES`                    | `32768`                 | 512–32768; lower caps only                               |
| `PENNY_TOOL_RESULT_MAX_CHARACTERS`               | `32768`                 | 512–32768; lower caps only                               |
| `PENNY_TOOL_RESULT_MAX_TOKENS`                   | `8192`                  | 256–8192 estimated tokens; lower caps only               |
| `PENNY_ARTIFACT_MATERIALIZATION_ENABLED`         | `false`                 | Exact `true`/`false`                                     |
| `PENNY_ARTIFACT_MATERIALIZATION_THRESHOLD_BYTES` | `1048576`               | 65536–1048576; lower threshold only                      |
| `PENNY_ARTIFACT_MATERIALIZATION_TTL_SECONDS`     | `900`                   | 30–900                                                   |

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
