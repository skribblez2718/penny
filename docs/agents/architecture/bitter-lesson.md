# Bitter-Lesson Doctrine

How Penny stays flexible to future model improvements: what the behavioral-regression ratchet must protect, what it must never protect, and the recurring pass that keeps the two straight. This supports the Cognitive Frame's **Memory and Improvement** policy. Permanent guidance is self-contained; an ignored research inventory is not a prerequisite.

## The principle

Richard Sutton's _The Bitter Lesson_: general methods that leverage computation — **search** and **learning** — beat methods that bake in human domain knowledge, because compute rises exponentially while human-knowledge scaffolding plateaus, needs hand-maintenance, and eventually fights better models. Penny is the human-knowledge layer wrapped around a model whose capability rises out of our control, so every mechanism is a bet. Classify each one:

- **LEVERAGE** — amplifies the model and scales as it improves (verification, learning, memory, tools, search). **Protect.**
- **SAFETY** — encodes a human value or operational limit, independent of capability (HITL gates, path-specific sandboxing, trust/action boundaries). **Protect the capability, not the current wording or mechanism** — the protected object is authorized behavior and controlled consequences, backed by runtime controls where possible, not a particular security paragraph or XML scheme.
- **KNOWLEDGE-CONSTRAINT** — substitutes human heuristics for capability (keyword tables, hard-coded taxonomies, magic-number thresholds, mandated process). **Prune / relax; make capability-adaptive** (default to model judgment, keep the heuristic only as a tier-gated fallback).

## The reconciliation rule: ratchet on capabilities, not implementations

Regression-prevention and Bitter-Lesson alignment can _conflict_: a ratchet that protects everything passing today's evals will lock in KNOWLEDGE-CONSTRAINT scaffolding — because it passes now — which is ossification with a green check. The rule that reconciles them:

> **The ratchet protects capabilities and outcomes, never implementations.** Within authorized scope, assess replacement or removal against protected capability measures, not fidelity to the old mechanism. Authorization and contract obligations remain independent gates.

