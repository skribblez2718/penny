# Outcome Ledger — Record predictions, compare results, learn from gaps

## What

Before any consequential action, record what you expect to happen. After the action, compare the actual outcome against the prediction. Use the delta to improve future decisions.

## Why

Closes the feedback loop between prediction and result. Without it, Penny repeats the same mistakes because there's no mechanism to learn from mismatches.

## Rules

1. **Record before acting.** Write the prediction to mempalace before executing any action where confidence ≤ POSSIBLE, the action modifies files, or the action is irreversible.
2. **Classify the domain.** Tag every record with one of: `coding`, `planning`, `research`, `communication`, `learning`, `events`, `decision`, `other`.
3. **Review MISMATCHes before consequential decisions.** Search `penny/outcomes` for `delta_score: MISMATCH` before any action that could repeat a past failure.
4. **Close open records at session end.** Write `actual_outcome` and `delta_score` for any record still open.

## Procedure

### Recording a decision

1. Derive session ID: `session_YYYY-MM-DD_NNN`
2. Derive decision ID: `decision_YYYY-MM-DD_NNN`
3. Write to mempalace:
   ```
   memory_add_drawer(wing="penny", room="outcomes", content={
     decision_id, session_id, action_taken, expected_outcome,
     confidence_at_action, domain, timestamp
   })
   ```
4. Link to knowledge graph: `memory_kg_add("Penny", "decided", "Decision:<id>")`

### Capturing feedback

After a consequential task, present the outcome to the user via questionnaire with MATCH / PARTIAL / MISMATCH options. On response, write `actual_outcome`, `delta_score`, and add `evaluated` KG predicate.

### Pre-turn injection

Before each turn, search for recent MISMATCHes:
```
memory_smart_search(query="outcome MISMATCH", wing="penny", room="outcomes", limit=5)
```

## Constraints

- **Never skip recording for irreversible actions.** The ledger is the only mechanism for learning from mistakes.
- **Never claim CERTAIN for predictions about external systems.** User behavior, API responses, and tool outputs are inherently uncertain.
- **Rolling window for pre-turn injection:** last 10 entries or last 7 days, whichever is smaller.

## Delta Scores

| Score | Meaning |
|-------|---------|
| **MATCH** | Actual outcome closely matched expected outcome |
| **PARTIAL** | Core prediction held but aspects differed |
| **MISMATCH** | Outcome was significantly different than expected |

## Verification

- [ ] Decision recorded before every file modification
- [ ] MISMATCHes reviewed before consequential actions
- [ ] Open records closed at session end
- [ ] ≥3 MISMATCH in same domain over 7 days → triggers amendment proposal

## Files

| File | Purpose |
|------|---------|
| `scripts/system/outcome_ledger/` | Schema, ledger operations, tests |
| `docs/agents/capabilities/outcome-ledger/outcome-ledger.md` | Agent operational guide |
| `docs/humans/capabilities/outcome-ledger/outcome-ledger.md` | Human-facing overview |
