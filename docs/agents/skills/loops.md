# Agentic Loops — Reference

How to design, implement, and operate loops in Penny skills. This document is the operational reference for playbook authors and engine contributors. For the conceptual overview and rationale, see [Loops (Human)](../../humans/skills/loops.md).

## The Universal Loop Shape

Every credible source describes the same abstract cycle: **gather context → take action → verify work → repeat**. In Penny, this maps to the six engine operations:

```
FRAME → PLAN → ACT ⇄ VERIFY → LEARN → (repeat or complete)
```

This shape is a **methodology** documented in SYSTEM.md, not a base class. Each skill implements its own specialized concrete loop as a `BasePlaybook` subclass with domain-named states. The engine provides the universal machinery (stepping, checkpointing, contracts, budgets, gates, recovery); each playbook writes its own specialized sentence in that grammar.

**Key principle:** universality at the shape level, specialization at the instance level. Do not create a `StandardCyclePlaybook` base class — each skill subclasses `BasePlaybook` directly with custom-named states.

## The Parts Beneath the Loop Classes (Atomic Components)

The seven loop classes below are not primitive — they are **arrangements of a smaller set of atomic components**. Before designing a loop, read [Atomic Loop Components](../architecture/atomic-loop-components.md): 18 atoms in 7 families, with the one structural law that keeps every loop [Bitter-Lesson](../architecture/bitter-lesson.md)-compliant:

> **Intelligence is confined to exactly two atoms (`Decide`, `Critique`). Every other atom is deterministic, model-agnostic Python.** The procedure for solving a task is never coded — it is `Decide`'s runtime output.

The loop classes map directly onto the atoms and the six canonical *arrangements* of them:

| Loop class (below) | Atom(s) that implement it | Arrangement |
|---|---|---|
| L1 Inner tool-use | `Decide` + `Act` + `Toolspace` (in the pi runtime) | agent loop |
| L2 Verifier gate | `Verify` (D1, the objective function) + `Critique` (B2) | evaluator-optimizer |
| L3 Retry/repair | `Budget` (D2) + strategy-changing `Decide` | evaluator-optimizer |
| L4 HITL gate | `Gate` (D3) + `Escalate` (D4) | any + consequence boundary |
| L5 Orchestration FSM | `Thread`/`Checkpoint`/`Fan` + the engine | orchestrator-workers |
| L6 Reflection/memory | `Ledger`/`Recall`/`Distill` (F1–F3) | learning conduit |
| L7 Background/scheduled | scheduled `Checkpoint` resume | background tick |

