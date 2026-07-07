# Weekly Digest

## What It Is

A weekly accountability summary that aggregates Penny's structured decision outcomes, confidence levels, attention flags, and pending items into a human-readable digest.

## How It Works

```
Week boundary (Monday)
    ↓
Session start checker queries penny/digests
    ↓
If digest exists for current week → present (conditional)
    ↓
If no digest → query mempalace and generate digest JSON
    ↓
Store in penny/digests (T3, permanent reference)
    ↓
Present to user (inline if attention flags, teaser otherwise)
```

## Digest Content

| Section         | Source             | Description                                                     |
| --------------- | ------------------ | --------------------------------------------------------------- |
| Summary         | Outcomes + Diary   | Sessions, decisions, actions                                    |
| Outcomes        | Outcome ledger     | MATCH/PARTIAL/MISMATCH breakdown                                |
| Confidence      | Outcome ledger     | CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN distribution                |
| Attention Flags | Outcomes + Signals | Patterns requiring review (MISMATCH clusters, CRITICAL signals) |
| Amendments      | System amendments  | Proposed/approved/rejected/pending counts                       |
| Pending Signals | Signals room       | Critical and info signal counts                                 |
| Recommendations | Derived            | Actionable suggestions from patterns                            |
| Correlation IDs | Outcomes           | Session IDs for observability server cross-reference            |

## Presentation Rules

| Condition                                       | Presentation                                   |
| ----------------------------------------------- | ---------------------------------------------- |
| Digest has attention flags (MISMATCH, CRITICAL) | Full inline digest with attention section      |
| Digest has no attention flags                   | One-line teaser only                           |
| No digest generated yet                         | Nothing shown (digest generated in background) |

## Observability Correlation

Every digest includes `session_ids` — a list of all session IDs that contributed to the week's data. This allows correlation with the observability server (`.pi/extensions/observability/`) when troubleshooting specific decisions.

## Safety

- **Read-only aggregation** — digest never modifies mempalace data
- **No observability server changes** — orthogonal system
- **No audit logging added** — observability extension already handles per-message audit
- **No SYSTEM.md changes** — purely a reporting feature
- **Tier aligned** — digests stored in `penny/digests` (T3, permanent reference)

## Files

| File                                               | Purpose                                       |
| -------------------------------------------------- | --------------------------------------------- |
| `scripts/system/digest/generator.py`               | Aggregate mempalace data into structured JSON |
| `scripts/system/digest/renderer.py`                | Render digest JSON to markdown                |
| `scripts/system/digest/storage.py`                 | Store/retrieve digest in mempalace            |
| `scripts/system/watchers/session_start_checker.py` | Query and present digest at session start     |

## Trigger

- Calendar week boundary (first session of the week)
- Explicit user request ("weekly summary", "digest")
- MISMATCH signal detection (opportunistic generation)

## Rollback

- Stop generation: remove trigger from `session_start_checker.py`
- Delete digests: `memory_delete_drawers_by_room(wing="penny", room="digests")`
