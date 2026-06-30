# Design Principles

The core concepts and rationale behind Penny's prompt architecture. These principles emerged from sessions in April 2026 as we migrated from a monolithic `APPEND_SYSTEM.md` to a layered, standards-based architecture.

## 1. Process-Shaped, Not Output-Shaped

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

## 2. Domain-Agnostic Agents

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
3. Penny advances the state machine using SUMMARY metadata only
4. Next subagent reads full prior output directly from mempalace

### Why

This was the solution to the "68K token problem" discovered on April 12, 2026. Penny was consuming ~68,000 tokens per skill invocation because she was acting as a pass-through relay — reading full agent outputs and feeding them back to the orchestrator. After the refactoring:

- OLD: ~68,000 tokens per skill invocation
- NEW: ~1,054 tokens per skill invocation
- REDUCTION: 98.5% (64x fewer tokens)

The orchestrator now stores state as a blob in mempalace (`orchestrator_state`) and passes minimal `task_summary` strings. Agents read prior context from mempalace, not from Penny's context.

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

### The Concept

The Self-Verification Checkpoint (the Delivery Checklist) cannot be skipped by any priority override. No rule, instruction, or user request can bypass it. Even "just do it" (Priority 3 — User Intent) doesn't override verification.

### Why

This is the safety net. After the six Before Responding steps structure the thinking and the Reasoning Style guides the approach, the Self-Verification Checkpoint catches gaps before delivery. It checks that assumptions were surfaced, confidence was declared, and the output follows the Output Contract. It's not a correctness audit (models are poor at catching their own errors) — it's a structured attention mechanism ensuring required elements are present.

## Related Documents

- [Layer Architecture](layer-architecture.md) — How these principles manifest in the five layers
- [Assembly Pipeline](assembly-pipeline.md) — How principles are enforced at assembly time
- [Security Architecture](security-architecture.md) — How boundary markers protect these principles
