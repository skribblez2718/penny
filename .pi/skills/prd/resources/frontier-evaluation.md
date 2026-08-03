# PRD Skill — Design Rationale (dated snapshot: 2024-12 patterns, corrected 2026-07-28)

> **Read this as history, not as law.** This file records *why the shape of the skill is what it
> is*, against the agent-design patterns published as of **December 2024**. It is a point-in-time
> snapshot and is expected to age. It carries **no verdict on whether the design should change** —
> that judgement belongs to the recurring Bitter-Lesson pass
> (`docs/agents/architecture/bitter-lesson.md`), which reads the live code, not this file.
>
> Source: Anthropic, *Building Effective Agents* (Dec 19 2024),
> `anthropic.com/engineering/building-effective-agents` (fetched verbatim, `CERTAIN`).
> Spec-driven-development practice (Amazon working-backwards / PR-FAQ; GitHub Spec Kit;
> requirements-engineering INVEST) cited from knowledge (`PROBABLE`).

## Why the FSM has the shape it has

| Pattern (Dec 2024) | Definition (verbatim-derived) | Where it lives in `PrdMachine` |
|---|---|---|
| **Prompt chaining** | "decompose a task into a sequence of steps… add programmatic **gate** checks on intermediate steps" | `intake → generating → validating`. The gate is `done_predicate` = `valid && ideal_state_valid`. |
| **Evaluator-optimizer** | "one LLM generates a response while another provides evaluation and feedback **in a loop**… effective when we have clear evaluation criteria." | The `validating → generating` revise loop. See the independence caveat below. |
| **Routing** | "classifies an input and directs it to a specialized followup." | Domain selection in `intake`. **Note:** the original keyword `detect_domain` table this row once described was **deleted**; selection is now model-owned (`available_domains()` lists the packs, synthia declares the fit). |
| **Agents: clarify first** | "agents begin with… interactive discussion with the human user." | The clarify-first first pass → `awaiting_clarification`. |
| **Stopping conditions** | "include stopping conditions (max iterations) to maintain control." | `max_iterations`; on exhaustion the run completes with `met=False`. |

**Beyond the baseline:** the skill also emits an atomic requirement catalog (REQ-NNN, testable +
prioritized) and a REQ→test traceability matrix. That traceability is the "success criteria ==
verification criteria" spine the `code` skill consumes.

## Correction (2026-07-28) — independence

An earlier revision of this file claimed *"vera evaluates on a different model than the synthia
generator."* **That was false.** `.pi/agents/synthia.md` and `.pi/agents/vera.md` both declared
`model: sonnet` / `provider: anthropic` at the time of this correction.

> **Fleet update (2026-08-01):** both agents now declare `model: terra` /
> `provider: openai-codex` (OpenAI `gpt-5.6-terra`). The edge is still SAME_MODEL, so the
> correction's conclusion is unchanged — only the model names moved.

The authoritative, self-checking record is **`orchestration/independence.py`**, which resolves each
agent's model *live* from its frontmatter and classifies the prd actor→verifier edge as
`SAME_MODEL`, registered in `SAME_MODEL_EXCEPTIONS` with a rationale and a `review_by` date. Do not
restate an independence claim here — read `independence.classify()`; `tests/test_independence.py`
fails loud if the ledger and the fleet disagree.

## Open enhancement (not implemented)

- **Sectioned generation** (*Parallelization → Sectioning*): today `generating` is a single synthia
  call producing all four artifacts; the narrative, catalog, and IDEAL_STATE could be generated as
  parallel sections and stitched. The engine supports fan-out (`PARALLEL_BY_STATE`). Unmeasured —
  pursue only if evals show the single call is the bottleneck.
