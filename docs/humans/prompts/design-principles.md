# Design Principles

The core concepts and rationale behind Penny's prompt architecture. These principles emerged from sessions in April 2026 as we migrated from a monolithic `APPEND_SYSTEM.md` to a layered, standards-based architecture.

**Evidence status.** Each principle below carries a tag from the [Evidence Base](evidence.md): **[EVIDENCE]** (replicated published support), **[HYPOTHESIS]** (house position — plausible, internally consistent, and queued for section ablation in the prompt-efficacy eval), or **[DEBUNKED-ADJACENT]** (the nearby popular claim failed replication; ours survives only in a narrower form). A principle keeps its always-on token budget by earning it, not by sounding right — the eval decides (`scripts/system/evals/README.md`, north star N6).

## 1. Process-Shaped, Not Output-Shaped

**Status: [HYPOTHESIS]** — consistent with the robust finding that specific, complete instructions beat vague aspirations, but "process-shaped beats output-shaped" as a general rule has no direct published test. The Before Responding protocol specifically is **[DEBUNKED-ADJACENT]**: prescriptive step scaffolds are the technique class that goes neutral-to-negative on reasoning-native models (Sprague et al. 2024; vendor guidance against CoT-prompting thinking models) — which is why the six-step sequence was moved out of the always-on frame into the on-demand clarification protocol (see below), and why the degradation gate (`prompt_efficacy.frame_regressed_families`) watches the frame per family.

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

### From Always-On Protocol to On-Demand Protocol

The six-step RESTATE / IDENTIFY / LIST / LIST / SURFACE / FLAG sequence was originally an always-on "Before Responding Protocol" — mandatory cognitive steps before every response. It no longer lives in the frame. Prescriptive step scaffolds are exactly the prompt content that goes neutral-to-negative on reasoning-native models (the [DEBUNKED-ADJACENT] tag above), and always-on procedure is the class of scaffolding that ages worst as models improve (Principle 11). The sequence survives as the **on-demand clarification protocol** (`docs/penny/clarification-protocol.md`): the frame's Ask vs. Act section states only the *activation condition* (genuinely under-specified, irreversible, high-stakes, or not sure enough to proceed safely), and the full protocol loads only when that trigger fires. The frame keeps single executable directives ("surface constraints and success criteria before work"); the multi-step script became a tool reached for on demand.

### Scope: Which Layers This Principle Applies To

This principle applies to all **cognitive layers** — layers that define *how to think*:

| Layer | Shape | Rationale |
|-------|-------|-----------|
| Cognitive Frame | Process-shaped | Universal reasoning steps — defines *how to think* |
| Role Definition | Process-shaped | Role constraints — defines *how this role operates* |
| Domain Guidance | Process-shaped | Domain patterns — defines *how to reason about this domain* |
| Invocation Context | **Output-shaped (by design)** | The goal/task — defines *what to achieve*, not *how to think* |

The Invocation Context is the one layer where output-shaped language is correct and expected. "Review session plan-001's explore findings" is a goal, not a process. If someone tried to make it process-shaped ("First read the findings, then identify gaps, then list issues"), they would duplicate the Cognitive Frame's reasoning protocol and the Domain Guidance's domain-specific steps — a cross-layer violation of Principle 5 (No Repetition Across Layers).

### The Deliver Rule Is Process-Shaped

The frame's Deliver rule ("Lead with the answer or critical insight; close with risks and watch-points; a response must add information or progress") is itself **process-shaped**, not output-shaped. It tells the model *how to structure the output* (an executable step), not *what the output should be* (a quality aspiration). "Lead with the answer" is an actionable directive. "Make the output insightful" would be output-shaped. This distinction is important: even the rules governing output structure are process-shaped.

### The Process-Shaped Wrapper Pattern

The overall system is a **process-shaped wrapper around an output-shaped goal**:

