# Prompt Architecture Overview

## The Journey: Why We Built a Prompt Architecture

Penny started as a single `APPEND_SYSTEM.md` file appended to Pi's default coding-assistant prompt. That file grew organically — new rules were added, old rules were never removed, and there was no structure separating universal reasoning from domain-specific guidance. Every interaction burned ~900 tokens just on system instructions, and agents (sub-models) received duplicated, sometimes contradictory directives.

In April 2026, during an [AI gap analysis](../../../plans/ai-gaps-resolution/01-classification.md), we identified six fundamental limitations of LLM-based assistants:

1. **Knowledge vs. Judgment** — LLMs can recall facts but can't exercise judgment in novel situations
2. **No stake in outcomes** — No mechanism to learn from past successes or failures
3. **Cannot initiate** — No proactive awareness or initiative
4. **Uncalibrated confidence** — No reliable self-assessment of certainty
5. **Context collapse across time** — Each session starts fresh; no persistent learning
6. **Cannot be held accountable** — No structured record of decisions and outcomes

The prompt architecture was designed as part of a broader response to these gaps. It addresses gaps #1 (judgment through structured reasoning protocols), #4 (confidence through mandatory calibration), and #5 (context preservation through layered separation and mempalace offloading).

## The Goal, Reframed: Floor versus Points

The original ambition — one universal prompt that raises benchmark performance single-to-double percentage points on any model — is not what the 2024–2026 evidence supports. Prompts are model-specific artifacts: the best format for one family barely overlaps the best format for another, optimized prompts lose ~6–11 absolute points when ported across models, and the generic techniques with big historical effect sizes either apply narrowly (chain-of-thought: math/symbolic only) or failed replication on frontier models entirely (personas-for-accuracy, emotional appeals). See the [Evidence Base](evidence.md) for the numbers and citations.

So the architecture's claim is now two separate claims, each with its own mechanism:

1. **The universal layer raises the floor and cuts variance.** The Cognitive Frame carries the cross-model survivors — completeness, explicitness, non-contradiction, front-loaded critical rules, structural hygiene, and task-specification discipline. Its job is preventing losses (fabrication, silently-guessed ambiguity, skipped verification), not adding benchmark points.
2. **Measurable points come from per-model work.** Per-model variants of the swappable layers (Role Definition, Domain Guidance) optimized against a golden task set, plus per-family invocation parameters. The implementation plan lives in `plans/per-model-optimization/`.

Neither claim is taken on faith: the prompt-efficacy eval (north star N6, `scripts/system/evals/README.md`) measures frame-on vs frame-off per model family, ablates the frame section by section, and fires a CRITICAL signal when the frame measurably hurts a family. The frame pays rent or it gets simplified.

## What the Prompt Architecture Is

The prompt architecture is a **layered system for composing model instructions**. It separates universal reasoning rules from role-specific constraints, domain-specific guidance, project navigation, and turn-specific goals. Each layer has a single responsibility, a defined author, and a specific injection mechanism.

The architecture is governed by two sets of documents:

- **Agent-facing standards** (`docs/agents/prompts/`) — Operational HOW-TO guidance for Penny and subagents. These define what goes in each layer, token budgets, and compliance checklists.
- **Human-facing docs** (`docs/humans/prompts/`) — The WHAT-IS and WHY. These documents you're reading now.

## The Five Layers

| Layer | Function | Source | Changes |
|-------|----------|--------|---------|
| **Cognitive Frame** | How to think (universal reasoning protocol) | `.pi/SYSTEM.md` | Rarely |
| **Role Definition** | Who I am (agent identity and constraints) | `.pi/agents/*.md` | Per agent |
| **Domain Guidance** | How to think about THIS domain | `.pi/skills/*/assets/prompts/*.md` | Per skill |
| **Project Index** | Where things are (file references) | `AGENTS.md` files (auto-discovered) | Per project |
| **Invocation Context** | What to do now (the specific goal) | Task message + Pi runtime | Every turn |

Only three layers are active in direct conversation. All five are active during skill invocations. This means Penny operates with a lean prompt in the common case and gets full domain guidance only when running complex multi-agent workflows.

## Key Innovations

### 1. Named Layers, Not Numbered Layers

Earlier versions numbered layers (L1, L2a, L2b, etc.), conflating scope with injection order. Named layers describe **what each layer does** — Cognitive Frame tells you _how to think_, Domain Guidance tells you _how to think about this domain_. The names are the function.

### 2. Process-Shaped, Not Output-Shaped

Every rule in the Cognitive Frame is a thinking step, not a desired output quality. Instead of "be accurate" (output-shaped), we write "never fabricate facts, sources, or results" (process-shaped). Output-shaped prompts let the model fill the process gap with probability. Process-shaped prompts constrain the path, not just the destination.

