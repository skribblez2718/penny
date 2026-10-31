# Agentic Loops

## What Is a Loop?

An AI agent is, at its core, an LLM in a loop with tools. It takes in some input, the model reasons about what to do, it calls a tool, it looks at the result, and it goes around again until the task is done or it hits a limit. That cycle is the **agent loop**, and it's the one feature that separates an agent from a chatbot: a chatbot answers in a single pass; an agent persists and adapts across many steps.

A useful conceptual loop lens is:

```
gather context → take action → verify work → repeat or complete
```

It can be sketched as:

```
FRAME → PLAN → ACT ⇄ VERIFY → LEARN → (repeat or complete)
```

Penny does not require every task or playbook to traverse those six labels. They are a design vocabulary; registered TypeScript playbooks keep only the states and transitions their observed failure modes justify.

## Why Loops Matter

Loop quality is the difference between an agent that works and one that doesn't. The two failure modes are symmetric and both are catastrophic:

- **Infinite loops / paralysis:** The agent keeps retrying a failed action without changing strategy. It burns tokens, time, and money producing nothing. The documented cause is always the same: no strategy delta between retries, and no mechanism to detect that the loop is stuck.

- **Premature termination:** The agent declares partial work complete. It produces something that looks done but isn't. The documented cause: a verifier that's too weak, or absent — the agent asserts completion without external proof.

Both trace back to the same root cause: **the goal wasn't verifiable, or the loop had no off-switch.**

## The Seven Loop Classes

Loops can **nest**. These seven classes describe useful compositions, not mandatory layers in every workflow:

| #      | Loop Class                  | What It Does                                                 | Penny Mechanism                                                                   |
| ------ | --------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **L1** | Inner tool-use (ReAct)      | Thought → action → observation, per agent invocation         | Pi runtime (per subagent)                                                         |
| **L2** | Verifier / critic gate      | Separate evaluation decides: converge or cycle back          | Closed completion admission + playbook-specific review contracts                  |
| **L3** | Retry / repair (policy-led) | On failure, repair when another attempt can add information  | Typed feedback + registered repair/exhaustion routes + `RunContext.maxIterations` |
| **L4** | Human-in-the-loop gates     | Consequence-conditioned approval or blocking escalation      | Declared `await_user`/host continuation states                                    |
| **L5** | Orchestration FSM           | Explicit states, typed transitions, checkpointing, resume    | Registered TypeScript `PlaybookCore` + durable checkpointer                       |
| **L6** | Reflection / memory         | Optional, gated learning between runs without weight updates | Primary-owned writes; optional bounded worker read; never handoff                 |
| **L7** | Background / scheduled      | Time-triggered polling, monitoring, maintenance              | External caller/scheduler resumes durable runs; no general heartbeat loop         |

