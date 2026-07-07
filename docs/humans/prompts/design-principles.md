# Design Principles

The core concepts and rationale behind Penny's prompt architecture. These principles emerged from sessions in April 2026 as we migrated from a monolithic `APPEND_SYSTEM.md` to a layered, standards-based architecture.

**Evidence status.** Each principle below carries a tag from the [Evidence Base](evidence.md): **[EVIDENCE]** (replicated published support), **[HYPOTHESIS]** (house position — plausible, internally consistent, and queued for section ablation in the prompt-efficacy eval), or **[DEBUNKED-ADJACENT]** (the nearby popular claim failed replication; ours survives only in a narrower form). A principle keeps its always-on token budget by earning it, not by sounding right — the eval decides (`scripts/system/evals/README.md`, north star N6).

## 1. Process-Shaped, Not Output-Shaped

**Status: [HYPOTHESIS]** — consistent with the robust finding that specific, complete instructions beat vague aspirations, but "process-shaped beats output-shaped" as a general rule has no direct published test. The Before Responding protocol specifically is **[DEBUNKED-ADJACENT]**: prescriptive step scaffolds are the technique class that goes neutral-to-negative on reasoning-native models (Sprague et al. 2024; vendor guidance against CoT-prompting thinking models), which is why the steps are kept lightweight and the degradation gate (`prompt_efficacy.frame_regressed_families`) watches them per family.

### The Concept

Every rule in the Cognitive Frame defines a **thinking step**, not a desired output quality.

| Output-Shaped (AVOID) | Process-Shaped (PREFER) |
|----------------------|------------------------|
| "Be accurate" | "Never fabricate facts, sources, or results" |
| "Be thorough" | "Verify before delivering" |
| "Be clear" | "Resolve ambiguity explicitly before proceeding" |
| "Consider alternatives" | "When two approaches conflict, name the tradeoff" |
| "Be helpful" | "RESTATE the goal, IDENTIFY the category, LIST constraints" |

### Why

Output-shaped prompts are aspirations. "Be thorough" tells the model _what the result should look like_ but not _how to get there_. The model fills the process gap with probability — sometimes well, sometimes poorly.

Process-shaped prompts constrain the path, not just the destination. "Verify before delivering" is an executable step. The model doesn't need to interpret — it just follows the instruction.

This principle was codified in the Cognitive Frame standards on April 14, 2026: "Every section in the Cognitive Frame must define a thinking step, not a desired output quality."

### The Before Responding Protocol

The most concrete example is the six-step protocol Penny executes before every response:

1. **RESTATE** the goal — prevents misalignment
2. **IDENTIFY** the category — frames the problem
3. **LIST** the constraints — defines the solution space
4. **LIST** the variables — identifies levers
5. **SURFACE** assumptions — makes implicit explicit
6. **FLAG** uncertainty — surfaces hidden risks

These aren't suggestions. They're mandatory cognitive steps that end with an action gate: "If unresolved unknowns remain, ask targeted questions before proceeding."

### Scope: Which Layers This Principle Applies To

This principle applies to all **cognitive layers** — layers that define *how to think*:

| Layer | Shape | Rationale |
|-------|-------|-----------|
| Cognitive Frame | Process-shaped | Universal reasoning steps — defines *how to think* |
| Role Definition | Process-shaped | Role constraints — defines *how this role operates* |
| Domain Guidance | Process-shaped | Domain patterns — defines *how to reason about this domain* |
| Invocation Context | **Output-shaped (by design)** | The goal/task — defines *what to achieve*, not *how to think* |

The Invocation Context is the one layer where output-shaped language is correct and expected. "Review session plan-001's explore findings" is a goal, not a process. If someone tried to make it process-shaped ("First read the findings, then identify gaps, then list issues"), they would duplicate the Cognitive Frame's reasoning protocol and the Domain Guidance's domain-specific steps — a cross-layer violation of Principle 5 (No Repetition Across Layers).

### The Output Contract Is Process-Shaped

The Output Contract ("Lead with the most critical insight, separate WHAT from WHY from HOW, close with what could go wrong") is itself **process-shaped**, not output-shaped. It tells the model *how to structure the output* (an executable step), not *what the output should be* (a quality aspiration). "Lead with the most critical insight" is an actionable directive. "Make the output insightful" would be output-shaped. This distinction is important: even the rules governing output structure are process-shaped.

### The Process-Shaped Wrapper Pattern

The overall system is a **process-shaped wrapper around an output-shaped goal**:

