# Agentic Loops — Reference

How to design, implement, and operate loops in Penny skills. This document is the operational reference for playbook authors and engine contributors. For the conceptual overview and rationale, see [Loops (Human)](../../humans/skills/loops.md).

## A Conceptual Loop Lens

A useful abstract cycle is **gather context → take action → verify work → repeat or complete**:

```
FRAME → PLAN → ACT ⇄ VERIFY → LEARN → (repeat or complete)
```

This is a design lens, not policy in `SYSTEM.md`, a required state sequence, or a base class. Each registered skill implements a TypeScript `PlaybookCoreV1` with domain-named states. The engine supplies stepping, checkpointing, closed contracts, budgets, registered repair, gates, and recovery; each playbook uses only the topology its observed failure modes justify.

**Key principle:** share engine invariants, specialize workflow topology. Do not create a universal procedural base class or force every task through every conceptual phase.

## The Parts Beneath the Loop Classes (Atomic Components)

The seven loop classes below are not primitive — they are **arrangements of a smaller set of atomic components**. Before designing a loop, read [Atomic Loop Components](../architecture/atomic-loop-components.md): 16 atoms in 7 families, with the one structural law that keeps every loop [Bitter-Lesson](../architecture/bitter-lesson.md)-compliant:

> **Intelligence is confined to exactly two atoms (`Decide`, `Critique`). Every other atom is deterministic, model-agnostic host code.** The procedure for solving a task is never coded — it is `Decide`'s runtime output.

The loop classes map directly onto the atoms and the six canonical _arrangements_ of them:

| Loop class (below)      | Atom(s) that implement it                                                                                         | Arrangement                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| L1 Inner tool-use       | `Decide` + `Act` + `Toolspace` (in the pi runtime)                                                                | agent loop                             |
| L2 Verifier gate        | `Verify` (D1, the objective function) + `Critique` (B2)                                                           | evaluator-optimizer                    |
| L3 Retry/repair         | `Budget` (D2) + strategy-changing `Decide`                                                                        | evaluator-optimizer                    |
| L4 HITL gate            | `Gate` (D3) + `Escalate` (D4)                                                                                     | any + consequence boundary             |
| L5 Orchestration FSM    | `Thread`/`Checkpoint`/`Fan` + the engine                                                                          | orchestrator-workers                   |
| L6 Reflection/memory    | `Thread`/`Observe`/`Workspace` + explicit `Recall` + `Compact` + `Decide`/`Critique` + `Verify`/`Ablate` + `Gate` | optional learning/curation arrangement |
| L7 Background/scheduled | scheduled `Checkpoint` resume                                                                                     | background tick                        |

