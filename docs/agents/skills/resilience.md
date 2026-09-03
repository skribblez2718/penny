# Skill Resilience — Error handling and recovery on the engine

## What

Skills run on the shared orchestration engine. State survives crashes via the engine's **durable SQLite checkpointer keyed by `run_id`**—not a hand-written session file. The active registration validates worker results and declares repair routes; a playbook classifies valid domain gaps and maintains bounded domain bookkeeping. The engine owns repair budgets/transitions and crash recovery.

## Why

The skill extension composes the engine and Pi SDK workers in-process. The engine persists a
checkpoint after each accepted step, so an interrupted run reissues its exact pending directive on
`recover`—no state is reconstructed from prose and no completion is faked. A playbook must make
each state **safe to re-run** and honest about what happened.

## Rules

1. **State is checkpointed by the engine.** Every step is persisted against `run_id`. There is no `/tmp/<skill>-<session_id>.json` to write and no `extract_state`/`restore_state` round-trip to maintain.
2. **Crash-resume is exact.** An interrupted run reissues its checkpointed directive through `recover` with the same selected artifact refs. Design each state's work to be idempotent so reissue is harmless.
3. **Validate before routing.** The active phase result contract rejects empty, malformed, or missing routing fields. Structural failure enters the bounded P1.2 routing-only correction/liveness path; it is never treated as a semantic repair.
4. **Do not default invalid fields.** Missing or invalid routing data fails closed. Safe defaults belong only in explicitly optional domain fields and must never turn absence into success.
5. **Route valid gaps through the engine.** `EvaluationResultV2` carries kind, bounded detail/findings, and a non-empty strategy delta. It carries no target or exhaustion claim. The engine selects the unique registered state/kind route and charges `used + 1 <= max_iterations - reserved_attempts`.
6. **Report loop exhaustion honestly.** The registered exhaustion successor preserves unresolved work and reaches an honest `incomplete/met:false` or later gated outcome; it never fabricates success.
7. **Escalate a spinning loop.** Repeated issues without measurable progress pause for clarification where the playbook declares that behavior rather than burning the global step budget.

## Error / recovery behavior

| Situation                             | Behavior                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Agent SUMMARY structurally malformed  | P1.2 routing-only correction; identical/error/liveness budgets terminalize honestly               |
| Structurally valid domain gap         | Engine resolves registered state/kind route, charges budget, records digest-only evidence         |
| Agent returns `confidence: UNCERTAIN` | Playbook clarification policy may pause at `awaiting_clarification`; exact `respond` resumes      |
| Parallel branch failure               | Accepted siblings remain durable; only missing/malformed work is reissued or terminalized         |
| Session interruption mid-step         | Engine reissues the exact pending directive from the last checkpoint on `recover`                 |
| Owner dispatch mode paused/invalid    | Typed `paused`, non-terminal/retriable; no agent/tool/fan-out dispatch or checkpoint/ref mutation |
| Retry budget exhausted                | Registered exhaustion route; terminal truth remains `incomplete/met:false` unless later admitted  |
| Planned gate denied                   | Route to the playbook's declared honest negative terminal                                         |

## Constraints

- **Never fake completion.** No error or exhaustion path may report success.
- **The checkpointer is the source of truth for run state** — not an artifact payload, durable memory, or a temp file. Exact stage bytes live in owner artifacts; compact state and selected refs live in the checkpointer keyed by `run_id`.
- **Make steps idempotent.** A re-issued step must not double-apply side effects.
- **Forward recovery only for Track A.** The owner sets `PENNY_ARTIFACT_DISPATCH_MODE=active|paused` (default active; unknown fails closed). Paused runs keep status and exact artifact reads available. Reactivation uses fresh-process recovery with the same pending refs/metadata; there is no semantic-memory fallback.

## Verification

- [ ] Structural contract violations stay on the bounded P1.2 path and never advance as semantic repair
- [ ] Valid-gap evaluations reject target/exhaustion fields and registered routes execute in the engine
- [ ] Route events contain only hashes/counters; observability-off execution has identical workflow truth
- [ ] Loop exhaustion follows the declared successor and never emits a false positive
- [ ] UNCERTAIN / stalled loops escalate to `awaiting_clarification` where declared
- [ ] A killed run resumes correctly via `recover` (covered by a playbook test)
- [ ] Pause/unpause leaves artifact manifest/object hashes and memory sentinel unchanged and reissues identical pending refs

## Related Documents

- [Loops](loops.md) — Agentic loop taxonomy, termination controls, failure modes, and verifier design
- [Orchestration](orchestration.md) — Engine-backed skill protocol
- [Skill Standard](skill-standard.md) — Full skill standard
- [Testing](testing.md) — Playbook test requirements
