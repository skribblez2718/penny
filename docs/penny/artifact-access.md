# Artifact Access

Read when a delegation returns an artifact ref and the exact output matters, or
when an `artifact_read` call fails.

## What the channel is

Exact agent output is persisted by the execution owner as an immutable artifact
before any summary is parsed. The artifact is the authority; the text in the tool
result is a convenience copy or a bounded preview.

MemPalace is **not** this channel. It is durable curated memory. It is not a
communication path, not workflow handoff, and not artifact storage.

## What you receive

| Delegation                      | In the tool result                                        | Ref location                                 |
| ------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| `subagent` single               | Full final output inline                                  | `details.outputArtifactRefs[0]`              |
| `subagent` parallel             | **100-character preview per agent** \u2014 not the output | `details.outputArtifactRefs[]`, one per task |
| `subagent` chain                | Final step output inline                                  | `details.outputArtifactRefs[]` in step order |
| `skill` (single/chain/parallel) | Final result plus a bounded preview                       | `details.output_artifact_ref`                |

Parallel mode is the case that most often needs a read: the previews are
truncated at 100 characters, so any real comparison of agent outputs requires
reading the refs.

## Reading

Pass the `artifact_id` string \u2014 the simple, always-correct path:

```text
artifact_read({ artifact: "art_<64 hex>" })
```

Passing a full ref object also works, but it must be the **exact** ref you were
handed; a modified ref is rejected as `ARTIFACT_STALE`.

Large artifacts return `continuation`. Follow it until `continuation` is null if
you need the whole document; a single bounded page is often enough.

## When to read

Read when the full text changes what you do: verifying a specific claim,
integrating multiple agent outputs, quoting exactly, or recovering detail after
compaction dropped the inline copy.

Do not bulk-read every ref by reflex. Each read consumes context against the same
32 KB / 8,192-estimated-token result budget as any other tool result.

## Failure codes

| Code                       | Meaning                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `ARTIFACT_NOT_GRANTED`     | The ID is not in this session's grant book. Expected for another session's or an invented ID. |
| `ARTIFACT_STALE`           | The grant expired (24 h) or the supplied ref does not exactly match the granted ref.          |
| `ARTIFACT_MISSING`         | The manifest entry exists but the object is gone \u2014 report it; do not retry.              |
| `ARTIFACT_DIGEST_MISMATCH` | Content failed verification. Treat as corruption and report it.                               |
| `ARTIFACT_CONFIG_INVALID`  | The runtime is misconfigured. Not retryable; report it.                                       |

There is deliberately no list, search, or discovery surface. You can only read
refs the execution owner handed you in this session. If you do not have a ref,
the answer is to re-run the delegation, not to go looking.

## Where it lives

Grants are recorded in an owner-only grant book under
`$XDG_STATE_HOME/penny/artifact-grants/`, keyed by session, and survive
compaction and restart. It is deliberately outside the artifact root, which the
artifact stores claim exclusively. Implementation contract:
`.pi/extensions/artifacts/README.md`.
