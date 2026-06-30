# Outcome Ledger

## What It Is

A persistent record of Penny's consequential actions and their actual outcomes. Each entry captures: what was done, what was expected, what actually happened, and the delta between them.

## Why It Matters

Without feedback, Penny makes decisions in a vacuum. The outcome ledger provides the "scar tissue" that influences future behavior — a proxy for reputation and stake in outcomes. Rule 7 in SYSTEM.md requires checking recent MISMATCHs before consequential actions.

## Schema

Each ledger entry is stored in mempalace (`wing=penny`, `room=outcomes`):

| Field                  | Required | Description                      |
| ---------------------- | -------- | -------------------------------- |
| `decision_id`          | Yes      | Unique ID; links to KG           |
| `action_taken`         | Yes      | What Penny did                   |
| `expected_outcome`     | Yes      | What Penny predicted             |
| `actual_outcome`       | No\*     | What actually happened           |
| `delta_score`          | No\*     | `MATCH` / `PARTIAL` / `MISMATCH` |
| `confidence_at_action` | Yes      | Confidence at time of action     |
| `timestamp`            | Yes      | ISO-8601                         |

\*Populated after completion.

## Write Path

When Penny takes a consequential action (confidence ≤ `POSSIBLE` or high stakes):

1. Write initial record to mempalace
2. After completion, populate `actual_outcome` and `delta_score`
3. Add KG `evaluated` predicate

## Read Path (Behavioral Influence)

Before key decisions, Penny loads recent outcomes:

```python
memory_smart_search(
    query="outcome ledger recent MISMATCH",
    wing="penny", room="outcomes", limit=5
)
```

- MISMATCH outcomes are injected as explicit warnings in context
- Domain-specific patterns surface automatically
- Rolling window: last 10 entries or 7 days

## Feedback Capture

For consequential actions, Penny asks the user:

> "Did the outcome match what I expected?"
>
> - ✅ Yes (MATCH)
> - ⚠️ Partially (PARTIAL)
> - ❌ No (MISMATCH)

If the user doesn't respond, Penny auto-populates from observable signals.

## Files

- Agent docs: `docs/agents/outcome-ledger.md`
- Design: `plans/ai-gaps-resolution/02-designs/04-outcome-ledger.md`
- Implementation: `scripts/system/outcome_ledger/`
- Tests: `scripts/system/outcome_ledger/tests/` (17 tests)
