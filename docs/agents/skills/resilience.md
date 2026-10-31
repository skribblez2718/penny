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
3. **Validate before routing.** The active phase result contract rejects empty, malformed, or missing routing fields. Structural failure enters the separate P1.2 routing-only correction/liveness path; it is never treated as a semantic repair.
4. **Do not default invalid fields.** Missing or invalid routing data fails closed. Safe defaults belong only in explicitly optional domain fields and must never turn absence into success.
5. **Route valid gaps through the engine.** `EvaluationResult` carries kind, bounded detail/findings, and a non-empty strategy delta. It carries no target or exhaustion claim. The engine selects the unique registered state/kind route and applies actual operator-supplied repair limits and reservations when present; unspecified limits do not authorize invented defaults.
6. **Report loop exhaustion honestly.** The registered exhaustion successor preserves unresolved work and reaches an honest `incomplete/met:false` or later gated outcome; it never fabricates success.
7. **Stop measured recurrence honestly.** Opted-in exact fingerprint recurrence stops incomplete before another repair; other stall/clarification handling remains playbook-specific. Unmeasurable work is not evidence of a stall. See [exact repair recurrence](loops.md#exact-repair-recurrence).
8. **Repair the reviewed product, not a reconstruction.** Pass the exact latest sealed product, its draft, and relevant latest review reports through intermediate analysis/evidence phases to the repair author. Reviewers receive historical feedback for regression checking, but must independently validate the new product in the skill's registered order; earlier approvals never approve a later revision. Fix the whole supported defect class without inventing new caller requirements or relaxing valid acceptance criteria. Derive values from actual operator policy, not test constants or model guesses. Seal corrections and semantic-review repairs follow their separate actual operator policies; neither requires a finite allowance when none is supplied. A successful seal closes the epoch, so a reviewer-requested replacement cannot receive old seal feedback as current instructions.
9. **Expose exact failure diagnostics.** Every seal rejection persists/re-reads a `SealDiagnosticV1` bound to its exact rejected draft, same-run epoch anchor, policy and predecessor; even the final rejection needs its own diagnostic before an honest incomplete terminal. The new `seal_product` and `seal_diagnostic` operations are separately draft-addressed at version 1, not incremented as a run-global product/feedback revision. Recovery adopts exact bytes or faults on conflict; an artifact write is not completion. Negative result `seal_diagnostics` names the latest diagnostic, rejected draft, anchor, used/limit and disposition; a rejected draft in a legacy output-ref position is labeled as such, not a canonical accepted product. `best_partial_artifact_refs` may separately name an earlier accepted product. When a typed semantic repair exhausts, the engine binds distinct `repair_diagnostics` to current feedback reports, origin/kind and budget. No raw body or artifact discovery is used; historical terminals are not rewritten.

## Preserve review judgment

A catalog phase may opt into `routing_repair_policy: "preserve_source_summary_v1"`.
The engine independently validates the exact source artifact's final SUMMARY against the
phase schema before routing-only correction. A correction must preserve **all details and
confidence**, not just the verdict. Unpreservable source judgment stops incomplete with
`source_summary_unpreservable` before futile correction dispatch; a changed proposed judgment
is also refused. The shared policy does not infer verdicts from prose or alter unopted phases.
Produce retains its stronger immutable review-core, assignment and receipt checks rather
than replacing them with this SUMMARY-only policy.

The seven ordinary skills' validity verifiers distinguish `UNVERIFIABLE` /
`verification_incomplete` / `repair_owner: "none"` from a supported author defect. Missing
verification capability or trustworthy evidence ends `incomplete/met:false` with
`incomplete_reason: "verification_incomplete"`, preserving the product and report without an
author-repair loop or positive validity receipt/admission. A domain product that honestly
records blocked, unresolved or partial work can be valid; its native completion policy still
applies. Unknown effects alone do not establish a defect or verification inability.

## Error / recovery behavior

| Situation                             | Behavior                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent SUMMARY structurally malformed  | P1.2 routing-only correction; measured repeated-error, inactivity and actual operator controls terminalize honestly |
| Structurally valid domain gap         | Engine resolves registered state/kind route, applies operator policy, records digest-only evidence                  |
| Agent returns `confidence: UNCERTAIN` | Playbook clarification policy may pause at `awaiting_clarification`; exact `respond` resumes                        |
| Parallel branch failure               | Accepted siblings remain durable; only missing/malformed work is reissued or terminalized                           |
| Session interruption mid-step         | Engine reissues the exact pending directive from the last checkpoint on `recover`                                   |
| Owner dispatch mode paused/invalid    | Typed `paused`, non-terminal/retriable; no agent/tool/fan-out dispatch or checkpoint/ref mutation                   |
| Retry budget exhausted                | Registered exhaustion route; terminal truth remains `incomplete/met:false` unless later admitted                    |
| Planned gate denied                   | Route to the playbook's declared honest negative terminal                                                           |

## Child-call storage recovery

The storage boundary establishes durable reservation/adoption, not runtime qualification. Before reserving a call it
verifies the canonical request and every input through a concrete `ArtifactStore` bound to the same
project as the checkpointer. One transaction then records the parent's pending child directive,
creates the ordinary unstarted child run, and inserts the call row and events. A failed transaction
leaves none of those control-state effects.

After restart, an exact repeated logical call adopts the committed row and its current lifecycle.
Changed immutable operands conflict. Artifact bytes without a matching call row are not a committed
call; a child run without its matching call row, a missing linked run, a registration mismatch, or
corrupt/noncanonical record bytes fail closed. The store never reconstructs child linkage from
artifacts, memory, logs, prose, or a broad scan.

Lifecycle changes are compare-and-set storage operations. The active depth-one owner uses them to
run a child and atomically consume a verified terminal into the parent. A runner cancellation signal
or concurrent durable parent-cancel request records `cancelled` on the child, so a late boundary
cannot resurrect parent success. New calls also carry a fenced, content-free inactivity lease;
trusted host-observed activity or workflow convergence renews one interval, while expiry stops and
consumes a silent child without pretending the parent requested cancellation.

The active runtime also supports version-2 projected child gates with exact mediated replies,
waiting/captured-terminal recovery under frozen registration/operand bindings, and linked
control/gate/receipt/session cohorts. Cancellation or a changed parent selection cannot be overwritten
by an older prepared continuation. Custody or quarantined host effects pin cohorts; safe eviction
preserves immutable artifacts. Arbitrary missing linkage is never reconstructed. The
[engine status owner](../orchestration/overview.md#child-workflow-feature-status) distinguishes these
features from provider promotion/live qualification. Gate 2 remains `not_run`.

## Constraints

- **Never fake completion.** No error or exhaustion path may report success.
- **The checkpointer is the source of truth for run state** — not an artifact payload, durable memory, or a temp file. Exact stage bytes live in owner artifacts; compact state and selected refs live in the checkpointer keyed by `run_id`.
- **Make steps idempotent.** A re-issued step must not double-apply side effects.
- **Forward-only recovery.** The owner sets `PENNY_ARTIFACT_DISPATCH_MODE=active|paused` (default active; unknown fails closed). Paused runs keep status and exact artifact reads available. Reactivation uses fresh-process recovery with the same pending refs/metadata; there is no semantic-memory fallback.

## Verification

- [ ] Structural contract violations stay on the separate P1.2 path and never advance as semantic repair
- [ ] Opted-in routing correction preserves every source detail and confidence; Produce's stronger core checks remain intact
- [ ] Verification inability stops negative without author repair and remains distinct from valid domain-incomplete products
- [ ] Exact recurrence survives restart and stops before another repair charge; `null` measurement never becomes progress or stall evidence
- [ ] Valid-gap evaluations reject target/exhaustion fields and registered routes execute in the engine
- [ ] Route events contain only hashes/counters; observability-off execution has identical workflow truth
- [ ] Loop exhaustion follows the declared successor and never emits a false positive
- [ ] Alternating reviewer gaps preserve the exact reviewed product and prior feedback through every repair path, reseal and reverify before success
- [ ] Negative semantic-repair terminals expose current-receipt diagnostic refs separately from partial products, survive recovery unchanged, and never borrow stale/wrong-phase reports
- [ ] UNCERTAIN / stalled loops escalate to `awaiting_clarification` where declared
- [ ] A killed run resumes correctly via `recover` (covered by a playbook test)
- [ ] Pause/unpause leaves artifact manifest/object hashes and memory sentinel unchanged and reissues identical pending refs

## Related Documents

- [Loops](loops.md) — Agentic loop taxonomy, termination controls, failure modes, and verifier design
- [Orchestration](orchestration.md) — Engine-backed skill protocol
- [Skill Standard](skill-standard.md) — Full skill standard
- [Testing](testing.md) — Playbook test requirements