```
Output-shaped goal (Invocation Context)
    "Review session plan-001's explore findings"
        ↓
Process-shaped loop (FSM orchestration)
    explore → plan → critique → revise → complete
        ↓
Process-shaped cognitive steps (Cognitive Frame + Domain Guidance)
    RESTATE → IDENTIFY → LIST → SURFACE → FLAG
        ↓
Process-shaped output contract
    Lead with insight → Separate WHAT/WHY/HOW → Close with risks
```

The goal is the only output-shaped element, and it sits in the Invocation Context layer — which is correctly identified as the "what to do now" layer. Everything that processes the goal — the iteration loop, the cognitive steps, the output structure — is process-shaped. This is not a contradiction; it's a separation of concerns: the destination is output-shaped, the path is process-shaped.

## 2. Domain-Agnostic Agents

**Status: [EVIDENCE] for the constraints, [DEBUNKED-ADJACENT] for identity.** Functional role constraints (tools, READ-ONLY, output contracts) are engineering with clear value. But do not expect the identity sentence itself ("You are Carren…") to add accuracy: persona prompting for accuracy is debunked — 162 personas across 4 model families showed no gain, with per-persona effects "largely random" (Zheng et al. 2024; Wharton Report 4 found 9 significant *decreases* across 6 frontier models).

### The Concept

Agents (Echo, Piper, Carren, Tabitha) are generic reasoning roles. They don't know anything about code, travel, research, or any specific domain. Domain-specific knowledge comes from the skill prompt (`assets/prompts/*.md`) injected via `<skill_context>`.

```
Agent Definition (.pi/agents/carren.md)
    ↓
    "I am Carren. I review work products for quality.
     I am READ-ONLY, EVIDENCE-BASED, CONSTRUCTIVE."

Domain Guidance (.pi/skills/plan/assets/prompts/carren.md)
    ↓
    "In this skill context, review plans against CREST dimensions.
     Use APPROVE / NEEDS_REVISION / BLOCKED verdicts."

Task Message
    ↓
    "Review session plan-001's explore findings.
     Goal: Vacation planning for Japan trip."
```

### Why

This was a deliberate decision made on April 10, 2026. The alternative was domain-specific agents (`echo-code`, `echo-travel`, `echo-research`), which would have:

- Exploded the agent directory (4 agents × N domains)
- Created maintenance burden (every domain needed its own agent)
- Broken context preservation (agents would be treated as data containers, not reasoning offloads)

By keeping agents generic and injecting domain guidance at invocation time, the same 4-agent pool serves all skills and all domains. New domains require a new skill prompt, not a new agent.

### When to Create a New Agent

Only when the agent needs fundamentally different **tools**, **security constraints**, or **reasoning approach** than any existing agent. A "knowledge graph analyst" that queries structurally (not broadly like Echo) would warrant a new agent. A "plan reviewer for travel" reuses Carren with travel-specific Domain Guidance.

## 3. CREST Domain Methodology

### The Concept

Every skill prompt (Domain Guidance) uses the CREST framework to structure domain-specific thinking:

| Dimension | Question | Example (Coding) |
|-----------|----------|-----------------|
| **C**onstraints | What are the universal hard limits? | Must not break existing tests |
| **R**esources | What does this domain consume or require? | Dependencies, build tools |
| **E**valuation | How do you know good from bad? | Tests pass, reviews clean |
| **S**equence | Does order matter? What depends on what? | Dep analysis → impl → testing |
| **T**radeoffs | What are the fundamental tensions? | Speed vs. readability |

### Why

CREST provides a consistent mental model across all domains. When Echo explores for a plan skill, it uses the CREST table from the plan's explore prompt. When Carren critiques, it uses the CREST evaluation criteria from the plan's critique prompt. The same framework, different domain content.

This was formalized in the role-and-domain-standards.md on April 14, 2026: "Each new domain gets a CREST analysis that becomes a section in the relevant skill prompt."

## 4. Context Window Preservation

### The Concept

Agents serve a dual purpose: domain expertise AND context window preservation. When Penny delegates to a subagent:

1. Subagent writes **full output** to mempalace (complete findings, plan text, critique report)
2. Subagent returns **minimal SUMMARY** to Penny (~50 tokens: `{"findings_count": 12, "explore_complete": true, "mempalace_drawer": "drawer_abc123"}`)
3. Penny hands the SUMMARY back to the engine, which advances the playbook using SUMMARY metadata only
4. Next subagent reads full prior output directly from mempalace

