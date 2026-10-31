# Agentic Loops — Reference

How to design, implement, and operate loops in Penny skills. This document is the operational reference for playbook authors and engine contributors. For the conceptual overview and rationale, see [Loops (Human)](../../humans/skills/loops.md).

## A Conceptual Loop Lens

A useful abstract cycle is **gather context → take action → verify work → repeat or complete**:

```
FRAME → PLAN → ACT ⇄ VERIFY → LEARN → (repeat or complete)
```

This is a design lens, not policy in `SYSTEM.md`, a required state sequence, or a base class. Each registered skill implements a TypeScript `PlaybookCore` with domain-named states. The engine supplies stepping, checkpointing, closed contracts, budgets, registered repair, gates, and recovery; each playbook uses only topology justified by requirements, dependencies, or observed evidence.

**Key principle:** share engine invariants, specialize workflow topology. Do not create a universal procedural base class or force every task through every conceptual phase.

## The Parts Beneath the Loop Classes (Atomic Components)

Use [Atomic Loop Components](../architecture/atomic-loop-components.md) when applying its
construction model. It is an optional design lens, not a prerequisite for every loop lookup or a
requirement to choose topology late. Registered code-owned graphs remain justified by evidence,
approval, recovery, and audit dependencies. Model-directed search fits open-ended work where those
dependencies do not fix the path. The [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md)
protects capabilities, not one arrangement or a mandated reasoning sequence.

## The Seven Loop Classes

These classes can nest; use only those the workflow needs. L1 is worker execution, L2 evaluation,
L3 policy-led repair, L4 consequence/clarification gates, L5 durable orchestration, L6 optional
cross-run learning, and L7 external scheduling.

### L1 — Inner Tool-Use Loop (ReAct)

**What:** Interleaved thought → action → observation, repeated until the model produces a final answer. The pi runtime implements this per subagent invocation.

**In Penny:** Pi SDK worker sessions implement L1 inside each `invoke_agent` assignment; the
orchestration engine does not implement the inner tool loop; workers compose SDK sessions in-process.
One assignment may contain many tool iterations. SDK teardown awaits registered
`session_shutdown` handlers before disposal, including failure/cancellation exits.

The directive carries exact input/output artifact contracts. Follow
[Invocation](../agents/invocation.md) for complete `artifact_read`/`next_range` reads, missing-input
refusal, and exact owner capture/readback before SUMMARY routing. Payloads stay out of `RunContext`.

### L2 — Verifier / Critic Gate

**What:** A separate evaluation step decides whether work converges or cycles back. One agent generates, another evaluates.

**In Penny:** The playbook proposes a terminal; the registration declares closed phase schemas and
completion policy; the engine admits success. The actor is never its own sole judge. Review order
is skill-specific; [Design Methodology](design-methodology.md) records the current differences.
A separate subjective critic is conditional, not a universal extra stage.

