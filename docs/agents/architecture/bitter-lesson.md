# Bitter-Lesson Doctrine

How Penny stays flexible to future model improvements: what the self-improvement ratchet must protect, what it must never protect, and the recurring pass that keeps the two straight. This is the mechanism behind the Cognitive Frame's **"How This System Improves"** disposition. The source audit and the *disposable* mechanism inventory live in `research/bitter-lesson/`.

## The principle

Richard Sutton's *The Bitter Lesson*: general methods that leverage computation — **search** and **learning** — beat methods that bake in human domain knowledge, because compute rises exponentially while human-knowledge scaffolding plateaus, needs hand-maintenance, and eventually fights better models. Penny is the human-knowledge layer wrapped around a model whose capability rises out of our control, so every mechanism is a bet. Classify each one:

- **LEVERAGE** — amplifies the model and scales as it improves (verification, learning, memory, tools, search). **Protect.**
- **SAFETY** — encodes a human value or operational limit, independent of capability (HITL gates, sandboxing, security directives). **Protect.**
- **KNOWLEDGE-CONSTRAINT** — substitutes human heuristics for capability (keyword tables, hard-coded taxonomies, magic-number thresholds, mandated process). **Prune / relax; make capability-adaptive** (default to model judgment, keep the heuristic only as a tier-gated fallback).

## The reconciliation rule: ratchet on capabilities, not implementations

Regression-prevention and Bitter-Lesson alignment can *conflict*: a ratchet that protects everything passing today's evals will lock in KNOWLEDGE-CONSTRAINT scaffolding — because it passes now — which is ossification with a green check. The rule that reconciles them:

> **The ratchet protects capabilities and outcomes, never implementations.** Any mechanism may be replaced or removed; a change is blocked only if a *protected capability's measure* regresses.

This makes the guard **asymmetric** — which is exactly what "guard the leverage spine" means: protect the scaling properties, keep pruning the constraints. A change that rips out a hand-coded framework-detection table and still boots, serves, and tests the target project **passes**; a change that quietly weakens evidence-grounded verification **fails**.

## Capability invariants (the protected set)

The leverage/safety spine expressed as capabilities the ratchet must never let regress. *Enforced* = a test/contract already guards it; *Aspirational* = named here, executable wiring pending.

| Capability (protected outcome) | Why it's leverage / safety | Enforcement / measure | Status |
|---|---|---|---|
| **Grounded verification** — a PASS verdict carries captured evidence (test/scan/PoC/tool output); verification never fabricates | Scales with better models + tools | `contracts.py` evidence contract; per-skill `evidence=(...)`; verify tests | Enforced |
| **Iterate-to-verified + honest exhaustion** — work loops against a verifier; on budget exhaustion it reports `met=False`, never a fake pass | Test-time search; integrity | loop guards; exhaustion tests | Enforced |
| **Independent verification** — the generator is not its own sole judge | Search/verify leverage | verify runs on a different agent/model; judge ≠ subject family | Enforced (judge-policy hardening = checklist #6) |
| **Durable memory + retrieval** — decisions and context persist across sessions and are retrievable | Amplifies every task | mempalace round-trip; knowledge graph | Enforced |
| **Human oversight at high-stakes gates** — irreversible / high-stakes actions pause for approval | Human value / safety | `GATE_STATES` / HITL | Enforced |
| **Checkpoint / resume** — long runs are durable and resumable | Test-time durability | checkpointer tests | Enforced |
| **Safety guards** — sandbox / SSRF / scope allow-lists; the immutable security-directives block | Human value / safety | tool guards; path allowlist; frame boundary | Enforced |
| **Live retrieval over baked snapshots** — fetch current information where freshness matters rather than relying on a frozen copy | Rides the world's change, not a stale table | fresh-retrieval pattern (e.g. rez NICE) | Partial |
| **Model-scaling self-improvement** — improvements are drafted by a model reasoning over real outcomes, gated by human approval + the ratchet | Learning; compounds with model quality | learning loop (checklist #23) | Aspirational |

Adding a capability to this set is done by the recurring pass (below); *removing* an invariant is itself a high-stakes change that must be justified, not done casually.

> **Wiring note.** This doc is the *specification* of the protected set. Some invariants are already enforced by existing tests/contracts; others (notably model-scaling self-improvement, and organizing the eval ratchet explicitly around these named invariants) are follow-on engineering. Treat "Aspirational/Partial" rows as a backlog, not a claim.

## What is NOT protected

KNOWLEDGE-CONSTRAINT scaffolding is deliberately *absent* from the invariant list, **even when it passes today's evals**. It is disposable by design and is the standing target of pruning. The complementary **add-side** rule — the **Bitter-Lesson Gate**: *before adding any table, threshold, keyword list, or mandated step, ask whether it gets more or less valuable as the model improves; if less, give the model the artifact and verify with evidence instead* — belongs in the coding standard (`project-standards.md`) so new constraint-debt is caught at authoring time rather than accrued and re-audited later.

## The recurring Bitter-Lesson pass

A periodic ritual (in the spirit of the `tune` cycle) that keeps this doctrine *live* rather than frozen. It is the meta-method — the only genuinely rot-proof thing to make permanent. (Sutton: build in the method that discovers, not the discoveries themselves.)

**Cadence:** periodically (target ~quarterly) **and** event-driven on a major model upgrade — a stronger model is precisely when scaffolding becomes newly obsolete (this mirrors the eval system's model-roster / frame-hash invalidation).

**Steps:**

1. **Re-audit** the harness; classify mechanisms LEVERAGE / SAFETY / KNOWLEDGE-CONSTRAINT.
2. **Confirm** the ratchet still guards every capability invariant; add a regression check for any newly-earned capability.
3. **Identify** KNOWLEDGE-CONSTRAINT debt accrued since the last pass; queue the worst offenders for relaxation behind the ablation harness.
4. **Refresh** the disposable inventory in `research/bitter-lesson/`.
5. **Emit** an updated inventory + a short "prune next" list that feeds the normal change process.

The pass **proposes; measurement disposes** — every prune/relax candidate still goes through the ablation harness + ratchet before it ships.

## The volatile inventory

The specific mechanisms, thresholds, and file references — *what is LEVERAGE vs KNOWLEDGE-CONSTRAINT today* — are a point-in-time snapshot in `research/bitter-lesson/` (the tracker `index.html` + the `lane-*.md` census tables). They rot as the codebase changes and are regenerated by the pass. Do **not** copy them into permanent docs or treat them as law: this doctrine *references* the inventory, it does not *contain* it. That split — stable meta-method here, volatile specifics there — is what lets the principle be core without ossifying.

## Related

- [Atomic Loop Components](atomic-loop-components.md) — the construction companion: this doctrine's LEVERAGE/SAFETY/KNOWLEDGE-CONSTRAINT triage expressed as a catalog of loop atoms plus assembly rules, so the doctrine is buildable, not just auditable.
- [Agentic Loops](../skills/loops.md) — the seven loop classes (arrangements of those atoms) and per-class design rules.
- [Outcome Ledger](outcome-ledger.md) — the ratchet / eval substrate within which these capabilities are protected.
- [Project Standards](project-standards.md) — home of the add-side Bitter-Lesson Gate.
- [Tiered Memory](tiered-memory.md) — one of the protected leverage capabilities (durable memory).
- [Bitter-Lesson Doctrine (Human)](../../humans/architecture/bitter-lesson.md) — the conceptual WHAT/WHY companion to this operational doctrine.