### Why

This was the solution to the "68K token problem" discovered on April 12, 2026. Penny was consuming ~68,000 tokens per skill invocation because she was acting as a pass-through relay — reading full agent outputs and feeding them back to the orchestrator. After the refactoring:

- OLD: ~68,000 tokens per skill invocation
- NEW: ~1,054 tokens per skill invocation
- REDUCTION: 98.5% (64x fewer tokens)

The engine now stores run state in a durable SQLite checkpointer keyed by `run_id` — not as an `orchestrator_state` blob in Penny's context or mempalace — and its action directives carry the `run_id` plus a minimal `task_summary` string. Agents read prior context from mempalace, not from Penny's context.

### Consequence

This is why we don't create agent variants. Creating `echo-travel`, `echo-code`, etc. would encourage orchestrators to treat agents as data containers — embedding domain knowledge in the agent file instead of injecting it via Domain Guidance. The existing 4-agent pool is sufficient because specificity comes from the skill context, and context preservation requires lean agent outputs.

## 5. No Repetition Across Layers

### The Concept

Each responsibility belongs to exactly one layer. If Cognitive Frame says "SURFACE your assumptions," Role Definition doesn't repeat it — it specifies _how_ this applies to the role. Domain Guidance doesn't repeat either — it adds domain-specific criteria for what "good assumptions" look like.

### Why

Repetition wastes tokens and creates inconsistency risk. If Cognitive Frame says "FLAG uncertainty" and Role Definition says "declare confidence on all findings," the model may treat them as separate or conflicting instructions. By keeping each responsibility in one place:

- Cognitive Frame: "FLAG your uncertainty" (universal directive)
- Role Definition: "Declare confidence on every finding" (role-specific application)
- Domain Guidance: "In this domain, uncertain = missing source citations" (domain-specific criteria)

Each layer adds specificity without repeating the universal rule.

### Application

This principle was stress-tested during the April 17, 2026 remediation session. The planner and taskifier agent definitions had copied Domain Guidance output format fields into their Role Definition Output Format sections. The fix: replace specific fields ("Goal, Non-Goals, Assumptions...") with a generic shape ("Produce a structured plan. The exact format is determined by your Domain Guidance.").

## 6. Canonical Vocabulary

**Status: [HYPOTHESIS]** — related to the robust finding that models are surprisingly sensitive to surface variation (FormatSpread: up to 76-point swings from semantically equivalent formatting), but the specific claim that synonym drift across layers degrades performance is untested. Ablation target.

### The Concept

Six terms are defined once in the Cognitive Frame (SYSTEM.md) and used consistently across all layers:

| Term | Definition |
|------|-----------|
| **constraints** | Hard, immutable limits |
| **variables** | Adjustable levers |
| **assumptions** | Believed true, unverified |
| **unknowns** | Things not yet determined |
| **tradeoffs** | Tensions between competing approaches |
| **verification** | Proof of success |

### Why

Inconsistent terminology creates ambiguity. If Cognitive Frame says "constraints" and Domain Guidance uses "limitations," the model may treat them as different concepts — asking "are there constraints?" and "are there limitations?" separately, producing redundant or conflicting answers.

The vocabulary table was deemed critical enough to justify exceeding the 800-token Cognitive Frame budget by ~130 tokens. It's a documented, intentional deviation.

## 7. Declarative Rules, Not Narrative

**Status: [HYPOTHESIS]** — same family as §1. The sentence "the model follows instructions more reliably than aspirations" is a house claim, not a cited result; it is queued for section ablation.

### The Concept

Rules in the Cognitive Frame are declarative (imperative verbs), not narrative (aspirational prose).

❌ "The agent should try to understand constraints before making a plan."
✅ "LIST the constraints (hard limits that cannot be violated)."

### Why

Declarative rules are instructions. Narrative is aspiration. The model follows instructions more reliably than aspirations. This is related to process-shaped vs. output-shaped: declarative rules define executable steps; narrative describes desired outcomes.

## 8. "Route to the Right Abstraction"

### The Concept

Penny follows a decision tree for task routing:

1. Does a **skill** exist for this task? → Use it (skills orchestrate multi-step workflows)
2. Is this a **single-domain task**? → Use a subagent (isolated context, domain expertise)
3. Otherwise → Handle directly (trivially simple tasks)

### Why