Use the domain's strongest independent evidence—executed checks, authoritative sources, or
separately collected data. Model review interprets that evidence; model agreement does not
establish its authenticity. See [Verifier Design](#verifier-design) for evidence limits.

### L3 — Retry / Repair Loop (Policy-Led)

**What:** On verifier failure, repair and retry when another attempt can add information, subject to actual operator policy.

**In Penny:** Playbooks return typed `EvaluationResult` with `kind`, bounded findings/detail,
and non-empty `strategy_delta`, never target/exhaustion fields. The engine resolves exactly one
registered origin-state/kind `repair_routing` entry, records detail/strategy-delta digests, records repair use and applies any operator-supplied iteration limit and reserved attempts before following the repair or honest exhaustion target. An unspecified limit must not be replaced by a guessed count.
Domain bookkeeping cannot mutate engine-owned control fields. Structural malformed-result
correction stays on the separate P1.2 routing/liveness path under its actual policy.

Choose another attempt only when changed inputs, method, model, or evidence can add information.
A repair returns to evidence/review before acceptance; exhaustion preserves best partials and
unresolved work, never a fake pass. Exact repair recurrence, Research's native repeated-issue
checks and host protocol-failure handling are distinct controls. See [Resilience](resilience.md)
for seal correction versus semantic repair, epoch allowances, and exact failure diagnostics.

#### Exact repair recurrence

`repair_progress_policy: "exact_fingerprint_v1"` opts a registration into paired
`repairProgressFingerprint(context, state, details): string | null` and
`terminalizeRepairStall(context, state, evaluation)` capabilities. The host measures the
relevant candidate and failed structured checks, excluding strategy prose and transport-only
identity changes. Current ordinary skills use different measurements:

| Skill    | Measured candidate/evidence boundary                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assess   | Parsed assessment draft on product-gap routes only, while every selected historical analysis has identical bytes.                                                         |
| Diagnose | Parsed diagnosis draft with hypothesis/check IDs normalized to relationships, on product-gap routes only, while decomposition and hypothesis prose remain byte-identical. |
| Decide   | Parsed decision draft plus verified analysis/evidence content and admission classification; critique also includes the validity report's content.                         |
| Plan     | Parsed strategy draft plus verified orientation/evidence content and admission classification; critique also includes the validity report's content.                      |
| Define   | V3 specification/support claims and admitted evidence content/answer inventory after trace replay; unsupported draft versions are unmeasurable.                           |
| Produce  | Authored V2 draft plus bound failed-review details, after native mechanical and review-core validation.                                                                   |
| Research | Typed semantic draft with evidence slots replaced by captured-body hashes, plus considered evidence content and failed review details.                                    |

Assess and Diagnose return `null` for analysis/evidence gaps. Any upstream prose byte change
also disables their product-gap measurement for the rest of that run, even if it changes only
metadata. Decide/Plan decline measurement when upstream report content cannot be verified;
a new artifact ID alone is not new evidence.

The engine persists fingerprints in `feedback_route_evidence_v1.repair_progress_v1` atomically
with accepted receipts. Recurrence of a non-null fingerprint in the same run, origin phase
and logical branch—including A/B/A after restart—stops `incomplete/met:false` before another
repair charge or dispatch, preserving partials and current feedback. Missing paired
capabilities or malformed fingerprints produce negative refusals.

This is conservative exact matching, not semantic-equivalence detection. `null` means
unmeasurable, **neither progress nor stall**; a changed fingerprint is not proof of progress.
Paraphrases and changing failed-check text can evade exact recurrence. There is no universal
semantic-stagnation guarantee and no new duration or count cap.

### L4 — Human-in-the-Loop Gates

**What:** Planned checkpoints where the agent pauses for approval, refinement, or denial — plus unplanned escalation when blocked or uncertain.

**In Penny:** Playbook-emitted `await_user` gates plus clarification escalation and exact `respond`/`recover` requests.

**Design rules:**

- HITL gates double as a termination control (a hard stop an agent cannot argue its way past)
- HITL gates are the correct response to the paralysis failure mode (escalate rather than spin)
- Place gates before irreversible actions (sending, deleting, publishing) — consistent with Penny's confirm-before-irreversible policy

### L5 — Orchestration Loop (FSM)

**What:** The outer, engine-owned loop: explicit states, typed transitions, guard conditions, checkpointing, resume.

**In Penny:** Registered TypeScript playbooks, durable `run_id` checkpoints, exact `recover`, an optional operator-supplied `max_steps` ceiling, observability events, and bounded parallel fan-out.

**Design rules:**

- **The graph bounds the blast radius.** A playbook whose successor tables and flow descriptor contain only intended edges cannot wander into an unintended cycle; drift tests pin both.
- **The engine owns continuity, not the model.** Long-horizon loops must be reconstructed each session from persisted external state, because sessions are memoryless. Everything routing-relevant lives in `RunContext`, never implicitly in an agent's context.
- **States must be safe to re-run** (crash-resume re-issues the pending step). An ACT-style state must be idempotent or split author/apply.

### L6 — Reflection / Memory-Learning Loop

**What:** Optional learning between runs without weight updates: capture grounded outcomes, retrieve relevant prior material, propose and test reusable lessons, authorize promotion, and reuse approved artifacts later.

**In Penny:** The unmarked primary runtime owns curated writes, diary retention, and governed temporal KG lifecycle operations. Catalog workers may receive bounded read-only recall/KG access when their owner-materialized active tool list includes YAML-declared memory reads; they never receive memory writes, advisory logstream access, or memory-based handoff. Skill drivers receive no memory tools. The orchestration engine does **not** inject retrieved memory into directives; active handoff uses exact artifacts. When applying the atomic model, full L6 uses its [optional learning/curation arrangement](../architecture/atomic-loop-components.md#optional-learningcuration-arrangement-l6), not a single Recall call.

**Design rules:**

- **Recall is explicit and relevance-driven.** Retrieve only when prior decisions, preferences, incidents, or work could materially affect the task. Preserve provenance and dates; treat results as advisory task material, never authority.
- **Capture without duplicate truth.** Terminal facts stay in checkpoints, evidence in exact artifacts,
  and measurements in telemetry. Cross-run outcome views are rebuildable projections with no
  workflow-transition authority.
- **Curate with evidence and authorization.** Propose and challenge lessons, measure support/usefulness,
  and authorize consequential promotion before writing.
- **Guard against confirmation bias and mode collapse.** A remembered lesson cannot hard-gate a new run, expand permissions, or silently change completion criteria.
- **Adapt verification per domain.** Reflexion used environment success for AlfWorld, self-generated unit tests for coding, and exact match for QA—the learning arrangement is not fully task-agnostic.

### L7 — Background / Scheduled Loops

**What:** Time- or event-triggered outer loops: polling, monitoring, recurring maintenance.

**In Penny:** This is a composition pattern, not a general current progress-heartbeat capability. A caller or scheduler may start/resume policy-controlled orchestration work through the public engine surface; durable checkpoints make that resume possible. Progress events are observational telemetry, not autonomous ticks and not a separate handoff channel.

**Design rules:**

- Apply the caller/scheduler’s actual work policy per tick; do not invent a count
- Make resume idempotent (a re-fired tick must not duplicate side effects)
- Escalate rather than retry indefinitely when a tick keeps failing
- Treat any scheduler as an external owner of timing; the orchestration engine owns only the resumed run's state and transitions

## Termination Controls

Derive values from actual operator policy, not test constants or model guesses. Do not invent step, agent-call, phase-cycle, semantic-repair, or correction-attempt caps. Honor actual operator limits when supplied; absence is not a finite default. Cancellation, trusted progress/inactivity controls, measured failure handling, authorization/disclosure, exact custody, and evidence-gated completion still apply.

External hostile/shared resource boundaries and finite input/output/schema/complexity limits are separate controls; this policy does not remove them. Optional policy does not mean every field accepts null: the active registration owns representation and historical replay. Documentation checks do not establish runtime enforcement.

Use the controls appropriate to the operation; a finite count is not a universal prerequisite:

| #   | Control                          | What It Does                                                   | Penny Mechanism                                                |
| --- | -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Verifier-gated success           | Success termination only when required gates pass              | closed `CompletionGate` v2 + durable admission envelope        |
| 2   | Operator-supplied limits         | Enforce actual policy when present; report exhaustion honestly | Optional iteration/repair limits + registered exhaustion route |
| 3   | Structured completion criteria   | Closed predicates checked before positive completion           | `CompletionGate` v2 + completion admission evidence            |
| 4   | Human-in-the-loop checkpoints    | Gate consequence-bearing actions or resolve blockers           | `await_user`/host continuation where the playbook declares it  |
| 5   | Progress and inactivity controls | Continue productive work; stop or escalate measured stalls     | Trusted activity, renewable inactivity leases, cancellation    |

## Failure Modes

Every loop must defend against both ends of the same axis:

### Infinite Loops / Agent Paralysis

**Symptom:** Agent continuously retries a failed action without modifying its strategy. Still struggles with giving up or asking for human help.

**Cause:** No meaningful strategy delta, an incorrect repair route, or repeated no-progress evidence.

**Fix:** Apply [L3](#l3-retry-repair-loop-policy-led)'s strategy, route, and budget contract.
Add stall detection only where progress can be measured; use the registered termination or
escalation outcome rather than a new generic loop rule.

### Premature Termination

**Symptom:** Agent declares partial work complete. "A later agent instance would look around, see that progress had been made, and declare the job done."

**Cause:** Verifier too weak or absent. Agent self-asserts completion.

**Fix:** Apply [L2](#l2-verifier-critic-gate) and the registration's closed completion gate.
Missing/invalid evidence cannot create success; preserve the phase's actual schema instead of
inventing a universal `complete: false` field.

## Verifier Design

Evidence requirements are domain-specific. A command transcript is appropriate for an executed
check; source-grounded research may instead require exact authoritative-source references and
claim-to-source checks. Do not require commands where they cannot establish the claim.

### Verifier Strength Ranking

A useful evidence hierarchy is **oracle > rules > proxy > critic**:

| Strength              | Tier                      | Example                                                                    | Use When                                                                           |
| --------------------- | ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Strongest             | **Oracle**                | Test suite, compiler, executed protocol check, environment state           | A crisp external truth exists                                                      |
| Strong                | **Rules**                 | Schema validation, lint, deterministic invariant, claim-to-source matching | Structured output or any checkable invariant                                       |
| Weak (Goodhart-prone) | **Proxy**                 | A gameable measurable stand-in such as keyword overlap                     | Only as an assist that feeds a stronger judge — never as the gate                  |
| Weakest               | **Critic** (LLM-as-judge) | Cross-model review, Carren critique                                        | Fuzzy criteria such as research quality or design review — never the sole verifier |

Same-model self-critique is the degenerate critic and must not be the sole gate. Climb each VERIFY state to the strongest tier its output admits. Where no oracle exists, place a deterministic rules floor beneath the critic or supply a clearly labeled proxy as evidence for the interpreter, never as a rule that silently decides the verdict.

### Design Rules

1. The actor must not be its own sole judge. Prefer independent evidence; model review alone is
   weaker and cannot authenticate its input.
2. The active phase schema and domain evidence contract define required fields, locators, and
   checks. Enforce declared evidence presence/shape and bind each verdict to the exact product
   and evidence it evaluated. Non-empty plausible text is not proof of execution or truth.
3. Use model diversity or an additional reviewer where the registered workflow requires it or
   measured benefit justifies it. Agreement is supplementary scrutiny, not evidence authenticity.
   Resolve missing support or disagreement through the declared gap/escalation policy; do not
   invent a universal second-verifier-agreement gate.
4. Prefer captured, independently reproducible evidence outside the actor's control. Report
   unresolved authenticity/source gaps honestly, even if structural validation passes.

## Task-to-Loop Mapping

Match the loop stack to the task's verifiability and step-predictability:

| Task Type             | Primary Loops                                        | Oracle Strength                | Key Risk                       | Penny Skill                        |
| --------------------- | ---------------------------------------------------- | ------------------------------ | ------------------------------ | ---------------------------------- |
| Coding/production     | L2+L3; L4 only when consequences require it          | High (tests/lint)              | Premature "done"               | Direct/delegated work or `produce` |
| Assessment/diagnosis  | L2; policy-led L3 when registered                    | Evidence and rule application  | Unsupported findings           | `assess` or `diagnose`             |
| Decision/planning     | L2+L3; L4 only when consequences require it          | Mixed                          | Critique replacing evidence    | `decide` or `plan`                 |
| Research              | L5+L1 fan-out+L2 (optional primary L6 across runs)   | Source grounding               | Shallow or unsupported report  | `research`                         |
| Knowledge-base work   | L5+L2+L3 with operation-conditioned L4               | Source support + semantic lint | Publishing unsupported claims  | dedicated `knowledge_base` ingress |
| Scheduling/automation | externally scheduled L7+L5 (+L4 before side effects) | High but narrow                | Double execution, silent retry | caller/scheduler + engine resume   |

**Principle:** Tasks with crisp external oracles can lean on tight verifier-gated retry loops. Fuzzy-oracle tasks must lean on explicit evidence criteria and human escalation because model judgment is weaker than an oracle.

## Loop-Quality Recommendations

Use these as improvement questions, not four mandatory new stages.

### Rec 1 — Enforce a strategy delta through typed repair feedback

[L3](#l3-retry-repair-loop-policy-led) owns the operational repair rule. Improve feedback quality
without inventing generic retry keys or finite defaults; respect actual operator policy.

### Rec 2 — Add measured stall handling only where evidence supports it

[Exact repair recurrence](#exact-repair-recurrence), Research's normalized issue histories and
host liveness serve different failure modes. Add broader stall handling only with a measurable
signal and tests; retain each registered exhaustion path and decline unmeasurable comparisons.

### Rec 3 — Require externally-grounded evidence in VERIFY contracts

[Verifier Design](#verifier-design) owns the evidence rule. Contract non-emptiness is only a floor,
not authenticity; test fabricated-but-nonempty evidence and valid non-command source evidence.

### Rec 4 — Harden verifiers against gaming

Research exposes `validate_model` for citation-gate model selection. Whether another reviewer
improves catch rate, or disagreement should escalate, remains empirical. Stronger source checks,
reproducible output, exact-product binding, and honest gaps matter more than model agreement.

## Related Documents

- [Atomic Loop Components](../architecture/atomic-loop-components.md) — conditional construction lens, atom catalog, and control-flow tradeoffs
- [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md) — the ratchet these loops must comply with (protect capabilities, prune constraints)
- [Resilience](resilience.md) — Error handling and recovery on the engine
- [Orchestration](orchestration.md) — Engine-backed skill protocol
- [Skill Standard](skill-standard.md) — Complete skill reference specification
- [State Machine Reference](../state-management/state-machine-reference.md) — FSM patterns on the engine
- [Loops (Human)](../../humans/skills/loops.md) — Conceptual overview and rationale
