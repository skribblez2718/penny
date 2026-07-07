# PRD Skill — Frontier Evaluation & Design Rationale

> Companion to `flow.mmd` (the FSM diagram). Method: web research performed manually via the Playwright browser. Primary source fetched verbatim = Anthropic, *Building Effective Agents* (Dec 19 2024), `anthropic.com/engineering/building-effective-agents` (`CERTAIN`). Spec-driven-development practice (Amazon working-backwards / PR-FAQ; GitHub Spec Kit; requirements-engineering INVEST) cited from knowledge (`PROBABLE`).

## Verdict — the design is sound; no material logic redesign warranted.

The prd skill is built on the exact frontier workflow patterns Anthropic documents, and it exceeds the typical bar on one axis (requirement→test traceability). This rationale is now realized directly by the engine playbook (`PrdPlaybook` / `PrdMachine`): the prompt chain, the programmatic gate, the evaluator-optimizer loop, and clarify-first HITL are all encoded as FSM states, transitions, and the engine's escalation seam.

## Mapping to frontier patterns (Anthropic, `CERTAIN`)

| Anthropic pattern | Definition (verbatim-derived) | prd implementation |
|---|---|---|
| **Prompt chaining** | "decompose a task into a sequence of steps… add programmatic **gate** checks on intermediate steps" — *example: "Writing an outline of a document, checking that the outline meets certain criteria, then writing the document."* | `intake → generating → validating` is exactly this chain; vera's `ideal_state_valid` verdict is the **gate** (the run cannot complete unless it passes). |
| **Evaluator-optimizer** | "one LLM generates a response while another provides evaluation and feedback **in a loop**… effective when we have clear evaluation criteria." | The `validating → generating` revise loop; **vera** evaluates on a different model than the **synthia** generator. |
| **Routing** | "classifies an input and directs it to a specialized followup." | Domain detection in `intake` (`detect_domain`) → domain-specific generation guidance. |
| **Agents: clarify first** | "agents begin with… interactive discussion with the human user. Once the task is clear, plan and operate independently." | The clarify-first first pass: `generating` (clarification mode) → `to_unknown` → `awaiting_clarification` surfaces clarifying questions up front. |
| **Stopping conditions** | "include stopping conditions (max iterations) to maintain control." | The revise loop is bounded by `max_iterations`; on exhaustion the run completes honestly with `met=False`. |

**Beyond the baseline:** the prd skill also emits an **atomic requirement catalog** (REQ-NNN, each testable + prioritized — INVEST-style) and a **verification/traceability matrix** (REQ → test strategy). Requirement→test traceability is a requirements-engineering best practice most PRD tooling omits; it is also the literal embodiment of the "success criteria == verification criteria" spine that the `code` skill consumes.

## One optional enhancement (not implemented)

- **Sectioned generation** (Anthropic *Parallelization → Sectioning*: "each consideration handled by a separate LLM call, allowing focused attention"). Today `generating` is a single synthia call producing all four artifacts. The narrative, the atomic catalog, and the IDEAL_STATE could be generated as parallel sections and stitched — higher focus per artifact. **Tradeoff:** more orchestration + a stitch step for an unproven quality gain; by the Simplicity criterion, only pursue it if evals show the single call is the bottleneck. The engine supports fan-out (`PARALLEL_BY_STATE`) if this is ever warranted.
