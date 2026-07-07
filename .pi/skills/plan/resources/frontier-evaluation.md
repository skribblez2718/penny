# Plan Skill — Frontier Evaluation & Design Rationale

> Companion to `flow.mmd`. Method: web research performed manually via the Playwright
> browser. Primary source fetched verbatim = Anthropic, *Building Effective Agents*
> (Dec 19 2024) (`CERTAIN`). Classical planning (HTN methods, plan-and-solve,
> tree-of-thought) cited from knowledge (`PROBABLE`).

## Verdict — logic is frontier-aligned

The plan skill's lifecycle composes the frontier workflow patterns; no redesign of the
logic is warranted. The design rationale below is now realized directly by the engine
playbook (`PlanPlaybook`) — the states, the verify gate, the escalation subsystem, and the
parallel exploration fan-out are all concrete FSM features, not aspirations.

## Mapping to frontier patterns (Anthropic, `CERTAIN`)

| Anthropic pattern | Definition | plan implementation |
|---|---|---|
| **Prompt chaining** | decompose into a sequence of steps with inter-step checks | `exploring → planning → critiquing → taskifying` |
| **Evaluator-optimizer** | "one LLM generates… another provides evaluation and feedback **in a loop**" | `planning → critiquing (carren) → {critique_retry_explore \| critique_retry_plan} → planning`; bounded by `max_iterations` |
| **Parallelization → Sectioning** | fan out independent subtasks and aggregate | `exploring` fans out three parallel `echo` branches (entrypoints, tests, config) |
| **Agents: human checkpoints** | "agents can pause for human feedback **at checkpoints** or when encountering blockers" | `verify_gate` — pauses for user confirmation on **high-stakes / irreversible** plans |
| **Agents: clarify + blockers** | "returning to the human for further information or judgement" | `to_unknown → escalate → awaiting_clarification` from any escalatable working state |
| **Stopping conditions** | "max iterations to maintain control" | revise loop bounded by `max_iterations`; explore rounds capped at 2 |

The `exploring → planning → critiquing → taskifying` chain also mirrors classical planning:
gather context (OBSERVE) → strategic plan (piper) → critique → atomic task breakdown
(tabitha). The **verify gate** is the reversibility check Penny's operating rules require
before irreversible action — a deliberate design choice, realized as a real engine gate
(`GATE_STATES = {verify_gate}`) entered only when verification is warranted.

## Realized design points

- **Sectioned exploration** (Anthropic *Parallelization → Sectioning*). `exploring` is a
  parallel `echo` fan-out across three focuses, aggregated on fan-in before planning — the
  multi-angle coverage this analysis called for.
- **Honest loop exhaustion.** The critique loop no longer force-approves at the iteration
  cap. A stalled loop (the same issues persisting) escalates to the user; true budget
  exhaustion completes with `met=False` and reports the unresolved issues.
- **Durable HITL.** Both the verify gate and clarification escalation are engine seams
  backed by the `run_id`-keyed checkpointer, resumed by a `user` step — not in-band
  escalation or transition replay.
