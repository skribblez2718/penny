# Design Principles

The core concepts and rationale behind Penny's prompt architecture. These principles emerged from sessions in April 2026 as we migrated from a monolithic `APPEND_SYSTEM.md` to a layered, standards-based architecture.

**Evidence status.** Each principle below carries a tag from the [Evidence Base](evidence.md): **[EVIDENCE]** (replicated published support), **[HYPOTHESIS]** (house position — plausible and internally consistent), or **[DEBUNKED-ADJACENT]** (the nearby popular claim failed replication; ours survives only in a narrower form).

## 1. Process-Shaped, Not Output-Shaped

**Status: [HYPOTHESIS]** — consistent with the robust finding that specific, complete instructions beat vague aspirations, but "process-shaped beats output-shaped" as a general rule has no direct published test. The Before Responding protocol specifically is **[DEBUNKED-ADJACENT]**: prescriptive step scaffolds are the technique class that goes neutral-to-negative on reasoning-native models (Sprague et al. 2024; vendor guidance against CoT-prompting thinking models) — which is why the six-step sequence was moved out of the always-on frame into the on-demand clarification protocol (see below).

### The Concept

Every rule is a **specific, executable directive**, not a desired output quality — while stopping short of mandated multi-step reasoning scripts (see Principle 11; the two principles together say: constrain outcomes, not methods).

| Output-Shaped (AVOID)   | Process-Shaped (PREFER)                           |
| ----------------------- | ------------------------------------------------- |
| "Be accurate"           | "Never invent facts, sources, or results"         |
| "Be thorough"           | "Claim completion only with evidence"             |
| "Be clear"              | "State material assumptions"                      |
| "Consider alternatives" | "When two approaches conflict, name the tradeoff" |

### Why

Output-shaped prompts are aspirations. "Be thorough" tells the model _what the result should look like_ but not _how to get there_. The model fills the process gap with probability — sometimes well, sometimes poorly.

Process-shaped prompts constrain the path, not just the destination. "Verify before delivering" is an executable step. The model doesn't need to interpret — it just follows the instruction.

This principle was first codified in the Cognitive Frame standards on April 14, 2026 as "every section must define a thinking step." The current standards state it more carefully — prefer clear goals, observable constraints, and lightweight execution directives; never mandate reasoning scripts — because "process-shaped beats output-shaped" as an absolute has no direct published test, and prescriptive scaffolds measurably hurt reasoning-native models. The narrower editorial form (specific directives over vague aspirations) is the part that survives.

### From Always-On Protocol to On-Demand Protocol

The six-step RESTATE / IDENTIFY / LIST / LIST / SURFACE / FLAG sequence was originally an always-on "Before Responding Protocol" — mandatory cognitive steps before every response. It no longer lives in the frame. Prescriptive step scaffolds are exactly the prompt content that goes neutral-to-negative on reasoning-native models (the [DEBUNKED-ADJACENT] tag above), and always-on procedure is the class of scaffolding that ages worst as models improve (Principle 11). The sequence survives as the **on-demand clarification protocol** (`docs/penny/clarification-protocol.md`): the frame states only the _activation trigger_ (blocking ambiguity: a missing fact that could materially change the result, a materially consequential action, or missing authorization), and the full protocol loads only when that trigger fires. The frame keeps single executable directives ("surface constraints and success criteria before work"); the multi-step script became a tool reached for on demand.

### Scope: Which Layers This Principle Applies To

This principle applies to all **cognitive layers** — layers that define _how to think_:

| Layer              | Shape                         | Rationale                                                                           |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| Cognitive Frame    | Executable policy directives  | Universal operating policy — outcome and boundary constraints, no reasoning scripts |
| Role Definition    | Process-shaped                | Role constraints — defines _how this role operates_                                 |
| Domain Guidance    | Process-shaped                | Domain patterns — defines _how to reason about this domain_                         |
| Invocation Context | **Output-shaped (by design)** | The goal/task — defines _what to achieve_, not _how to think_                       |