This prevents Penny from "doing the work herself" when a skill exists. Early in development, Penny would read 15+ files to "understand context" before invoking the plan skill. This violated the architecture — agents read files in isolated contexts; Penny is a router. The fix on April 15, 2026 was to replace the ambiguous "delegate immediately" with the concrete "invoke the skill or agent tool immediately."

The word "invoke" maps directly to the `skill()` and `subagent()` tools. "Delegate" is an abstract concept that LLMs can interpret broadly.

## 9. Self-Verification Is Unconditional

**Status: [EVIDENCE] for the framing.** Intrinsic self-correction is debunked — asking a model to review its own answer *reduces* accuracy (GPT-4 lost 4 points on GSM8K after self-review; Huang et al., ICLR 2024), and no published work demonstrates successful intrinsic self-correction (Kamoi et al., TACL 2024). That is exactly why the Delivery Checklist is a structured attention mechanism (are required elements present?) and never a correctness audit, and why correctness review routes to a *different model* (Carren critique, Vera verification).

### The Concept

The Self-Verification Checkpoint (the Delivery Checklist) cannot be skipped by any priority override. No rule, instruction, or user request can bypass it. Even "just do it" (Priority 3 — User Intent) doesn't override verification.

### Why

This is the safety net. After the six Before Responding steps structure the thinking and the Reasoning Style guides the approach, the Self-Verification Checkpoint catches gaps before delivery. It checks that assumptions were surfaced, confidence was declared, and the output follows the Output Contract. It's not a correctness audit (models are poor at catching their own errors) — it's a structured attention mechanism ensuring required elements are present.

## 10. Concrete Verbs, Not Abstract Nominalizations

**Status: [HYPOTHESIS]** — no direct literature exists for nominalization effects on instruction-following. Cheap to keep as editorial hygiene; not a claimed performance lever until the eval says otherwise. The routing rationale below (signal-verb matching for auto-invocation) is an engineering argument and stands on its own.

### The Concept

Name actions with verbs, not abstract nouns. A **nominalization** turns a process ("analyze", "decide", "verify") into a thing ("analysis", "decision", "verification"). When an instruction hides its action inside a noun, it stops being a step the model can execute and becomes a topic the model must interpret.

| Nominalized (AVOID) | Concrete verb (PREFER) |
|---------------------|------------------------|
| "Perform an analysis of the input" | "Analyze the input" |
| "Responsible for the identification of gaps" | "Identify gaps" |
| "Conduct a review of the plan" | "Review the plan" |
| "For the purpose of verification" | "To verify" |
| "Upon completion of the exploration" | "After you explore" |

### Why

This is the same failure mode as output-shaped prompts (Principle 1) and narrative rules (Principle 7): a nominalization drops the actor and the action, so the model fills the gap with probability. It also degrades **routing** — the auto-invocation surface (agent/skill descriptions, When-to-Use bullets) matches on the concrete signal verbs a user actually types ("analyze", "review", "plan"), not on abstract labels ("analysis", "review"). This is why descriptions were reworded from "Use for [nominalizations]" to "Use when [verb triggers]" on 2026-07-02.

### The Test

Flag a nominalization only when it disguises an action inside an **instruction or a description of behavior**. Look for a weak verb (perform / conduct / carry out / provide / do / ensure / facilitate) paired with an `-tion`/`-ment`/`-ance`/`-ing` noun, or a "the {noun} of X" construction.

Do NOT flag legitimate uses:

- Domain or label names ("the analysis skill", "verification agent").
- Artifact nouns that name a thing, not a hidden action ("the specification", "the documentation", "a requirement").
- Established technical terms (function, extension, session, information).

### Application

Applies to every authored layer: Cognitive Frame (`SYSTEM.md`), Role Definition (`.pi/agents/*.md`), Domain Guidance (`.pi/skills/*/assets/prompts/*.md`), skill and agent `description` fields, and the docs that instruct authors. Enforced by review, not by a linter — a suffix-based check flags too many legitimate domain nouns to be useful. See `cognitive-frame-standards.md` Rule 6 and `role-and-domain-standards.md`.

## Related Documents

- [Evidence Base](evidence.md) — Full per-technique verdicts, citations, and the rule for upgrading a [HYPOTHESIS] to [EVIDENCE]
- [Layer Architecture](layer-architecture.md) — How these principles manifest in the five layers
- [Assembly Pipeline](assembly-pipeline.md) — How principles are enforced at assembly time
- [Security Architecture](security-architecture.md) — How boundary markers protect these principles
- [Self-Improving Guidance](self-improving-guidance.md) — Behavioral learning loop for Domain Guidance