The practical consequence for playbook authors: you are not choosing an architecture, you are **arranging atoms**, and you move between arrangements by re-wiring, not re-building. The [add-side gate](../architecture/atomic-loop-components.md#the-add-side-gate) and [LOAN lifecycle](../architecture/atomic-loop-components.md#the-loan-lifecycle-how-loops-stay-compliant-over-time) govern what you may bake into a loop and when to delete it.

## The Seven Loop Classes

Loops are not alternatives — they **nest**. A production system layers them:

```
┌─ L7 Background/scheduled loops (cron, watchers, digests) ────────────┐
│ ┌─ L6 Reflection / memory-learning loop (across runs) ─────────────┐ │
│ │ ┌─ L5 Orchestration loop (FSM / graph, checkpointed) ──────────┐ │ │
│ │ │ ┌─ L4 Human-in-the-loop gates (approve / refine / deny) ───┐ │ │ │
│ │ │ │ ┌─ L3 Retry / repair loop (bounded budget) ────────────┐ │ │ │ │
│ │ │ │ │ ┌─ L2 Verifier / critic gate (convergence test) ───┐ │ │ │ │ │
│ │ │ │ │ │ ┌─ L1 Inner tool-use loop (think→act→observe) ─┐ │ │ │ │ │ │
│ │ │ │ │ │ └──────────────────────────────────────────────┘ │ │ │ │ │ │
│ │ │ │ │ └──────────────────────────────────────────────────┘ │ │ │ │ │
│ │ │ │ └──────────────────────────────────────────────────────┘ │ │ │ │
│ │ │ └──────────────────────────────────────────────────────────┘ │ │ │
│ │ └──────────────────────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### L1 — Inner Tool-Use Loop (ReAct)

**What:** Interleaved thought → action → observation, repeated until the model produces a final answer. The pi runtime implements this per subagent invocation.

**In Penny:** This loop lives inside the pi runtime, per `invoke_agent` directive. The engine deliberately does not implement L1 — each `invoke_agent` spawns a pi subprocess whose internal tool loop is L1. This is the correct division of labor: the control loop is one component, not the whole harness.

**Design rules:**
- Each subagent invocation is one L1 cycle
- The agent receives its task via the `task_summary` field in the engine directive
- The agent returns a structured SUMMARY; full output goes to MemPalace
- One tool call per action step is the disciplined default — interleaved results from multi-tool calls are harder to parse and harder to roll back

### L2 — Verifier / Critic Gate

**What:** A separate evaluation step decides whether work converges or cycles back. One agent generates, another evaluates.

**Load-bearing, not optional:** Removing Voyager's critic caused a **−73% drop** in discovered items — the most impactful feedback component in the system.

**In Penny:** The `done_predicate` + verify states (Vera for objective PASS/FAIL, Carren for subjective critique), verify⇄learn edges in playbooks, cross-model VERIFY discipline, and the SUMMARY contract gatekeeper.

**Design rules:**
- **External, grounded feedback beats self-critique.** Pure LLM self-critique hallucinates violations and over-corrects. Rules-based feedback (lint, tests, schema validation, environment state) is the strongest verifier. LLM-as-judge is valid but weak.
- **Position the LLM verifier as an interpreter of external evidence, not as the evidence itself.** Vera's `evidence` field MUST contain captured output of verification commands actually run — not assertions.
- **Cross-model verification:** a different model verifies than the one that acted. Already Penny policy.
- **Per-domain verifier contracts** are where loop quality will be won or lost. Each skill's VERIFY `summary_contract` defines what evidence is required.

### L3 — Retry / Repair Loop (Bounded)

**What:** On verifier failure, repair and retry — under an explicit budget.

**In Penny:** `ctx.max_iterations` (default 3) with `learn_retry`/`learn_exhausted` routing, `_retry_or_fail` bounded step-retries for malformed SUMMARYs, sca's `DEFAULT_AUGMENT_CAP = 3`.

**Design rules:**
- **Retries must change strategy.** The defining feature of agent paralysis is "continuously retrying a failed action without modifying their strategy." The `strategy_change` field in LEARN SUMMARY must state what will be done differently. The engine should reject a retry whose planned change is absent or ~identical to the prior iteration's.
- **Budget exhaustion is a legitimate outcome.** Report honestly what was achieved and what remains (`learn_exhausted` → complete with `met=False`). Never fabricate success.
- **Reflexion-style informed repair:** each retry should be informed by a verbal reflection on the failure (this links L3 to L6).

### L4 — Human-in-the-Loop Gates

**What:** Planned checkpoints where the agent pauses for approval, refinement, or denial — plus unplanned escalation when blocked or uncertain.

**In Penny:** Planned gates (`GATE_STATES`, `gate_questions`, `route_user` multi-way resume), the escalation loop (UNCERTAIN confidence → `awaiting_clarification` → resume), `code`'s criteria_gate and plan_gate, sca's six human gates.

**Design rules:**
- HITL gates double as a termination control (a hard stop an agent cannot argue its way past)
- HITL gates are the correct response to the paralysis failure mode (escalate rather than spin)
- Place gates before irreversible actions (sending, deleting, publishing) — consistent with Penny's confirm-before-irreversible policy

### L5 — Orchestration Loop (FSM)

**What:** The outer, engine-owned loop: explicit states, typed transitions, guard conditions, checkpointing, resume.

**In Penny:** `BasePlaybook` — python-statemachine FSMs, durable `run_id` checkpointer, `recover_pending` crash-resume, `STEP_CAP`, observability events, parallel fan-out with weakest-confidence fan-in.

**Design rules:**
- **The graph bounds the blast radius.** An FSM whose only edges are the intended loop edges cannot wander into an unintended cycle. The engine gets this for free from python-statemachine's declared transitions.
- **The engine owns continuity, not the model.** Long-horizon loops must be reconstructed each session from persisted external state, because sessions are memoryless. Everything routing-relevant lives in `RunContext`, never implicitly in an agent's context.
- **States must be safe to re-run** (crash-resume re-issues the pending step). An ACT-style state must be idempotent or split author/apply.

### L6 — Reflection / Memory-Learning Loop

**What:** Learning between runs without weight updates. Verbally reflect on task feedback signals, maintain reflective text in an episodic memory buffer, improve subsequent trials.

**In Penny:** MemPalace (the blackboard), the LEARN operation, and the daily self-improvement compression loop.

**Design rules:**
- **Retrieve past-run reflections at run start.** The engine does this for every playbook: `start()` seeds distilled lessons from MemPalace into the first agent's context via `recall_lessons` (advisory, opt-out via `PENNY_RECALL=0`). This turns L6 from write-only into a closed loop.
- **Guard against confirmation bias and mode collapse.** Retrieve as advisory context; don't let a past lesson hard-gate a new run.
- **The evaluator must be adapted per domain.** Reflexion used environment success for AlfWorld, self-generated unit tests for coding, exact-match for QA — the loop is not fully task-agnostic.

### L7 — Background / Scheduled Loops

**What:** Time- or event-triggered outer loops: polling, monitoring, digests, recurring maintenance.

**In Penny:** Ambient watchers, weekly digests, progress heartbeats, the daily compression loop's schedule.

**Design rules:**
- Bounded work per tick
- Idempotent resume (a re-fired tick must not double-send)
- Escalation-not-retry when a tick keeps failing
- These compose with L5: a scheduled tick that starts or resumes an orchestration run gets checkpointing and recovery for free

## Termination Controls

From the research, in order of strength:

| # | Control | What It Does | Penny Mechanism |
|---|---------|-------------|-----------------|
| 1 | Verifier-gated success | Success termination only when a verifier passes | `done_predicate` |
| 2 | Bounded iteration budgets | Hard cap on retries; exhaustion is a legitimate outcome | `max_iterations`, `learn_exhausted` → `met=False` |
| 3 | Structured completion criteria | Written before the work; checked at the end | FRAME⇄VERIFY design spine; IDEAL_STATE |
| 4 | Human-in-the-loop checkpoints | Escape hatch for paralysis and gate for irreversible actions | Planned gates, escalation |
| 5 | Global step caps | Backstop of last resort | `STEP_CAP` (default 50) |

## Failure Modes

Every loop must defend against both ends of the same axis:

### Infinite Loops / Agent Paralysis

**Symptom:** Agent continuously retries a failed action without modifying its strategy. Still struggles with giving up or asking for human help.

**Cause:** No strategy delta between retries. No progress-assessment module.

**Fix:**
- Require `strategy_change` field in retry SUMMARYs
- Add stall detection (compare successive iterations' verifier evidence)
- On stall, route to escalation (L4) rather than burning the remaining budget

### Premature Termination

**Symptom:** Agent declares partial work complete. "A later agent instance would look around, see that progress had been made, and declare the job done."

**Cause:** Verifier too weak or absent. Agent self-asserts completion.

**Fix:**
- Verifier-gated success (success only when verifier passes, never on actor's own claim)
- Require externally-grounded evidence in VERIFY contracts
- Safe defaults that never claim completion (treat missing/invalid as `complete: false`)

## Verifier Design

The strongest and most actionable cluster of findings from the research:

### Verifier Strength Ranking

| Strength | Type | Example | Use When |
|----------|------|---------|----------|
| Strongest | Rules-based feedback | Lint, tests, schema validation, environment state | Code, security PoC, structured output |
| Valid but weak | LLM-as-judge | Cross-model verification, Carren critique | Research quality, design review, fuzzy criteria |
| Do not use alone | Self-critique | Same model re-reading its own output | Never as the sole verifier |

### Design Rules

1. **External, grounded feedback beats self-critique.** Pure LLM self-critique hallucinates violations and over-corrects. Without an oracle, LLMs cannot reliably self-correct.
2. **Position the LLM verifier as an interpreter of external evidence, not as the evidence itself.** Vera produces PASS/FAIL — the PASS must be backed by captured tool output, not by the model's say-so.
3. **Cross-model verification.** A different model verifies than the one that acted. Already Penny policy.
4. **Demand evidence artifacts in VERIFY contracts.** Each skill's VERIFY `summary_contract` should require an evidence field containing captured output (test output, lint result, PoC transcript), not assertions. The contract validator should fail-loud if the evidence field is a bare claim.
5. **Harden against verifier gaming (highest incentive: security skills).** Keep cross-model discipline; for high-stakes gates, add a second independent verifier and require agreement. Prefer evidence the actor cannot fabricate (executed output over asserted output).

## Task-to-Loop Mapping

Match the loop stack to the task's verifiability and step-predictability:

| Task Type | Primary Loops | Oracle Strength | Key Risk | Penny Skill |
|-----------|--------------|----------------|----------|-------------|
| Coding | L2+L3 (+L4 gates) | High (tests/lint) | Premature "done" | `code` (engine) |
| Security | L5+L4 (+bounded L3) | High on PoC, low on triage | Verifier gaming | `sca`, `jsa` |
| Research | L5+L1 fan-out+L2+L6 | Low (source grounding) | Shallow/premature report | `research` |
| Scheduling/automation | L7+L5 (+L4 before side effects) | High but narrow | Double-execution, silent retry | Watchers/digests |
| Long-horizon | L5+L6, engine owns continuity | Mixed, drifting | Lost loop state across sessions | Engine + MemPalace |

**Principle:** Tasks with crisp external oracles (code: tests; security: PoC execution) can lean hard on tight verifier-gated retry loops. Fuzzy-oracle tasks (research quality, writing) must lean on HITL gates and structured criteria because the verifier is weak.

## Loop-Quality Recommendations (status)

Five concrete recommendations from the research, ordered by leverage. As of 2026-07-14, Recs 1–4 are implemented in the engine (`apps/orchestration/`); Rec 5 remains open.

### Rec 1 — Enforce a strategy delta between retries (anti-paralysis) — CLOSED (default-on)

`max_iterations` caps how many retries, but nothing required each retry to be different. Now the base `progress_check` is **default-on**: a retry SUMMARY that explicitly declares a `strategy_change` ~identical to the prior recorded iteration's escalates instead of looping. The engine auto-records per-iteration digests (deduped against playbook `record_iteration` calls) so the guard is fed even for playbooks that never opt in. Opt-out: `LOOP_GUARDS = False`; playbooks with their own `progress_check` override are unaffected.

### Rec 2 — Add a stall / progress-assessment gate (meta-cognition) — CLOSED (default-on)

The same default-on base `progress_check` compares successive recorded iterations' `gaps`: identical non-empty gaps across the window mean no measurable progress, and the run escalates to the human (L4) rather than burning the remaining budget. Backing it up, the engine's iteration-budget backstop forces **honest exhaustion** (complete, `met=False`, `exhausted` reason in the result) on any playbook that routes past its `max_iterations` — never a fake pass, never a silent spin to `STEP_CAP`.

### Rec 3 — Retrieve past-run reflections at run start (close the L6 loop) — CLOSED

The engine's `start()` calls `recall_lessons` (atom F2, `orchestration/recall.py`): a best-effort MemPalace query over `penny/system_amendments` seeds up to 3 distilled lessons into the **first** agent directive as explicitly advisory context. No routing reads them — a past lesson never hard-gates a new run. Opt-out: `PENNY_RECALL=0` or `constraints={"recall": false}`.

### Rec 4 — Require externally-grounded evidence in VERIFY contracts — CLOSED

A state contract may declare `evidence` fields; the validator fails loud when they are empty (a PASS on a bare claim is a contract violation). The engine additionally captures any non-empty SUMMARY `evidence` into `ctx.verify_evidence`, and the outcome ledger records it — outcome+evidence, not outcome alone.

### Rec 5 — Harden verifiers against gaming (highest-incentive: security skills) — OPEN

Keep cross-model VERIFY discipline. For high-stakes gates, add a second independent verifier and require agreement. Prefer evidence the actor cannot fabricate (executed output over asserted output). Treat as defense-in-depth, not a solved problem.

## Related Documents

- [Atomic Loop Components](../architecture/atomic-loop-components.md) — the parts beneath these loop classes: the 18-atom catalog, assembly invariants, control-flow dial, and pre-ship checklist
- [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md) — the ratchet these loops must comply with (protect capabilities, prune constraints)
- [Resilience](resilience.md) — Error handling and recovery on the engine
- [Orchestration](orchestration.md) — Engine-backed skill protocol
- [Skill Standard](skill-standard.md) — Complete skill reference specification
- [State Machine Reference](../state-management/state-machine-reference.md) — FSM patterns on the engine
- [Loops (Human)](../../humans/skills/loops.md) — Conceptual overview and rationale