The Invocation Context is the one layer where output-shaped language is correct and expected. "Review session research-001's draft findings" is a goal, not a process. If someone tried to make it process-shaped ("First read the findings, then identify gaps, then list issues"), they would duplicate the Cognitive Frame's reasoning protocol and the Domain Guidance's domain-specific steps — a cross-layer violation of Principle 5 (No Repetition Across Layers).

### The Deliver Rule Is Process-Shaped

The frame's Deliver rule ("Lead with the answer or critical insight; close with risks and watch-points; a response must add information or progress") is itself **process-shaped**, not output-shaped. It tells the model _how to structure the output_ (an executable step), not _what the output should be_ (a quality aspiration). "Lead with the answer" is an actionable directive. "Make the output insightful" would be output-shaped. This distinction is important: even the rules governing output structure are process-shaped.

### The Process-Shaped Wrapper Pattern

The overall system is a **process-shaped wrapper around an output-shaped goal**:

```
Output-shaped goal (Invocation Context)
    "Review session research-001's draft findings"
        ↓
Process-shaped loop (FSM orchestration)
    gather → synthesize → validate → revise → complete
        ↓
Process-shaped directives (Cognitive Frame + Domain Guidance)
    criteria before work → evidence-backed completion → honest exhaustion
        ↓
Process-shaped deliver rule
    Lead with the answer → Close with risks → Add information or progress
```

The goal is the only output-shaped element, and it sits in the Invocation Context layer — which is correctly identified as the "what to do now" layer. Everything that processes the goal — the iteration loop, the cognitive steps, the output structure — is process-shaped. This is not a contradiction; it's a separation of concerns: the destination is output-shaped, the path is process-shaped.

## 2. Universal Capability Roles

**Status: [EVIDENCE] for the constraints, [DEBUNKED-ADJACENT] for identity.** Functional role constraints (tools, READ-ONLY, output contracts) are engineering with clear value. But do not expect the identity sentence itself ("You are Carren…") to add accuracy: persona prompting for accuracy is debunked — 162 personas across 4 model families showed no gain, with per-persona effects "largely random" (Zheng et al. 2024; Wharton Report 4 found 9 significant _decreases_ across 6 frontier models).

That finding is unaffected by the reframe below. What follows is a claim about **what an agent is**, not a claim that telling a model its name makes it smarter.

### The Concept

An agent is a **domain-invariant capability contract** whose objective, invariants, authority, tool posture, and input→output transformation remain stable when the subject matter changes.

The earlier framing — agents as universal _mental faculties_ — was retired because it misdescribed its own membership. Echo, Annie and Synthia resemble epistemic functions, but Skribble is a _production authority_ with write access and Tabitha is _operationalization_. Neither is a psychological faculty, and judging the roster by that standard invites two opposite mistakes: deleting good abstractions (Skribble and Tabitha look like category errors) and inventing useless ones ("complete the taxonomy" with `learn`, `remember`, `attend`, `route`).

The capability-contract definition explains all ten current roles cleanly and rejects the domain-agent proliferation the architecture was built to escape.

#### The transformation table

Every Role Definition must be expressible as a domain-free `input → output` transformation. This is the primary routing basis and a required field in the registry.

| Capability | Agent    | Transformation                                             |
| ---------- | -------- | ---------------------------------------------------------- |
| Explore    | echo     | unknown area → relevant evidence/context                   |
| Analyze    | annie    | evidence/material → structured understanding               |
| Synthesize | synthia  | multiple evidence sets → integrated understanding          |
| Critique   | carren   | work product + quality criteria → improvement judgment     |
| Verify     | vera     | target + standard → evidence-backed validity verdict       |
| Ideate     | ida      | problem + constraints → diverse candidate possibilities    |
| Decide     | demetri  | alternatives + objectives → justified choice + sensitivity |
| Plan       | piper    | goal + state + constraints → strategy                      |
| Taskify    | tabitha  | strategy/specification → executable task graph             |
| Generate   | skribble | specification → materialized artifact                      |

#### Three families

The roster is not one flat set. Recognising three families removes the pressure to force every role into a single ontology:

- **Epistemic** — turn information into knowledge or judgment: explore, analyze, synthesize, critique, verify.
- **Deliberative** — determine what should happen: ideate, decide, plan.
- **Operational** — convert intent into externalizable work: taskify, generate.

