# Agentic Loops

## What Is a Loop?

An AI agent is, at its core, an LLM in a loop with tools. It takes in some input, the model reasons about what to do, it calls a tool, it looks at the result, and it goes around again until the task is done or it hits a limit. That cycle is the **agent loop**, and it's the one feature that separates an agent from a chatbot: a chatbot answers in a single pass; an agent persists and adapts across many steps.

The universal loop shape, validated across academic research and industry practice, is:

```
gather context → take action → verify work → repeat
```

In Penny, this maps to six operations:

```
FRAME → PLAN → ACT ⇄ VERIFY → LEARN → (repeat or complete)
```

## Why Loops Matter

Loop quality is the difference between an agent that works and one that doesn't. The two failure modes are symmetric and both are catastrophic:

- **Infinite loops / paralysis:** The agent keeps retrying a failed action without changing strategy. It burns tokens, time, and money producing nothing. The documented cause is always the same: no strategy delta between retries, and no mechanism to detect that the loop is stuck.

- **Premature termination:** The agent declares partial work complete. It produces something that looks done but isn't. The documented cause: a verifier that's too weak, or absent — the agent asserts completion without external proof.

Both trace back to the same root cause: **the goal wasn't verifiable, or the loop had no off-switch.**

## The Seven Loop Classes

Loops are not alternatives — they **nest**. A production system layers seven classes, each running inside the one above it:

| #      | Loop Class               | What It Does                                                 | Penny Mechanism                                            |
| ------ | ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **L1** | Inner tool-use (ReAct)   | Thought → action → observation, per agent invocation         | Pi runtime (per subagent)                                  |
| **L2** | Verifier / critic gate   | Separate evaluation decides: converge or cycle back          | `done_predicate`, Vera/Carren split, SUMMARY contracts     |
| **L3** | Retry / repair (bounded) | On failure, repair and retry under a budget                  | `max_iterations`, `learn_retry`/`learn_exhausted`          |
| **L4** | Human-in-the-loop gates  | Planned checkpoints for approval or escalation               | Planned gates, UNCERTAIN → `awaiting_clarification`        |
| **L5** | Orchestration FSM        | Explicit states, typed transitions, checkpointing, resume    | TypeScript playbook + durable checkpointer                 |
| **L6** | Reflection / memory      | Optional, gated learning between runs without weight updates | Primary-only durable recall/curation; never worker handoff |
| **L7** | Background / scheduled   | Time-triggered polling, monitoring, maintenance              | Heartbeats                                                 |

```
┌─ L7 Background loops ─────────────────────────────────────────────┐
│ ┌─ L6 Reflection loop (learning across runs) ───────────────────┐ │
│ │ ┌─ L5 Orchestration loop (FSM, checkpointed) ───────────────┐ │ │
│ │ │ ┌─ L4 HITL gates (approve / refine / deny) ────────────┐ │ │ │
│ │ │ │ ┌─ L3 Retry / repair loop (bounded budget) ─────────┐ │ │ │ │
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

The seven classes are not the ground floor. Beneath them is a set of **16 core atomic components**—reusable building blocks (an event log, a budget counter, a verifier, a safety gate, parallel-execution machinery, explicit memory retrieval) that snap together into loops. The seven classes are common _arrangements_ of those parts. The reason this matters: it lets Penny build a loop for any task without reaching for a one-size-fits-all loop, and it keeps loops from ageing badly as models improve because all model judgment stays behind one intelligence interface (`Decide` plus optional fresh-context `Critique`). See [Atomic Loop Components](../architecture/atomic-loop-components.md) for the atomhood rule, the optional L6 learning arrangement, and the [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md) for why it is built this way.

### Key Finding: Verifier Loops Are Load-Bearing

The single strongest finding from the research: removing Voyager's verification critic caused a **−73% performance drop** — the most impactful feedback component in the system. Verifiers are not optional polish; they are the mechanism that makes loops converge.

### Key Finding: External Feedback Beats Self-Critique

Pure LLM self-critique hallucinates violations and over-corrects. Rules-based feedback (tests, lint, schema validation) is the strongest verifier. LLM-as-judge is valid but weak. An LLM verifier should be positioned as an **interpreter of external evidence**, not as the evidence itself.

## Which Loops Apply to Which Tasks

Match the loop stack to the task's verifiability and step-predictability:

| Task Type        | Primary Loops       | Oracle Strength            | Key Risk                   |
| ---------------- | ------------------- | -------------------------- | -------------------------- |
| **Coding**       | L2+L3 (+L4 gates)   | High (tests/lint)          | Premature "done"           |
| **Security**     | L5+L4 (+bounded L3) | High on PoC, low on triage | Verifier gaming            |
| **Research**     | L5+L1 fan-out+L2+L6 | Low (source grounding)     | Shallow/premature report   |
| **Scheduling**   | L7+L5 (+L4)         | High but narrow            | Double-execution           |
| **Long-horizon** | L5+L6               | Mixed, drifting            | Lost state across sessions |

**Principle:** Tasks with crisp external oracles (code: tests; security: PoC) can lean hard on tight verifier-gated retry loops. Fuzzy-oracle tasks (research, writing) must lean on HITL gates and structured criteria because the verifier is weak.

## How Penny Implements Loops

Penny's architecture is already aligned with what the research prescribes:

1. **The universal shape is methodology, not a base class.** The six operations (FRAME→PLAN→ACT⇄VERIFY→LEARN) are guidance. Each skill implements its own specialized TypeScript playbook with domain-named states behind the common interface.

2. **The engine owns continuity, not the model.** Sessions are memoryless. The durable `run_id` checkpointer persists state after every step. `recover_pending` auto-resumes interrupted runs. Everything routing-relevant lives in `RunContext`, never in an agent's context window.

3. **The FSM is a safety mechanism.** An FSM whose only edges are the intended loop edges cannot wander into an unintended cycle. The graph boundary defines what actions are even possible, reducing the frequency and severity of runaway loops.

## Four Loop-Quality Leverage Points

The research identified four current leverage points. Penny has acted on each, although verifier authenticity remains an open frontier; the agent-facing [Loops reference](../../agents/skills/loops.md) and [Atomic Loop Components](../architecture/atomic-loop-components.md) hold the operational detail:

1. **Enforce a strategy delta between retries** — Require the LEARN SUMMARY to state what will be done differently. Reject or escalate a repeated strategy.

2. **Add stall detection and honest exhaustion** — Compare successive gap/evidence records. If no progress occurs, escalate or terminate incomplete rather than burning the budget or fabricating success.

3. **Require externally grounded evidence in VERIFY contracts** — A verifier must carry an evidence artifact such as test output, a lint result, or a PoC transcript. Presence is only the floor; executed or otherwise non-fabricable evidence is stronger.

4. **Harden verifiers against gaming** — Cross-model separation and per-finding agreement now provide defense in depth for high-stakes skills. Stronger executed-marker oracles and the appropriate policy for verifier disagreement remain active design work.

Memory is handled separately: the engine does not inject past-run lessons into directives. Agents explicitly retrieve stored context only when it could materially affect the task, and full cross-run learning uses the optional gated L6 curation arrangement.

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
