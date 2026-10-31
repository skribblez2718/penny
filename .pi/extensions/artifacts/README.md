# Artifacts Extension

Immutable artifact IDs are Penny's exact internal communication addresses. They are not
bearer permissions, grants, or session-bound capabilities.

## Model-facing read

```json
{
  "artifact": "art_<64 lowercase hex>",
  "range": { "start": 0, "end": 48000 }
}
```

For textual media, `range` is optional and uses UTF-8 byte offsets in `[start,end)` form.
A bounded result returns `next_range` when more bytes remain; repeat the call with that
range until `truncated` is false. Text wire output is unchanged. Ranges and IDs do not
expire.

For canonical `image/png`, omit `range`. The tool revalidates the complete static PNG and
returns one bounded JSON metadata text block followed by one Pi image block. Metadata
contains the exact ID, digest, media type, byte length, and dimensions. Base64 exists only
inside the image block's `data` field; it is absent from text, details, logs, and durable
state. Stored PNGs are validated, never rewritten during delivery.

Other binary media, noncanonical PNGs, and range-on-image requests fail closed. There is no
list, search, wildcard, prefix, cursor, materialization, or write operation.
Callers receive exact IDs from `subagent`, `skill`, or a current-session handoff index.

## Store

The store is bound to the current opaque Penny project partition:

```text
${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}/
  projects/<opaque-project-id>/artifacts/
    manifest.db
    objects/sha256/<prefix>/<digest remainder>
```

`ArtifactStore.refById()` performs indexed exact lookup. `readById()` reads the
content-addressed object and verifies its SHA-256 digest and byte length. The manifest
stores the owning opaque project ID and refuses a different project binding.

Owner/mode and path-containment checks remain filesystem-integrity hygiene; they do not
distinguish Penny from her same-user workers.

Schema-v2 refs retain lineage (`run_id`, phase, branch, kind, operation/version, producer,
media type, length, digest, and store URI) and contain no consumer/access field. Temporary
schema-v1 wire normalization remains only for retained checkpoint conversion and is not a
state-path fallback.

Ordinary construction never scans or imports `manifest.sqlite3` or `manifest-v2.db`.
Legacy rows and objects must be reconciled by the explicit operator migration workflow
before the target-only runtime is deployed.

## Persistence contract

Agent and skill outputs are persisted automatically by owner code. A successful producer
result is returned only after manifest persistence and immediate byte-for-byte re-read.
Every result prints its exact artifact ID in model-visible text; previews and summaries are
not the authoritative output.

Inputs are unique exact IDs from any run in the current project partition. Owner code
verifies existence and integrity before worker spawn. Cross-run and multi-source fan-in are
supported; cross-project lookup fails closed.

## PNG safety contract

The shared orchestration PNG codec fully inflates and unfilters pixels under source,
compressed, decompressed, dimension, pixel, and ancillary-data limits. It accepts static,
non-interlaced 8-bit grayscale/RGB with optional alpha. Backend admission canonicalizes to
metadata-free RGBA with one IDAT; artifact delivery accepts only that canonical shape.
APNG, palettes, unknown critical chunks, malformed CRC/DEFLATE/filter data, trailing data,
and limit violations reject.

The implementation uses Node's built-in `node:zlib` and adds no image-decoder package. See
`docs/agents/architecture/binary-artifacts.md` for the dependency/license/advisory posture,
canonicalization rationale, and model capability boundary.

## Errors

- `ARTIFACT_INVALID_ID`
- `ARTIFACT_MISSING`
- `ARTIFACT_DIGEST_MISMATCH`
- `ARTIFACT_ENCODING_INVALID`
- `ARTIFACT_RANGE_INVALID`
- `ARTIFACT_RANGE_UNSUPPORTED`
- `ARTIFACT_MEDIA_UNSUPPORTED`
- `ARTIFACT_IMAGE_INVALID`
- `ARTIFACT_IMAGE_NOT_CANONICAL`
- `ARTIFACT_IMAGE_LIMIT_EXCEEDED`
- `ARTIFACT_CONFIG_INVALID`
- `ARTIFACT_RESULT_BUDGET_EXCEEDED`

## Configuration

| Variable                              | Meaning                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `PENNY_STATE_ROOT`                    | Optional absolute Penny state root; defaults below Pi home |
| Shared tool-result budget variables   | Bound serialized textual result metadata                   |
| `PENNY_PNG_MAX_SOURCE_BYTES`          | Lower canonical PNG source-byte ceiling                    |
| `PENNY_PNG_MAX_WIDTH`                 | Lower PNG width ceiling                                    |
| `PENNY_PNG_MAX_HEIGHT`                | Lower PNG height ceiling                                   |
| `PENNY_PNG_MAX_PIXELS`                | Lower PNG pixel-count ceiling                              |
| `PENNY_PNG_MAX_COMPRESSED_BYTES`      | Lower aggregate IDAT ceiling                               |
| `PENNY_PNG_MAX_DECOMPRESSED_BYTES`    | Lower inflated-scanline ceiling                            |
| `PENNY_PNG_MAX_ANCILLARY_CHUNK_BYTES` | Lower per-ancillary-chunk ceiling                          |
| `PENNY_PNG_MAX_ANCILLARY_BYTES`       | Lower aggregate ancillary-data ceiling                     |

`PENNY_ARTIFACT_ROOT`, `PENNY_ARTIFACT_GRANT_ROOT`, and XDG artifact fallback are retired
and rejected. No artifact-specific grant, invocation, HMAC, cursor, TTL, or materialization
variables exist.

## Obsolete-state maintenance

After explicit manifest migration and object verification, an operator may archive old
grant state with the dry-run-by-default generic command:

```bash
python scripts/system/maintenance/archive_artifact_grants.py \
  --artifact-root <canonical-artifact-root> \
  --grant-root <obsolete-grant-root> \
  --archive-path <archive-destination>
# repeat with --apply after reviewing the verification output
```

The command never deletes canonical artifact objects.