```
┌─ L7 Background loops ─────────────────────────────────────────────┐
│ ┌─ L6 Reflection loop (learning across runs) ───────────────────┐ │
│ │ ┌─ L5 Orchestration loop (FSM, checkpointed) ───────────────┐ │ │
│ │ │ ┌─ L4 HITL gates (approve / refine / deny) ────────────┐ │ │ │
│ │ │ │ ┌─ L3 Retry / repair loop (actual policy) ─────────┐ │ │ │ │
│ │ │ │ │ ┌─ L2 Verifier / critic gate ──────────────────┐ │ │ │ │ │
│ │ │ │ │ │ ┌─ L1 Inner tool-use loop (per agent) ──────┐ │ │ │ │ │ │
│ │ │ │ │ │ └──────────────────────────────────────────┘ │ │ │ │ │ │
│ │ │ │ │ └──────────────────────────────────────────────┘ │ │ │ │ │
│ │ │ │ └────────────────────────────────────────────────────┘ │ │ │ │
│ │ │ └────────────────────────────────────────────────────────┘ │ │ │
│ │ └────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### These Classes Are Arrangements of Smaller Parts

[Atomic Loop Components](../architecture/atomic-loop-components.md) is an optional construction
lens for arranging reusable capabilities, not a universal late-topology requirement. Use it when
applying that model; a loop lookup does not require the full catalog. Code-owned graphs remain
appropriate for fixed evidence, approval, recovery, or audit dependencies. Open-ended work can use
model-directed search without weakening bounds or gates.

### Key Finding: Evidence-Gated Completion Is Load-Bearing

The single strongest finding from the research: removing Voyager's verification critic caused a **−73% performance drop** — the most impactful feedback component in that system. For Penny, the durable conclusion is not a universal agent order: positive completion needs the strongest independent evidence the task admits, enforced through each playbook's closed completion predicates.

### Key Finding: External Feedback Beats Self-Critique

Pure LLM self-critique hallucinates violations and over-corrects. Rules-based feedback (tests, lint, schema validation) is the strongest verifier. LLM-as-judge is valid but weak. An LLM verifier should be positioned as an **interpreter of external evidence**, not as the evidence itself.

Review order remains playbook-specific: `assess` uses Annie→Carren→Vera; `decide` and `plan` verify with Vera before Carren critiques; `diagnose` uses Vera as its sole review stage; `produce` critiques with Carren before Vera verifies; `research` validates with Vera before optional Carren report critique; and knowledge-base composition uses Synthia→Carren lint→Vera verification before consequence-conditioned human review.

## Which Loops Apply to Which Tasks

Match the loop stack to the task's verifiability and step-predictability:

| Task Type        | Primary Loops          | Oracle Strength            | Key Risk                   |
| ---------------- | ---------------------- | -------------------------- | -------------------------- |
| **Coding**       | L2+L3 (+L4 gates)      | High (tests/lint)          | Premature "done"           |
| **Security**     | L5+L4 (+policy-led L3) | High on PoC, low on triage | Verifier gaming            |
| **Research**     | L5+L1 fan-out+L2+L6    | Low (source grounding)     | Shallow/premature report   |
| **Scheduling**   | L7+L5 (+L4)            | High but narrow            | Double-execution           |
| **Long-horizon** | L5+L6                  | Mixed, drifting            | Lost state across sessions |

**Principle:** Tasks with crisp external oracles (code: tests; security: PoC) can lean hard on tight verifier-gated repair. Fuzzy-oracle tasks (research, writing) need explicit evidence criteria and may use separate critique or human review when consequence and measured value justify them; fuzziness alone does not require a planned HITL gate.

## How Penny Implements Loops

Derive values from actual operator policy, not test constants or model guesses. Honor optional operator controls; do not invent finite agent-call, step, phase-cycle, repair, or correction allowances. Trusted progress/inactivity, cancellation, measured failure handling, authorization and honest completion still govern work.

Penny's architecture is already aligned with what the research prescribes:

1. **The loop shape is a lens, not universal procedure or a base class.** Each registered TypeScript `PlaybookCore` implements domain-named states behind the common engine interface and omits phases that have not earned their cost.

2. **The engine owns continuity, not the model.** Sessions are memoryless. The durable `run_id` checkpointer persists state after every step. `recover` reissues pending work from its checkpoint. Everything routing-relevant lives in `RunContext`, never in an agent's context window.

3. **The FSM is a safety mechanism.** An FSM whose only edges are the intended loop edges cannot wander into an unintended cycle. The graph boundary defines what actions are even possible, reducing the frequency and severity of runaway loops.

## Four Loop-Quality Leverage Points

The research identified four current leverage points. Penny has acted on each, although verifier authenticity remains an open frontier; the agent-facing [Loops reference](../../agents/skills/loops.md) and [Atomic Loop Components](../architecture/atomic-loop-components.md) hold the operational detail:

1. **Enforce a strategy delta through typed feedback** — Each playbook's repair evaluator returns a non-empty `strategy_delta`; the engine resolves exactly one registered repair route, charges `RunContext.iteration`, and records feedback digests.

2. **Stop exact recurrence where it is measurable** — Opted-in skills fingerprint the relevant candidate, evidence and failed checks. A repeated fingerprint, including A/B/A across restart, stops incomplete before another repair. The measurements differ by skill: Assess/Diagnose cannot measure analysis/evidence gaps and stop measuring product gaps once upstream prose changes. `null` means unmeasurable, not progress or stall. A changed fingerprint does not prove progress; exact matching cannot guarantee detection of semantic stagnation. This adds no duration or count cap. Research's native issue-history and host inactivity controls remain separate.

3. **Require domain-appropriate evidence** — Bind verdicts to the exact product and independent support: executed output for checks, authoritative-source references for source claims, or separately collected data. Before verification, the host runs native mechanical checks; these establish custody, shape and lineage, not semantic approval or absence of effects. Missing verification support yields `UNVERIFIABLE` and a negative `verification_incomplete` outcome, not an author-repair loop. That differs from a valid product honestly describing blocked, unresolved or partial work.

4. **Harden verifiers against gaming** — Model diversity may supplement evidence when required by a registration or justified by measurement; agreement is not proof of authenticity. Stronger reproducible checks and the policy for missing support or disagreement remain domain-specific.

Memory is handled separately: the engine does not inject past-run lessons into directives. The primary explicitly retrieves or curates stored context only when it could materially affect the task. A catalog worker may receive an owner-granted, YAML-declared bounded read-only bundle, but never memory writes, advisory-log access, or memory-based handoff; skill drivers receive none. Full cross-run learning uses the optional gated L6 curation arrangement.

## Research Basis

This documentation synthesizes a deep-research pack produced via Penny's research workflow: 5 search angles, 21 sources fetched, 104 claims extracted, top 25 adversarially verified by 3-vote panels (25 confirmed, 0 refuted). Sources include:

- **Academic:** ReAct (Yao et al. 2022), Reflexion (Shinn et al. 2023), Voyager (Wang et al. 2023), "LLMs Cannot Self-Correct Reasoning Yet" (Huang et al. 2024), agent surveys (arXiv 2311.11797, 2601.12560)
- **Industry:** Anthropic (Building Effective Agents, long-running agents, multi-agent research), OpenAI (Practical Guide to Building Agents), LangChain/LangGraph, Addy Osmani

Full research pack with annotated bibliography, verification stats, and caveats: `research/loop-research/`

## Related Documents

- [Atomic Loop Components](../architecture/atomic-loop-components.md) — the building blocks these loop classes are assembled from, and why the design ages well
- [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md) — the philosophy behind protecting capabilities and pruning scaffolding
- [Skill Orchestration](orchestration.md) — How skills run on the engine
- [Skill Standard](skill-standard.md) — Complete skill specification
- [Loops (Agent Reference)](../../agents/skills/loops.md) — Operational reference for playbook authors