```
Output-shaped goal (Invocation Context)
    "Review session plan-001's explore findings"
        ↓
Process-shaped loop (FSM orchestration)
    explore → plan → critique → revise → complete
        ↓
Process-shaped directives (Cognitive Frame + Domain Guidance)
    criteria before work → evidence-backed completion → honest exhaustion
        ↓
Process-shaped deliver rule
    Lead with the answer → Close with risks → Add information or progress
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

## 6. Vocabulary Consistency (Wire Formats + Editorial Discipline)

**Status: [HYPOTHESIS]** — related to the robust finding that models are surprisingly sensitive to surface variation (FormatSpread: up to 76-point swings from semantically equivalent formatting), but the specific claim that synonym drift across layers degrades performance is untested.

### The Concept

One term per concept, across every layer — enforced through two different mechanisms:

- **Wire formats** (machine-parsed): CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN, `needs_clarification`, `clarifying_questions`, the SUMMARY structure. These are contracts the orchestration engine parses; they live in the agents' Working Discipline sections and are treated as an API — never renamed in a prompt edit.
- **Editorial vocabulary** (review-enforced): constraints = hard limits, assumptions = believed-true-unverified, tradeoffs = tensions, verification = proof of success. Authors keep these consistent; the Carren+Vera review pipeline flags drift.

### Why the frame no longer carries the table

An earlier frame carried a six-term inline vocabulary table, accepted as an intentional budget deviation. It was trimmed in the Bitter-Lesson frame passes: an always-on table is a standing token cost whose adherence value was never demonstrated by ablation, and a capable model does not need definitions of ordinary words — it needs the terms *used consistently*, which is an authoring discipline, not frame content. The principle (consistency) outlived the mechanism (the inline table) — exactly the "ratchet on capabilities, never implementations" pattern.

## 7. Declarative Rules, Not Narrative

**Status: [HYPOTHESIS]** — same family as §1. The sentence "the model follows instructions more reliably than aspirations" is a house claim, not a cited result; it is queued for section ablation.

### The Concept

Rules in the Cognitive Frame are declarative (imperative verbs), not narrative (aspirational prose).

❌ "The agent should try to understand constraints before making a plan."
✅ "LIST the constraints (hard limits that cannot be violated)."

### Why

Declarative rules are instructions. Narrative is aspiration. The model follows instructions more reliably than aspirations. This is related to process-shaped vs. output-shaped: declarative rules define executable steps; narrative describes desired outcomes.

## 8. Reach for Skills and Agents First ("Route to the Right Abstraction")

### The Concept

Penny follows a decision tree for task routing:

1. Does a **skill** exist for this task? → Use it (skills orchestrate multi-step workflows)
2. Is this a **single-domain task**? → Use a subagent (isolated context, domain expertise)
3. Otherwise → Handle directly (trivially simple tasks)

In the current frame this lives in the **Reach for Skills and Agents First** section, with one Bitter-Lesson refinement: the choice is made by *reasoning over capability descriptions*, never by keyword-matching — routing is the model's judgment over declared capabilities, not a lookup table.

### Why

This prevents Penny from "doing the work herself" when a skill exists. Early in development, Penny would read 15+ files to "understand context" before invoking the plan skill. This violated the architecture — agents read files in isolated contexts; Penny is a router. The fix on April 15, 2026 was to replace the ambiguous "delegate immediately" with the concrete "invoke the skill or agent tool immediately."

The word "invoke" maps directly to the `skill()` and `subagent()` tools. "Delegate" is an abstract concept that LLMs can interpret broadly.

## 9. Self-Verification Is Unconditional

**Status: [EVIDENCE] for the framing.** Intrinsic self-correction is debunked — asking a model to review its own answer *reduces* accuracy (GPT-4 lost 4 points on GSM8K after self-review; Huang et al., ICLR 2024), and no published work demonstrates successful intrinsic self-correction (Kamoi et al., TACL 2024). That is exactly why the frame relies on external anchors (evidence-backed completion, honest exhaustion, the one-line Deliver check) rather than self-critique, and why correctness review routes to a *different model* (Carren critique, Vera verification).

### The Concept

Evidence-gated completion cannot be skipped by any priority override. The frame's **What Done Requires** contract — a "done" claim carries evidence; exhaustion is reported honestly; the response must add information or progress — binds even under "just do it" (Priority 3 skips *clarification*, never *self-verification*).

### Why

This is the safety net, and it is deliberately **not** self-critique. Intrinsic self-correction is debunked (the citations above), so the frame does not ask the model to re-grade its own reasoning. Instead it demands *external anchors*: captured evidence for completion claims (test output, tool output, a citation), honest `met=false` reporting on budget exhaustion, and a lightweight presence check at delivery. Correctness review routes to a *different model* (Carren critique, Vera verification — vera's evidence-tier hierarchy: execute > apply-the-rule > judge). Verification quality, not model quality, is the ceiling of the system — which is why the investment goes into evidence contracts rather than into asking the model to try harder.

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

## 11. Goals, Constraints, Capabilities — Never Procedure (The Bitter-Lesson Rule)

**Status: [EVIDENCE] for the direction, [HYPOTHESIS] for each specific trim.** The 2024–2026 record is consistent: prompt scaffolding that compensates for a current model's weaknesses (step scripts, format nagging, reasoning recipes) is wiped out or turned harmful by the next model release, while goals, constraints, consequence boundaries, and verification contracts survive. Each specific trim still proves itself through section ablation — the direction is evidenced, the individual deletions are measured.

### The Concept

Every line of prompt text is classified before it ships:

| Class | Examples | Treatment |
|-------|----------|-----------|
| **Consequence boundary** | Security directives, READ-ONLY, no-output-to-project-tree, HITL conditions | Permanent — kept or strengthened, never trimmed |
| **Conduit** | Evidence-backed completion, honest exhaustion, escalation, delegation, memory discipline | Durable — these scale *with* model improvement |
| **Wire format** | Confidence vocabulary, `needs_clarification`, SUMMARY structure | Plumbing — an API; stated once, never renamed casually |
| **Procedure / ceremony** | Step scripts, per-agent restatements of frame rules, "think step by step", workarounds for a past model's quirks | A **loan** — permitted only deliberately, tagged, and first in line for ablation at the next model upgrade |

The add-side gate (from the frame's Operating Bet): *does this line gain or lose value as models improve?* If it loses, don't hard-code it — give the model the artifact and verify the output with evidence.

### Why

Sutton's Bitter Lesson, applied to the prompt layer: methods that leverage computation (search, verification, learning, memory) beat baked-in human knowledge as compute grows — and prompt procedure *is* baked-in human knowledge about how the model should think. It helps the current model, plateaus, then actively fights the next one. The concrete house application: the always-on Before Responding Protocol became the on-demand clarification protocol (§1); the per-agent "Alignment with System Rules" restatements became the compact Working Discipline wire-format block; the inline vocabulary table became an authoring discipline (§6). In each case the *capability* was kept and the *implementation* was replaced — the ratchet protects outcomes, never mechanisms.

### The Lifecycle

Prompt scaffolding is re-measured at every model upgrade — precisely the moment it becomes newly obsolete. The section-ablation harness (`run_prompt_efficacy.py --ablate`) provides the evidence; deletion happens on measurement, not on taste. Full rationale and the component-level framework: `research/atomic-loop-components/` (the essay reading, the compliance rules, and the prompt-rewrite change map in 08-prompt-rewrites.md).

## Related Documents

- [Evidence Base](evidence.md) — Full per-technique verdicts, citations, and the rule for upgrading a [HYPOTHESIS] to [EVIDENCE]
- [Layer Architecture](layer-architecture.md) — How these principles manifest in the five layers
- [Assembly Pipeline](assembly-pipeline.md) — How principles are enforced at assembly time
- [Security Architecture](security-architecture.md) — How boundary markers protect these principles
- [Self-Improving Guidance](self-improving-guidance.md) — Behavioral learning loop for Domain Guidance
