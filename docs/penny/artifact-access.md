# Artifact Access Protocol

Run this protocol when exact delegation/skill output must be read or forwarded.
Artifacts are ordinary internal communication addresses, not grants or durable memory.

## Result contract

Every successful producer persists its complete final assistant bytes, re-reads them, and
prints the exact `art_<64 hex>` ID in model-visible result text.

| Mode                | Result text                                    |
| ------------------- | ---------------------------------------------- |
| `subagent` single   | Complete output plus one exact-output ID       |
| `subagent` parallel | Bounded preview plus one labeled ID per branch |
| `subagent` chain    | Final output plus every step ID in order       |
| `skill`             | Terminal result plus exact terminal ID(s)      |

A success without a readable ID is a communication failure, not a best-effort success.

## Read on demand

```text
artifact_read({ artifact: "art_<id>" })
```

If `truncated` is true, repeat with the returned non-expiring range:

```text
artifact_read({ artifact: "art_<id>", range: { start: <next>, end: <end> } })
```

Continue until `truncated` is false. Verify the returned ID and digest when exact identity
matters. Do not bulk-read outputs when previews are sufficient.

## Forward exact work

Pass producer IDs through `input_artifacts` rather than re-running the producer or pasting
payload text:

```text
subagent({
  agent: "synthia",
  task: "Integrate the supplied findings.",
  input_artifacts: ["art_<annie>", "art_<carren>"]
})
```

IDs may come from different agents, runs, sessions, or parallel branches. Owner code
performs exact manifest lookup plus digest/length verification before spawn. There is no
same-run restriction or fixed ID-count cap; for very large fan-in, pass one handoff-index
artifact.

Chain mode inserts the prior step ID automatically and accepts additional explicit IDs on
each step. Skill chains forward the prior terminal ID directly across runs.

## Missing input

There is no list/search/discovery operation. If a required predecessor ID or explicit file
path is absent, report `missing_input:`. Do not search memory, `/tmp`, the repository, or
old sessions for a name such as “the Annie review.” Memory is durable curated recall, not
work-product transport.

## Errors

| Code                              | Meaning                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `ARTIFACT_INVALID_ID`             | The ID shape is invalid.                                  |
| `ARTIFACT_MISSING`                | No canonical manifest row/object exists for the exact ID. |
| `ARTIFACT_DIGEST_MISMATCH`        | Immutable bytes do not match the manifest.                |
| `ARTIFACT_ENCODING_INVALID`       | The artifact is not valid UTF-8 for this read surface.    |
| `ARTIFACT_RANGE_INVALID`          | The requested byte range is invalid or splits UTF-8.      |
| `ARTIFACT_CONFIG_INVALID`         | Canonical store configuration/integrity is invalid.       |
| `ARTIFACT_RESULT_BUDGET_EXCEEDED` | No bounded result envelope can fit.                       |

Implementation contract: `.pi/extensions/artifacts/README.md`.