Family membership is descriptive, **not** a workflow constraint. `analyze → decide`, `generate → verify` and `explore → synthesize` are all valid without passing through an intermediate family.

Roles know nothing about code, travel, or research. Domain-specific knowledge comes from the skill prompt (`assets/prompts/*.md`) injected via `<skill_context>`.

```
Agent Definition (.pi/agents/carren.md)
    ↓
    "I am Carren. I review work products for quality.
     I am READ-ONLY, EVIDENCE-BASED, CONSTRUCTIVE."

Domain Guidance (.pi/skills/research/assets/prompts/carren-critiquing_report.md)
    ↓
    "In this skill context, review the research report for completeness,
     calibration, balance, bias, and uncertainty honesty."

Task Message
    ↓
    "Review session research-001's draft report.
     Goal: Compare storage approaches."
```

### Why

This was a deliberate decision made on April 10, 2026. The alternative was domain-specific agents (`echo-code`, `echo-travel`, `echo-research`), which would have:

- Exploded the agent directory (N capabilities × M domains)
- Created maintenance burden (every domain needed its own agent)
- Broken context preservation (agents would be treated as data containers, not reasoning offloads)

By keeping agents generic and injecting domain guidance at invocation time, the same capability pool serves all skills and all domains. New domains require a new skill prompt, not a new agent.

The research skill is the proof: it is a composition of Piper, Echo, Synthia, Carren, Vera and Skribble rather than a `research-agent`. Domain and function are orthogonal — security analysis and financial analysis are different domains but the same transformation.

### When to Create a New Agent

A proposal must pass all six gates, recorded in [Capability Registry](../agents/capability-registry.md):

1. **Stable transformation** — expressible as `input → output` with no subject-matter noun.
2. **Cross-domain validity** — three genuinely unrelated domains where the same invariants hold.
3. **Independent evaluability** — its correctness is judgeable without evaluating a whole workflow.
4. **Distinct reasoning or authority contract** — merging it into an existing agent would blur objectives, create conflicting incentives, change tools, or mix side-effect permissions.
5. **No workflow identity** — if it is really `explore → analyze → synthesize`, it is a skill.
6. **No domain identity** — security, finance, travel, software and research belong in Domain Guidance.

The governing question: **would replacing the subject-matter nouns in this Role Definition change anything important?** If yes, Domain Guidance is leaking into the Role Definition.

A "plan reviewer for travel" reuses Carren with travel-specific Domain Guidance. A `secure-code-reviewer` is `critique` or `verify` plus Domain Guidance — the registry's semantic coordinates make that visible immediately.

## 3. CREST Domain Methodology

### The Concept

Every skill prompt (Domain Guidance) uses the CREST framework to structure domain-specific thinking:

| Dimension       | Question                                  | Example (Coding)              |
| --------------- | ----------------------------------------- | ----------------------------- |
| **C**onstraints | What are the universal hard limits?       | Must not break existing tests |
| **R**esources   | What does this domain consume or require? | Dependencies, build tools     |
| **E**valuation  | How do you know good from bad?            | Tests pass, reviews clean     |
| **S**equence    | Does order matter? What depends on what?  | Dep analysis → impl → testing |
| **T**radeoffs   | What are the fundamental tensions?        | Speed vs. readability         |

### Why

CREST provides a consistent mental model across domains. In the current research workflow, an evidence-gathering assignment can use CREST to surface source constraints and tradeoffs, while a critique assignment uses the domain's evaluation criteria to test coverage and grounding. The framework stays consistent while the assignment-specific content changes.

This was formalized in the role-and-domain-standards.md on April 14, 2026: "Each new domain gets a CREST analysis that becomes a section in the relevant skill prompt."

## 4. Context Window Preservation

### The concept

Agents still provide domain focus and separate context, but exact workflow data
moves through an immutable artifact plane:

1. The execution owner grants only the exact predecessor refs needed now.
2. The worker reads them with `artifact_read`, following typed continuation until complete.
3. The worker returns complete stage content plus a small routing SUMMARY.
4. The owner persists and verifies exact bytes before SUMMARY routing.
5. The checkpointer retains compact state and selected refs, never payload bytes.

