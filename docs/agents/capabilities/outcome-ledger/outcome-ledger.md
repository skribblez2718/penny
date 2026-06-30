# Outcome Ledger — Record decisions, compare results, learn from gaps

## What

Before any consequential action, record what you expect. After, compare actual vs. expected. Use the delta to improve future decisions.

## Why

Without a feedback loop, Penny repeats mistakes. The ledger closes the gap between prediction and result.

## Rules

1. **Record before acting** when confidence ≤ POSSIBLE, the action modifies files, or the action is irreversible.
2. **Classify every record** by domain: `coding`, `planning`, `research`, `communication`, `learning`, `events`, `decision`, `other`.
3. **Review MISMATCHes before consequential decisions.** Search `penny/outcomes` for `delta_score: MISMATCH` before any action that could repeat a past failure.
4. **Close open records at session end.** Write `actual_outcome` and `delta_score` for any record still open.

## Procedure

### Record a decision
1. Derive session ID: `session_YYYY-MM-DD_NNN`
2. Derive decision ID: `decision_YYYY-MM-DD_NNN`
3. Write to mempalace: `memory_add_drawer(wing="penny", room="outcomes", content={decision_id, session_id, action_taken, expected_outcome, confidence_at_action, domain, timestamp})`
4. Link to KG: `memory_kg_add("Penny", "decided", "Decision:<id>")`

### Capture feedback
After a consequential task, present outcome to user via questionnaire with MATCH / PARTIAL / MISMATCH options. On response, write `actual_outcome`, `delta_score`, and add `evaluated` KG predicate.

### Pre-turn injection
Before each turn: `memory_smart_search(query="outcome MISMATCH", wing="penny", room="outcomes", limit=5)`

## Delta Scores

| Score | Meaning |
|-------|---------|
| MATCH | Outcome matched expectation |
| PARTIAL | Core prediction held; aspects differed |
| MISMATCH | Outcome significantly different than expected |

## Constraints

- **Never skip recording for irreversible actions.**
- **Never claim CERTAIN for predictions about external systems.**
- **Rolling window:** last 10 entries or last 7 days, whichever is smaller.
- **≥3 MISMATCH in same domain over 7 days** → triggers amendment proposal.

## Verification

- [ ] Decision recorded before every file modification
- [ ] MISMATCHes reviewed before consequential actions
- [ ] Open records closed at session end

## Files

| File | Purpose |
|------|---------|
| `scripts/system/outcome_ledger/` | Schema, operations, tests |
| `docs/agents/architecture/outcome-ledger.md` | Architecture reference |