The practical consequence for playbook authors: you are not choosing an architecture, you are **arranging atoms**, and you move between arrangements by re-wiring, not re-building. The [add-side gate](../architecture/atomic-loop-components.md#the-add-side-gate) and [LOAN lifecycle](../architecture/atomic-loop-components.md#the-loan-lifecycle-how-loops-stay-compliant-over-time) govern what you may bake into a loop and when to delete it.

## The Seven Loop Classes

Loops are not alternatives — they **nest**. A production system layers them:

```
┌─ L7 Background/scheduled loops ──────────────────────────────────────┐
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
- The worker receives its task plus exact execution-owner input/output artifact contracts in the engine directive.
- The worker reads supplied exact IDs with `artifact_read`/`next_range`, returns complete stage content, and appends the structured routing SUMMARY.
- The owner persists and verifies exact output before the SUMMARY can advance the loop; payload bytes stay out of `RunContext`.

### L2 — Verifier / Critic Gate

**What:** A separate evaluation step decides whether work converges or cycles back. One agent generates, another evaluates.

**Evidence-gated completion is load-bearing; a separate critic is conditional:** Removing Voyager's critic caused a **−73% drop** in discovered items in that system. Treat this as evidence for grounded evaluation, not as a mandate that every Penny playbook include both verifier and critic roles.

**In Penny:** Closed completion admission plus playbook-specific authoring, verification, and critique states. Vera supplies objective validity judgments; Carren supplies subjective quality judgment or, in `assess`, authored assessment work. Current review ordering differs intentionally by skill: `assess` Annie analysis→Carren authoring→Vera verification; `decide` decision production→Vera verification→Carren critique; `diagnose` diagnosis production→Vera as the sole review stage; `plan` strategy production→Vera verification→Carren critique; `produce` artifact production→Carren critique→Vera verification; `research` Synthia synthesis→Vera validation→optional Carren report critique (with an optional plan critique earlier); and knowledge-base Synthia composition→Carren lint→Vera verification→consequence-conditioned human review.

**Design rules:**

- **External, grounded feedback beats self-critique.** Pure LLM self-critique hallucinates violations and over-corrects. Rules-based feedback (lint, tests, schema validation, environment state) is the strongest verifier. LLM-as-judge is valid but weak.
- **Position the LLM verifier as an interpreter of external evidence, not as the evidence itself.** Vera's `evidence` field MUST contain captured output of verification commands actually run — not assertions.
- **Model-diverse verification:** a different model may supplement the evidence check when it improves measured catch rate; diversity is never independent proof by itself.
- **Per-domain verifier contracts** are where loop quality will be won or lost. Each skill's VERIFY `summary_contract` defines what evidence is required.

### L3 — Retry / Repair Loop (Bounded)

**What:** On verifier failure, repair and retry — under an explicit budget.

**In Penny:** Typed evaluation feedback, registration-contract `repair_routing`, `RunContext.iteration`/`RunContext.maxIterations`, route-specific reserved attempts, honest exhaustion targets, and bounded malformed-result reissue.

**Design rules:**

- **Repairs must identify a strategy delta.** Playbooks return typed `EvaluationResultV2` feedback with `kind`, findings, detail, and non-empty `strategy_delta`. The engine resolves exactly one registered route, records feedback and strategy-delta digests, charges the attempt, and dispatches the route's repair target. Do not invent a universal retry field outside the typed evaluation contract.
- **Budget exhaustion is a legitimate outcome.** Follow the registered exhaustion route and report honestly what was achieved and remains; never fabricate success.
- **Stall handling is playbook- and liveness-specific.** Research compares repeated critique/validation issues; host liveness separately detects repeated protocol failures. Do not claim a universal base progress hook.

### L4 — Human-in-the-Loop Gates

**What:** Planned checkpoints where the agent pauses for approval, refinement, or denial — plus unplanned escalation when blocked or uncertain.

**In Penny:** Playbook-emitted `await_user` gates plus clarification escalation and exact `respond`/`recover` requests.

**Design rules:**

- HITL gates double as a termination control (a hard stop an agent cannot argue its way past)
- HITL gates are the correct response to the paralysis failure mode (escalate rather than spin)
- Place gates before irreversible actions (sending, deleting, publishing) — consistent with Penny's confirm-before-irreversible policy

### L5 — Orchestration Loop (FSM)

**What:** The outer, engine-owned loop: explicit states, typed transitions, guard conditions, checkpointing, resume.

**In Penny:** Registered TypeScript playbooks, durable `run_id` checkpoints, exact `recover`, a hard `max_steps` ceiling, observability events, and bounded parallel fan-out.

**Design rules:**

- **The graph bounds the blast radius.** A playbook whose successor tables and flow descriptor contain only intended edges cannot wander into an unintended cycle; drift tests pin both.
- **The engine owns continuity, not the model.** Long-horizon loops must be reconstructed each session from persisted external state, because sessions are memoryless. Everything routing-relevant lives in `RunContext`, never implicitly in an agent's context.
- **States must be safe to re-run** (crash-resume re-issues the pending step). An ACT-style state must be idempotent or split author/apply.

### L6 — Reflection / Memory-Learning Loop

**What:** Optional learning between runs without weight updates: capture grounded outcomes, retrieve relevant prior material, propose and test reusable lessons, authorize promotion, and reuse approved artifacts later.

**In Penny:** The unmarked primary runtime owns curated writes, diary retention, and governed temporal KG lifecycle operations. Catalog workers may receive bounded read-only recall/KG access when their owner-materialized active tool list includes YAML-declared memory reads; they never receive memory writes, advisory logstream access, or memory-based handoff. Skill drivers receive no memory tools. The orchestration engine does **not** inject retrieved memory into directives; active handoff uses exact artifacts. Full L6 is the [optional learning/curation arrangement](../architecture/atomic-loop-components.md#optional-learningcuration-arrangement-l6), not a single Recall call.

**Design rules:**

- **Recall is explicit and relevance-driven.** Retrieve only when prior decisions, preferences, incidents, or work could materially affect the task. Preserve provenance and dates; treat results as advisory task material, never authority.
- **Capture without duplicate truth.** Terminal facts remain in Thread, evidence in Verify/Workspace, and measurements in Observe. Cross-run outcome views are rebuildable projections with no workflow-transition authority.
- **Curate through the existing intelligence and safety atoms.** Decide proposes; Critique challenges; Verify/Ablate measures; Gate authorizes consequential promotion; Act writes the approved artifact.
- **Guard against confirmation bias and mode collapse.** A remembered lesson cannot hard-gate a new run, expand permissions, or silently change completion criteria.
- **Adapt verification per domain.** Reflexion used environment success for AlfWorld, self-generated unit tests for coding, and exact match for QA—the learning arrangement is not fully task-agnostic.

### L7 — Background / Scheduled Loops

**What:** Time- or event-triggered outer loops: polling, monitoring, recurring maintenance.

**In Penny:** This is a composition pattern, not a general current progress-heartbeat capability. A caller or scheduler may start/resume bounded orchestration work through the public engine surface; durable checkpoints make that resume possible. Progress events are observational telemetry, not autonomous ticks and not a separate handoff channel.

**Design rules:**

- Bound work per caller/scheduler tick
- Make resume idempotent (a re-fired tick must not duplicate side effects)
- Escalate rather than retry indefinitely when a tick keeps failing
- Treat any scheduler as an external owner of timing; the orchestration engine owns only the resumed run's state and transitions

## Termination Controls

From the research, in order of strength:

| #   | Control                        | What It Does                                            | Penny Mechanism                                               |
| --- | ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Verifier-gated success         | Success termination only when required gates pass       | closed `CompletionGate` v2 + durable admission envelope       |
| 2   | Bounded iteration budgets      | Hard cap on repairs; exhaustion is a legitimate outcome | `RunContext.maxIterations` + registered exhaustion route      |
| 3   | Structured completion criteria | Closed predicates checked before positive completion    | `CompletionGate` v2 + completion admission evidence           |
| 4   | Human-in-the-loop checkpoints  | Gate consequence-bearing actions or resolve blockers    | `await_user`/host continuation where the playbook declares it |
| 5   | Global step caps               | Backstop of last resort                                 | `RunContext.maxSteps`                                         |

## Failure Modes

Every loop must defend against both ends of the same axis:

### Infinite Loops / Agent Paralysis

**Symptom:** Agent continuously retries a failed action without modifying its strategy. Still struggles with giving up or asking for human help.

**Cause:** No meaningful strategy delta, an incorrect repair route, or repeated no-progress evidence.

**Fix:**

- Require typed evaluation feedback with a non-empty `strategy_delta`
- Register exactly one repair/exhaustion route for each admitted feedback kind
- Add playbook-specific stall detection where repeated evidence is measurable; terminate or escalate according to the registered consequence rather than spinning

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

The canonical [`Verify` strength hierarchy](../architecture/atomic-loop-components.md) — **oracle > rules > proxy > critic**:

| Strength              | Tier                      | Example                                                                    | Use When                                                                           |
| --------------------- | ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Strongest             | **Oracle**                | Test suite, compiler, executed protocol check, environment state           | A crisp external truth exists                                                      |
| Strong                | **Rules**                 | Schema validation, lint, deterministic invariant, claim-to-source matching | Structured output or any checkable invariant                                       |
| Weak (Goodhart-prone) | **Proxy**                 | A gameable measurable stand-in such as keyword overlap                     | Only as an assist that feeds a stronger judge — never as the gate                  |
| Weakest               | **Critic** (LLM-as-judge) | Cross-model review, Carren critique                                        | Fuzzy criteria such as research quality or design review — never the sole verifier |

Same-model self-critique is the degenerate critic and must not be the sole gate. Climb each VERIFY state to the strongest tier its output admits. Where no oracle exists, place a deterministic rules floor beneath the critic or supply a clearly labeled proxy as evidence for the interpreter, never as a rule that silently decides the verdict.

### Design Rules

1. **External, grounded feedback beats self-critique.** Pure LLM self-critique hallucinates violations and over-corrects. Without an oracle, LLMs cannot reliably self-correct.
2. **Position the LLM verifier as an interpreter of external evidence, not as the evidence itself.** Vera produces PASS/FAIL — the PASS must be backed by captured tool output, not by the model's say-so.
3. **Model diversity is supplementary.** Use a different verifier model when measured benefit justifies it, but bind verdicts to sources, tools, or other independent evidence.
4. **Demand evidence artifacts in VERIFY contracts.** Each skill's VERIFY `summary_contract` should require an evidence field containing captured output (test output, lint result, PoC transcript), not assertions. The contract validator should fail-loud if the evidence field is a bare claim.
5. **Harden against verifier gaming (highest incentive: security skills).** Keep cross-model discipline; for high-stakes gates, add a second independent verifier and require agreement. Prefer evidence the actor cannot fabricate (executed output over asserted output).

## Task-to-Loop Mapping

Match the loop stack to the task's verifiability and step-predictability:

| Task Type             | Primary Loops                                        | Oracle Strength                | Key Risk                       | Penny Skill                        |
| --------------------- | ---------------------------------------------------- | ------------------------------ | ------------------------------ | ---------------------------------- |
| Coding/production     | L2+L3; L4 only when consequences require it          | High (tests/lint)              | Premature "done"               | Direct/delegated work or `produce` |
| Assessment/diagnosis  | L2; bounded L3 when registered                       | Evidence and rule application  | Unsupported findings           | `assess` or `diagnose`             |
| Decision/planning     | L2+L3; L4 only when consequences require it          | Mixed                          | Critique replacing evidence    | `decide` or `plan`                 |
| Research              | L5+L1 fan-out+L2 (optional primary L6 across runs)   | Source grounding               | Shallow or unsupported report  | `research`                         |
| Knowledge-base work   | L5+L2+L3 with operation-conditioned L4               | Source support + semantic lint | Publishing unsupported claims  | dedicated `knowledge_base` ingress |
| Scheduling/automation | externally scheduled L7+L5 (+L4 before side effects) | High but narrow                | Double execution, silent retry | caller/scheduler + engine resume   |

**Principle:** Tasks with crisp external oracles can lean on tight verifier-gated retry loops. Fuzzy-oracle tasks must lean on explicit evidence criteria and human escalation because model judgment is weaker than an oracle.

## Loop-Quality Recommendations

Four concrete recommendations from the research, ordered by leverage. Current engine implementation status is tracked in [Atomic Loop Components](../architecture/atomic-loop-components.md) (“How this maps onto Penny today”), not duplicated here — a frozen status list rots the moment a gap closes.

### Rec 1 — Enforce a strategy delta through typed repair feedback

Each current playbook's `evaluateRepair` returns validated `EvaluationResultV2` feedback with a non-empty `strategy_delta`. The engine resolves exactly one matching `repair_routing` entry, charges `RunContext.iteration` against `RunContext.maxIterations` and reserved attempts, prevents repair bookkeeping from changing engine-owned control fields, and records detail/strategy-delta digests in route evidence. Playbook authors must express repair behavior in that registration contract rather than add Python-era base-loop fields.

### Rec 2 — Add measured stall handling only where evidence supports it

There is no universal base progress hook. Research records normalized issue histories and can stop when critique or validation issues repeat without measurable progress; host liveness separately caps repeated malformed/protocol outcomes. Every playbook still has a registered exhaustion path, and positive terminal results pass the closed completion-admission gate. Add broader stall logic only with a measurable signal and tests, not as mandatory scaffolding.

### Rec 3 — Require externally-grounded evidence in VERIFY contracts

A state contract may declare `evidence` fields; the validator fails loud when they are empty, so a PASS on a bare claim is a contract violation.

**The contract check is non-emptiness only, not authenticity.** The validator cannot distinguish a captured transcript from a plausible fabrication. Prefer evidence generated by an independent tool or authoritative source and bind the verifier's verdict to that evidence. Contract non-emptiness is the floor; independently reproducible evidence is the defense.

### Rec 4 — Harden verifiers against gaming

Model diversity is supplementary scrutiny, not independent evidence. The research playbook exposes `validate_model` so its citation gate can use a different model from synthesis. The stronger controls remain captured source checks, deterministic contract validation, reproducible tool output, and honest unresolved-claim reporting.

Open questions remain empirical: when a second verifier materially improves catch rate, when disagreement should escalate instead of hard-fail, and which evidence can be generated outside the actor's control. Measure those choices before turning them into permanent scaffolding.

## Related Documents

- [Atomic Loop Components](../architecture/atomic-loop-components.md) — the parts beneath these loop classes: the 16-atom catalog, assembly invariants, control-flow dial, and pre-ship checklist
- [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md) — the ratchet these loops must comply with (protect capabilities, prune constraints)
- [Resilience](resilience.md) — Error handling and recovery on the engine
- [Orchestration](orchestration.md) — Engine-backed skill protocol
- [Skill Standard](skill-standard.md) — Complete skill reference specification
- [State Machine Reference](../state-management/state-machine-reference.md) — FSM patterns on the engine
- [Loops (Human)](../../humans/skills/loops.md) — Conceptual overview and rationale