### Why

This keeps Penny from becoming a pass-through relay without making semantic
memory search part of workflow correctness. Exact refs survive malformed-SUMMARY
retry, clarification, process restart, parallel partial recovery, and compaction.
The model cannot list, search, guess, or self-grant artifacts.

Workers and skill drivers have no durable-memory tools. The unmarked primary
runtime retains bounded, value-triggered recall and curated cross-session memory
as a separate capability.

### Consequence

Complete stage output and routing data are distinct. A model-authored SUMMARY or
locator cannot prove persistence. Local agent definitions stay domain-agnostic,
and remote harness/service presence remains in its own registry.

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

An earlier frame carried a six-term inline vocabulary table, accepted as an intentional budget deviation. It was trimmed in the Bitter-Lesson frame passes: an always-on table is a standing token cost whose adherence value was never demonstrated, and a capable model does not need definitions of ordinary words — it needs the terms _used consistently_, which is an authoring discipline, not frame content. The principle (consistency) outlived the mechanism (the inline table) — exactly the "ratchet on capabilities, never implementations" pattern.

## 7. Declarative Rules, Not Narrative

**Status: [HYPOTHESIS]** — same family as §1. The sentence "the model follows instructions more reliably than aspirations" is a house claim, not a cited result.

### The Concept

Rules in the Cognitive Frame are declarative (imperative verbs), not narrative (aspirational prose).

❌ "The agent should try to understand constraints before making a plan."
✅ "LIST the constraints (hard limits that cannot be violated)."

### Why

Declarative rules are instructions. Narrative is aspiration. The model follows instructions more reliably than aspirations. This is related to process-shaped vs. output-shaped: declarative rules define executable steps; narrative describes desired outcomes.

## 8. Lowest-Complexity-Sufficient Routing ("Route to the Right Abstraction")

### The Concept

Penny chooses the lowest-complexity execution path expected to succeed:

1. **Direct** — current context and tools are sufficient; a handoff would add more overhead than value.
2. **Subagent** — specialization, isolated context, parallel exploration, or a separate review materially improves the result.
3. **Skill** — an established workflow's durable state, approval gates, retries, or resumability materially improves reliability.

The choice is made by _reasoning over capability descriptions_, never by keyword-matching — routing is the model's judgment over declared capabilities, not a lookup table.

### Why

Delegation has real costs: the handoff must be formulated, context can be lost in transfer, results must be integrated, latency and tokens accumulate, and a child model can make a correlated version of the same mistake. Skills and agents earn those costs when their isolation, specialization, state, or gates add material value — not merely because a task has multiple steps.

An earlier frame mandated "reach for skills and agents first," self-handling only trivial one-call work. That mandate was retired: it fought the Bitter-Lesson ratchet (as models improve, more work becomes cheap to do directly, and a delegation mandate blocks that gain) and it contradicted the more selective guidance in the routing tools themselves. The lesson that _was_ kept: when Penny does delegate to a skill, she invokes it rather than re-doing the same discovery in her own context first — the historical failure mode was reading many files "to understand context" before delegation, duplicating work the workflow's agents then repeated in isolated contexts.

## 9. Self-Verification Is Unconditional

**Status: [EVIDENCE] for the framing.** Intrinsic self-correction is debunked — asking a model to review its own answer _reduces_ accuracy (GPT-4 lost 4 points on GSM8K after self-review; Huang et al., ICLR 2024), and no published work demonstrates successful intrinsic self-correction (Kamoi et al., TACL 2024). That is exactly why the frame relies on external anchors (evidence-backed completion, honest exhaustion, the one-line Deliver check) rather than self-critique, and why correctness review routes to a _different model_ (Carren critique, Vera verification).

### The Concept

Evidence-gated completion cannot be skipped by any instruction. The frame's **Completion** contract — a "done" claim carries evidence appropriate to the task; exhaustion is reported honestly; what was not verified is stated — binds even under "just proceed" (which authorizes reasonable assumptions, never unverified completion claims).