This principle applies to all **cognitive layers** (Cognitive Frame, Role Definition, Domain Guidance). The Invocation Context — the goal/task message — is inherently output-shaped by design: it defines *what to achieve*, not *how to think*. The overall system is a **process-shaped wrapper around an output-shaped goal**: the goal (output-shaped) enters the FSM (process-shaped iteration loop), which dispatches agents with cognitive steps (process-shaped), producing output structured by the Output Contract (also process-shaped — it defines *how to structure*, not *what quality to aim for*). The destination is output-shaped; the path is process-shaped. See [Design Principles §1](design-principles.md#1-process-shaped-not-output-shaped) for the full scope.

### 3. Domain-Agnostic Agents

Agents (Echo, Piper, Carren, Tabitha) are generic reasoning roles — explorer, planner, critic, task-decomposer. They're not tied to any domain. A skill's `assets/prompts/*.md` files inject domain-specific guidance (CREST tables, checklists, output formats) via the `<skill_context>` mechanism. The same Carren agent critiques vacation plans, code architectures, and research papers — it just gets different Domain Guidance each time.

### 4. Context Window Preservation

Agents serve a dual purpose. Beyond domain expertise, they preserve Penny's context window. When Penny delegates to a subagent, the subagent's full reasoning is offloaded — it writes complete output to mempalace but returns only a minimal structured SUMMARY (~50 tokens) to Penny. This is why Penny doesn't create agent variants per domain. The existing pool is sufficient because specificity comes from Domain Guidance, not from duplicating agent definitions.

### 5. The Sandwich Defense

XML boundary markers create a security architecture that prevents prompt injection:
- `<system_directives>` at the top (immutable security rules, authored)
- `<agent_boundary>` between system-role content and user-role content
- `<system_boundary>` at the absolute end (appended by the environment extension)

Content between `<agent_boundary>` and `<system_boundary>` is user-role — it cannot override system instructions. The `skillContext` injection respects this by inserting before `<agent_boundary>`, keeping skill prompts as system-role content.

### 6. Self-Improving Guidance

A behavioral learning loop allows Penny to propose improvements based on patterns in the outcome ledger. The loop *auto-proposes* only Domain Guidance and preference changes (universal-frame learnings are logged for a human, not auto-proposed). Once a human approves an amendment's exact diff, Penny *applies* it to any target — including SYSTEM.md — since approving the diff is the human-in-the-loop; the sole exception is the immutable security-directives block, which is never machine-editable. Every change requires evidence (outcome drawer IDs), Carren review, human approval, and a git commit.

## The Token Budget Constraint

The Cognitive Frame is injected into every Penny turn and every subagent, so it is the most-multiplied text in the system — we keep it the leanest and cap it as a forcing-function. Our budgets:

| Layer | Budget | Rationale |
|-------|--------|-----------|
| Cognitive Frame | ≤1,500 tokens | Always-on + multiplied across every subagent — CI-enforced |
| Role Definition | ≤1,200 tokens | Role-specific rules must be lean |
| Domain Guidance | ≤1,000 tokens | Domain guidance, not repetition |
| Total system prompt | ≤3,000 tokens | ~1.5% of a 200K window for instructions |

All counts are measured with **tiktoken** (`cl100k_base`) — the one canonical token counter — never a word-count heuristic. The 1,500-token cap is a forcing-function, not a model limit: there is no hard adherence cliff at a small token count. It keeps the always-on frame lean by pushing conditionally-needed content into `docs/penny/` for on-demand `read` (the extraction pattern). The Cognitive Frame is currently ~1,436 tokens, within budget.

## What This Architecture Replaced

Before the architecture existed:

- One monolithic `APPEND_SYSTEM.md` appended to Pi's default coding prompt
- No separation between universal rules and domain-specific guidance
- "Delegate immediately" was ambiguous — Penny would read 15+ files before delegating
- Agents had no structured identity — they were ad-hoc prompts with no standards
- Skill prompts contained template variables (`{{goal}}`) in system-role content (security risk)
- No token budgets — SYSTEM.md grew without constraint

The migration to `.pi/SYSTEM.md` (replacing Pi's default prompt entirely) and the introduction of layered standards happened across multiple sessions between April 10-17, 2026.

## Related Documents

- [Evidence Base](evidence.md) — What the literature supports, what it debunks, and which principles are hypotheses awaiting our own measurement
- [Layer Architecture](layer-architecture.md) — Deep dive on each layer
- [Assembly Pipeline](assembly-pipeline.md) — How prompts are assembled at runtime
- [Design Principles](design-principles.md) — Core design principles with rationale
- [Security Architecture](security-architecture.md) — Boundary markers and injection defense
- [Self-Improving Guidance](self-improving-guidance.md) — Behavioral learning loop
