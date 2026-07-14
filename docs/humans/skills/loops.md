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

| # | Loop Class | What It Does | Penny Mechanism |
|---|-----------|-------------|-----------------|
| **L1** | Inner tool-use (ReAct) | Thought → action → observation, per agent invocation | Pi runtime (per subagent) |
| **L2** | Verifier / critic gate | Separate evaluation decides: converge or cycle back | `done_predicate`, Vera/Carren split, SUMMARY contracts |
| **L3** | Retry / repair (bounded) | On failure, repair and retry under a budget | `max_iterations`, `learn_retry`/`learn_exhausted` |
| **L4** | Human-in-the-loop gates | Planned checkpoints for approval or escalation | Planned gates, UNCERTAIN → `awaiting_clarification` |
| **L5** | Orchestration FSM | Explicit states, typed transitions, checkpointing, resume | `BasePlaybook` engine + durable checkpointer |
| **L6** | Reflection / memory | Learning between runs without weight updates | MemPalace, LEARN, daily compression loop |
| **L7** | Background / scheduled | Time-triggered polling, monitoring, maintenance | Watchers, digests, heartbeats |

```
┌─ L7 Background loops (cron, watchers, digests) ────────────────────┐
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

The seven classes are not the ground floor. Beneath them is a smaller set of **atomic components** — reusable building blocks (an event log, a budget counter, a verifier, a safety gate, parallel-execution machinery, memory) that snap together into loops. The seven classes are just the common *arrangements* of those parts. The reason this matters: it lets Penny build a loop for any task by assembling parts rather than reaching for a one-size-fits-all loop — and it keeps the loops from ageing badly as models improve, because the one component that ever *thinks* is isolated behind a single interface, so a better model upgrades every loop for free. See [Atomic Loop Components](../architecture/atomic-loop-components.md) for the full picture and the [Bitter-Lesson Doctrine](../architecture/bitter-lesson.md) for why it's built this way.

### Key Finding: Verifier Loops Are Load-Bearing

The single strongest finding from the research: removing Voyager's verification critic caused a **−73% performance drop** — the most impactful feedback component in the system. Verifiers are not optional polish; they are the mechanism that makes loops converge.

### Key Finding: External Feedback Beats Self-Critique

Pure LLM self-critique hallucinates violations and over-corrects. Rules-based feedback (tests, lint, schema validation) is the strongest verifier. LLM-as-judge is valid but weak. An LLM verifier should be positioned as an **interpreter of external evidence**, not as the evidence itself.

## Which Loops Apply to Which Tasks

Match the loop stack to the task's verifiability and step-predictability:

| Task Type | Primary Loops | Oracle Strength | Key Risk |
|-----------|--------------|----------------|----------|
| **Coding** | L2+L3 (+L4 gates) | High (tests/lint) | Premature "done" |
| **Security** | L5+L4 (+bounded L3) | High on PoC, low on triage | Verifier gaming |
| **Research** | L5+L1 fan-out+L2+L6 | Low (source grounding) | Shallow/premature report |
| **Scheduling** | L7+L5 (+L4) | High but narrow | Double-execution |
| **Long-horizon** | L5+L6 | Mixed, drifting | Lost state across sessions |

**Principle:** Tasks with crisp external oracles (code: tests; security: PoC) can lean hard on tight verifier-gated retry loops. Fuzzy-oracle tasks (research, writing) must lean on HITL gates and structured criteria because the verifier is weak.

## How Penny Implements Loops

Penny's architecture is already aligned with what the research prescribes:

1. **The universal shape is methodology, not a base class.** The six operations (FRAME→PLAN→ACT⇄VERIFY→LEARN) are documented in SYSTEM.md as guidance. Each skill implements its own specialized loop as a `BasePlaybook` subclass with domain-named states. This is the correct split: universality at the shape level, specialization at the instance level.

2. **The engine owns continuity, not the model.** Sessions are memoryless. The durable `run_id` checkpointer persists state after every step. `recover_pending` auto-resumes interrupted runs. Everything routing-relevant lives in `RunContext`, never in an agent's context window.

3. **The FSM is a safety mechanism.** An FSM whose only edges are the intended loop edges cannot wander into an unintended cycle. The graph boundary defines what actions are even possible, reducing the frequency and severity of runaway loops.

4. **Six of seven loop classes are already implemented** at some level of maturity. The seventh (L6 reflection) has the write side (MemPalace, daily compression) but the read side (retrieving past reflections at run start) is a gap.

## Five Gaps Worth Closing

The research identified five concrete improvements, ordered by leverage:

1. **Enforce a strategy delta between retries** — Require the LEARN SUMMARY to carry a `strategy_change` field stating what will be done differently. Reject retries with no change. This prevents agent paralysis.

2. **Add stall detection** — Compare successive iterations' verifier evidence. If no progress for N iterations, escalate rather than burn the remaining budget.

3. **Retrieve past-run reflections at run start** — Query MemPalace for reflections tagged to this skill + task shape. Inject as advisory context into the first agent. Closes the L6 loop from write-only to read-write.

4. **Require externally-grounded evidence in VERIFY contracts** — Each skill's VERIFY contract should demand an evidence artifact (test output, lint result, PoC transcript), not an assertion. The validator should fail-loud if the evidence is a bare claim.

5. **Harden verifiers against gaming** — For high-stakes gates (especially security), add a second independent verifier and require agreement. Prefer evidence the actor cannot fabricate.

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