### Why

This is the safety net, and it is deliberately **not** self-critique. Intrinsic self-correction is debunked (the citations above), so the frame does not ask the model to re-grade its own reasoning. Instead it demands _external anchors_: captured evidence for completion claims (test output, tool output, a citation), honest `met=false` reporting on budget exhaustion, and a lightweight presence check at delivery. Correctness review routes to a _different model_ (Carren critique, Vera verification — vera's evidence-tier hierarchy: execute > apply-the-rule > judge). That cross-model review is **model-diverse review** — valuable supplementary scrutiny, not independent evidence by itself; the independent anchors remain tests, tools, and sources. Verification quality, not model quality, is the ceiling of the system — which is why the investment goes into evidence contracts rather than into asking the model to try harder.

## 10. Concrete Verbs, Not Abstract Nominalizations

**Status: [HYPOTHESIS]** — no direct literature exists for nominalization effects on instruction-following. Cheap to keep as editorial hygiene. The routing rationale below (signal-verb matching for auto-invocation) is an engineering argument and stands on its own.

### The Concept

Name actions with verbs, not abstract nouns. A **nominalization** turns a process ("analyze", "decide", "verify") into a thing ("analysis", "decision", "verification"). When an instruction hides its action inside a noun, it stops being a step the model can execute and becomes a topic the model must interpret.

| Nominalized (AVOID)                          | Concrete verb (PREFER) |
| -------------------------------------------- | ---------------------- |
| "Perform an analysis of the input"           | "Analyze the input"    |
| "Responsible for the identification of gaps" | "Identify gaps"        |
| "Conduct a review of the plan"               | "Review the plan"      |
| "For the purpose of verification"            | "To verify"            |
| "Upon completion of the exploration"         | "After you explore"    |

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

**Status: [EVIDENCE] for the direction, [HYPOTHESIS] for each specific trim.** The 2024–2026 record is consistent: prompt scaffolding that compensates for a current model's weaknesses (step scripts, format nagging, reasoning recipes) is wiped out or turned harmful by the next model release, while goals, constraints, consequence boundaries, and verification contracts survive.

### The Concept

Every line of prompt text is classified before it ships:

| Class                    | Examples                                                                                                         | Treatment                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Consequence boundary** | Security directives, READ-ONLY, no-output-to-project-tree, HITL conditions                                       | Permanent — kept or strengthened, never trimmed        |
| **Conduit**              | Evidence-backed completion, honest exhaustion, escalation, delegation, memory discipline                         | Durable — these scale _with_ model improvement         |
| **Wire format**          | Confidence vocabulary, `needs_clarification`, SUMMARY structure                                                  | Plumbing — an API; stated once, never renamed casually |
| **Procedure / ceremony** | Step scripts, per-agent restatements of frame rules, "think step by step", workarounds for a past model's quirks | A **loan** — permitted only deliberately and tagged    |

The add-side gate (from the frame's Operating Bet): _does this line gain or lose value as models improve?_ If it loses, don't hard-code it — give the model the artifact and verify the output with evidence.

### Why

Sutton's Bitter Lesson, applied to the prompt layer: methods that leverage computation (search, verification, learning, memory) beat baked-in human knowledge as compute grows — and prompt procedure _is_ baked-in human knowledge about how the model should think. It helps the current model, plateaus, then actively fights the next one. The concrete house application: the always-on Before Responding Protocol became the on-demand clarification protocol (§1); the per-agent "Alignment with System Rules" restatements became the compact Working Discipline wire-format block; the inline vocabulary table became an authoring discipline (§6). In each case the _capability_ was kept and the _implementation_ was replaced — the ratchet protects outcomes, never mechanisms.

## Related Documents

- [Evidence Base](evidence.md) — Full per-technique verdicts, citations, and the rule for upgrading a [HYPOTHESIS] to [EVIDENCE]
- [Layer Architecture](layer-architecture.md) — How these principles manifest in the five layers
- [Assembly Pipeline](assembly-pipeline.md) — How principles are enforced at assembly time
- [Security Architecture](security-architecture.md) — How boundary markers protect these principles