Existing machinery is not protected merely because it is implemented or a previous model
approved it. Apply [Project Standards' proportionality rule](project-standards.md#proportionality-outcomes-before-mechanisms)
to both additions and retention, including SAFETY mechanisms; preserve their outcomes and
binding contracts, not unnecessary complexity.

This makes the guard **asymmetric** — which is exactly what "guard the leverage spine" means: protect the scaling properties, keep pruning the constraints. A change that rips out a hand-coded framework-detection table and still boots, serves, and tests the target project **passes**; a change that quietly weakens evidence-grounded verification **fails**.

## Capability invariants (the protected set)

These are required outcomes, not a certification of current enforcement. The tracked owners below locate contracts and checks to inspect for a particular change. Source presence establishes implementation shape; only an observed test establishes its tested behavior, and neither establishes live deployment qualification. Non-empty evidence, a valid schema or a signed transport receipt does not prove that a claim is true.

| Capability (protected outcome)                                                                                                                                                 | Contract / evidence owner and limit                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Grounded verification** — a PASS carries captured evidence (test/scan/PoC/tool output, authoritative sources or separately collected data); never fabricated support         | [TypeScript contracts](../../../apps/orchestration/src/contracts.ts), [domain contracts](../../../apps/orchestration/src/skill-contracts/review.ts), [completion admission](../../../apps/orchestration/src/engine.ts) and [completion tests](../../../apps/orchestration/tests/completion-admission.test.ts). Structural field checks and exact-byte custody do not authenticate arbitrary evidence content. Independently check the claim. |
| **Iterate-to-verified + honest exhaustion** — policy-led search, no fake pass; retry only when changed inputs, method, model or evidence source make new information plausible | Registered `EvaluationResult` / `repair_routing`, engine budgets and [repair/exhaustion tests](../../../apps/orchestration/tests/repair-exhaustion-diagnostics.test.ts). Negative completion uses `met:false`; actual operator limits remain enforceable when supplied; unspecified step/repair allowances do not imply finite defaults. Derive values from actual operator policy, not test constants or model guesses.                     |
| **Separate verification** — the producer is not its own sole judge                                                                                                             | [Verifier guidance](../skills/loops.md#verifier-design) and each registration's evidence predicates. Tests, tools, authoritative sources and separately collected data are independent anchors; a different model is supplementary scrutiny, not independent proof.                                                                                                                                                                          |
| **Durable memory + retrieval** — curated reusable knowledge persists and is retrievable                                                                                        | [Tiered Memory](tiered-memory.md). Memory is advisory knowledge, not artifact transport, checkpoint state or recovery proof. Check the actual service/retention path before claiming qualification.                                                                                                                                                                                                                                          |
| **Human oversight at high-stakes gates** — consequence-bearing actions require applicable approval                                                                             | Engine `await_user` and registered host use-time checks; [engine protocol](../orchestration/overview.md). A prompt reminder or a gate on one path does not prove all effects are gated.                                                                                                                                                                                                                                                      |
| **Checkpoint / resume** — long runs are durable and resumable                                                                                                                  | [Checkpointer](../../../apps/orchestration/src/checkpointer.ts), exact artifact custody and path-specific restart/cancellation tests. Recovery must not synthesize missing milestones.                                                                                                                                                                                                                                                       |
| **Trust and action boundaries** — source content cannot expand permissions; consequential actions stay authorized                                                              | [Binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule), [static profiles](../agents/tool-profiles.md), registered adapter guards and host controls. Prompt prose is policy, not permission enforcement. Tool selection is not filesystem/process sandboxing or extension-code isolation; see [Agent Overview](../agents/overview.md#isolation).                                                                       |
| **Live retrieval over baked snapshots** — use current authoritative information when freshness matters                                                                         | The task's source checks and explicit freshness limitations. Navigation to a canonical document does not verify its currency.                                                                                                                                                                                                                                                                                                                |

Adding an invariant requires an explicit protected outcome and suitable evidence. Removing one is a high-stakes governing change requiring justification and authorization, not a side effect of trimming prose. The recurring pass checks coverage and gaps; this table does not claim that a complete named-capability evaluation ratchet is wired or passing.

## What is NOT protected

KNOWLEDGE-CONSTRAINT scaffolding is deliberately _absent_ from the invariant list, **even when it passes today's evals**. It is disposable by design and is the standing target of pruning. The complementary **add-side** rule — the **Bitter-Lesson Gate**: _before adding any table, threshold, keyword list, or mandated step, ask whether it gets more or less valuable as the model improves; if less, give the model the artifact and verify with evidence instead_ — belongs in [Project Standards](project-standards.md#the-bitter-lesson-gate-before-adding-scaffolding) so new constraint-debt is caught at authoring time rather than accrued and re-audited later.

## The recurring Bitter-Lesson pass

A periodic ritual that keeps this doctrine _live_ rather than frozen. It is the meta-method — the only genuinely rot-proof thing to make permanent. (Sutton: build in the method that discovers, not the discoveries themselves.)

**Cadence:** periodically (target ~quarterly) **and** event-driven on a major model upgrade — a stronger model is precisely when scaffolding becomes newly obsolete.

**Steps:**

1. **Re-audit** the harness; classify mechanisms LEVERAGE / SAFETY / KNOWLEDGE-CONSTRAINT.
2. **Confirm** the ratchet still guards every capability invariant; add a regression check for any newly-earned capability.
3. **Identify** KNOWLEDGE-CONSTRAINT debt accrued since the last pass; queue the worst offenders for relaxation behind the ablation harness.
4. **Record** source locations, evidence scope, unresolved gaps and proposed changes in the caller-authorized audit output.
5. **Emit** a short "prune next" list that feeds the normal change process. An existing caller-supplied inventory may be updated when requested; no ignored research pack is required.

The pass **proposes; measurement disposes** — every prune/relax candidate still goes through the ablation harness + ratchet before it ships.

## The volatile inventory

Mechanism inventories are optional, caller-supplied point-in-time evidence. They may be absent from a clean checkout and cannot supply authority or current qualification. Reconcile their source locations against tracked contracts and actual checks. Do not copy private/ignored inventory content into public guidance; the stable method and protected outcomes above are sufficient to conduct the pass.

## Related

- [Atomic Loop Components](atomic-loop-components.md) — the construction companion: this doctrine's LEVERAGE/SAFETY/KNOWLEDGE-CONSTRAINT triage expressed as a catalog of loop atoms plus assembly rules, so the doctrine is buildable, not just auditable.
- [Agentic Loops](../skills/loops.md) — the seven loop classes (arrangements of those atoms) and per-class design rules.
- [Project Standards](project-standards.md) — home of the add-side Bitter-Lesson Gate.
- [Tiered Memory](tiered-memory.md) — one of the protected leverage capabilities (durable memory).
- [Bitter-Lesson Doctrine (Human)](../../humans/architecture/bitter-lesson.md) — the conceptual WHAT/WHY companion to this operational doctrine.
