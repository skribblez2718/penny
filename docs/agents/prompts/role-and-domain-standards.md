# Role Definition and Domain Guidance Standards

Standards for writing and maintaining Role Definition (agent definitions) and Domain Guidance (skill prompts).

For the complete prompt architecture — all five layers, their interactions, and token budgets — see [Layer Reference](layer-reference.md). For how these layers are assembled and injected, see [Architecture](architecture.md).

## The Two Layers Are Separate

Role Definition and Domain Guidance are **separate named layers** with different functions, injected by different mechanisms, and authored by different roles:

| Layer               | Function                     | Answers                                      | Source Files                       | Injection Mechanism                                        | Author         |
| ------------------- | ---------------------------- | -------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | -------------- |
| **Role Definition** | Agent identity + constraints | "Who am I? What can I do?"                   | `.pi/agents/*.md`                  | `--append-system-prompt` (agent body)                      | Agent designer |
| **Domain Guidance** | Domain patterns + checklists | "How do I think about this kind of problem?" | `.pi/skills/*/assets/prompts/*.md` | `<skill_context>` tag (injected before `<agent_boundary>`) | Skill designer |

For how these layers relate to agents, see [Agent Definition Format](../agents/definition-format.md). For how skill prompts integrate with skill architecture, see [Skill Standard](../skills/skill-standard.md) and [Orchestration](../skills/orchestration.md).

**They are separate because:**

- An agent can exist without domain guidance (Penny in direct conversation has a role but no domain guidance)
- Domain guidance can swap independently of the role (same Echo agent gets different CREST tables per skill)
- They have different authors (agent designer vs skill designer) and different compliance rules
- They are injected by different mechanisms (`--append-system-prompt` vs `<skill_context>`)

## Core Principle

Both layers build on the Cognitive Frame. They never repeat, contradict, or replace Cognitive Frame rules. They add specificity that the Cognitive Frame doesn't cover.

**Role Definition** adds role-specific constraints (who this agent is, what it can do, how the Cognitive Frame applies to its role).
**Domain Guidance** adds domain-specific patterns (what this kind of problem looks like, what to check, what good output looks like in this domain).

## Agent Definition Standards (.pi/agents/\*.md)

### Required Sections

Every agent definition MUST include these sections in this order:

1. **YAML Frontmatter** — `name`, `description`, `tools`, `model` (the `tools:` field is the single source of truth for tool declarations — Pi parses it and passes it to `--tools`; no separate tools table is needed)
2. **Purpose** — One-sentence role definition (what this agent IS and DOES)
3. **Mempalace-First Protocol** OR equivalent read/write cycle
4. **Alignment with System Rules** — Bridges Cognitive Frame rules to this agent's role
5. **Role-Specific Rules** — ONLY rules that Cognitive Frame doesn't cover
6. **Output Format** — What this agent produces and how
7. **`<agent_boundary>`** — Security marker (required)

### Alignment with System Rules Pattern

Every agent MUST include an Alignment section that connects Cognitive Frame rules to the agent's specific role. Format:

```markdown
## Alignment with System Rules

You operate under the system's Instruction Hierarchy, Confidence Levels, Ambiguity Gate, and Delivery Checklist. Apply them within your agent role:

- **Surfacing**: [How this agent surfaces context and unknowns in its role]
- **Assumptions**: [How this agent handles assumptions in its role]
- **Confidence**: [When this agent declares confidence]
- **Verification**: [What this agent verifies before delivering]
- **User Intent**: [How this agent respects user-provided context and when to ask vs. proceed]
```

This is NOT repeating Cognitive Frame — it's connecting it to the specific role.

### What NOT to Include

- **Cognitive Frame rules restated in different words** — e.g., "ask when uncertain" when SYSTEM.md already mandates "unresolved ambiguity = ask, don't assume"
- **Narrative descriptions of Cognitive Frame concepts** — e.g., "assumptions are the enemy of accuracy" (aspiration, not rule)
- **Actions disguised as abstract nouns** — e.g., "responsible for the identification of gaps"; write "Identify gaps" instead. Use concrete verbs; a nominalization hides the action (see [Design Principles §10](../../humans/prompts/design-principles.md))
- **Contradictory instructions** — e.g., "do NOT ask for more information" (conflicts with Priority 2: Clarity)

### What IS Role-Specific

Rules that Cognitive Frame doesn't cover are appropriate for Role Definition:

- **Operational constraints**: "READ-ONLY" for Echo, "NO REWRITING" for Carren
- **Domain scope**: "DOMAIN-AGNOSTIC: Works for code, life, research, etc."
- **Process requirements**: "ATOMIC: Each task must be independently completable"
- **Output format requirements**: "VALID JSON: Output must be parseable JSON"

### Base Memory Tool Set (Mandatory for All Agents)

Every agent definition MUST include all four memory tools in its `tools` field:

```yaml
tools: ..., memory_smart_search, memory_add_drawer, memory_check_duplicate, memory_kg_add
```

| Tool                     | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `memory_smart_search`    | Read prior context and findings from mempalace   |
| `memory_add_drawer`      | Store session results and learnings in mempalace |
| `memory_check_duplicate` | Prevent redundant mempalace writes               |
| `memory_kg_add`          | Link entities in the shared knowledge graph      |

**Rationale**: The memory layer is Penny's core data plane. Every agent reads upstream work and writes downstream results. Omitting any memory tool breaks knowledge continuity. This is NOT a violation of least-privilege — it is the shared substrate all agents require.

## Agent Dual Purpose: Domain Expertise + Context Preservation

Agents serve two distinct but equally important purposes:

1. **Domain Expertise** — Each agent specializes in a reasoning pattern (exploration, planning, critique, generation, verification). By delegating to specialists, Penny ensures high-quality output for complex reasoning tasks.

2. **Context Window Preservation** — When Penny delegates to a subagent, the subagent's full reasoning (exploration findings, design specs, critique reports, generated content) is offloaded from Penny's context. The subagent writes its complete output to mempalace; Penny only receives a minimal structured SUMMARY. This keeps Penny's context bounded and available for orchestration, routing, and user interaction.

**Consequence**: Parent orchestrators (Penny, skill FSMs) must never ingest full subagent output into their own context unless the user's next action explicitly requires it. The standard pattern is:

- Subagent writes full output → mempalace
- Subagent returns minimal SUMMARY → orchestrator
- Orchestrator advances state using SUMMARY metadata only
- Next subagent (if any) reads full prior output directly from mempalace

This is why we do NOT create agent variants (e.g., `echo-weather`, `vera-weather`). The existing agent pool is sufficient because skill-specific expertise is injected via Domain Guidance (`assets/prompts/`) and task messages, not by duplicating agent definitions. Creating variants would bloat the agent directory without adding new reasoning patterns and would undermine the context-preservation model by encouraging agents to be treated as data containers rather than reasoning offloads.

## Context-Adaptive Agents: The Same Agent, Different Domains

An agent's identity (who it IS) does not change across contexts. But what the agent DOES in a given context is determined by the **Domain Guidance** layer, not the **Role Definition** layer. This means the same agent can perform different roles in different skills without changing its agent definition file.

### How It Works

```
Role Definition (.pi/agents/carren.md)
    ↓
    Permanent agent identity: "Evaluate work products"
    Permanent constraints: READ-ONLY, EVIDENCE-BASED
    Permanent alignment: Confidence levels, surfacing rules

Domain Guidance (.pi/skills/plan/assets/prompts/carren.md)
    ↓
    Context-specific instructions: "Review this plan against CREST"
    Context-specific output format: PLAN_VERDICT JSON schema
    Context-specific mempalace room: skills/plan-<session_id>

Invocation Context (task message)
    ↓
    Immediate task: "Review session plan-001's explore findings"
    Skill-specific parameters: session_id=plan-001
```

**The Role Definition agent file is generic.** It defines what the agent IS (a reviewer, a planner, an explorer). It does not specify what the agent is reviewing, what criteria to apply, or what format to produce — those belong in Domain Guidance and Invocation Context.

**When adding a new skill that uses an existing agent:**

1. Reuse the existing agent definition (do not create `carren-v2.md`)
2. Create the skill's Domain Guidance prompt (`.pi/skills/new-skill/assets/prompts/carren.md`)
3. The skill prompt specifies: the task, the criteria, the output format, the mempalace room
4. The agent body + skill prompt are combined by the subagent extension into a single `--append-system-prompt`

### When to Create a New Agent Definition

DO create a new agent file when:

- The agent needs **different tools** than existing agents
- The agent has **different security constraints** (e.g., can modify files vs read-only)
- The agent has a **different fundamental reasoning approach** (e.g., exploratory vs evaluative)

DO NOT create a new agent file when:

- The existing agent handles the role but the **domain is different**
- The existing agent handles the role but the **output format is different**
- The existing agent handles the role but the **review criteria are different**

In the DO NOT cases, the skill's Domain Guidance prompt provides the specificity. The agent adapts because its instructions come from the context.

### Example: Carren in Three Contexts

| Context                                     | Agent Definition       | Domain Guidance                                        | Invocation Context                                                   |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Plan skill, planning phase                  | `.pi/agents/carren.md` | `.pi/skills/plan/assets/prompts/carren.md`             | Task: "Review session plan-001's explore findings"                   |
| Amendment review, one-off                   | `.pi/agents/carren.md` | **None** (no skill invoked)                            | Task message includes review criteria inline                         |
| Amendment review, batch mode (future skill) | `.pi/agents/carren.md` | `.pi/skills/amendment-review/assets/prompts/carren.md` | Task: "Review these 3 amendments against amendment quality criteria" |

### Task-Embedded Domain Guidance (Ad-Hoc Agent Use)

When an agent is invoked **without a skill context** (standalone script, direct subagent call), there is no `--append-system-prompt` Domain Guidance file. The caller provides domain-specific instructions in the **task message** (Invocation Context).

**Example — Amendment review via standalone script:**

```python
# Standalone script invokes Carren without skillContext
subagent(
    agent="carren",
    task="""
    Review the following proposed amendment to the Piper skill prompt.
    Apply these AMENDMENT QUALITY CRITERIA:
    1. Evidence linkage: does this cite specific outcome draws?
    2. Target correctness: does this belong in Domain Guidance or is it universal?
    3. Specificity: is the proposed text actionable?
    4. Safety: could this cause regressions in other domains?

    PROPOSED AMENDMENT:
    <amendment text>

    EVIDENCE:
    <outcomes and diary entries>

    Return your verdict as structured JSON: {"verdict": "...", "issues": [...]}
    """
)
```

The task message IS the Domain Guidance for this invocation. The agent's Role Definition (who Carren IS) remains unchanged. The agent's Domain Guidance (WHAT to evaluate and HOW) is entirely in the task message.

**This pattern is valid but limited:** Task messages have a token budget (~100 for task_summary). If the domain guidance is complex or reusable, it SHOULD be formalized into a skill with a Domain Guidance file, not embedded in task messages.

### Cross-Layer Safety

- **Role Definition never contradicts Cognitive Frame** — even in new contexts, the agent follows SYSTEM.md's Before Responding, Instruction Hierarchy, Confidence Levels, and Self-Verification.
- **Domain Guidance never contradicts Role Definition** — a READ-ONLY agent never gets Domain Guidance that says "edit files."
- **Domain Guidance never contradicts Cognitive Frame** — Domain Guidance adds specificity ("in this domain, good code has 80% test coverage") not generality ("always verify before acting" — that's universal).
- **Task message never overrides system rules** — the agent_boundary enforces this.

## Duplicate Agent Check

Before creating a new agent, verify no existing agent handles the same role with different parameters. Having two agents doing the same job (e.g., `taskify.md` and `taskifier.md`) violates Single Responsibility and creates maintenance burden.

### When a New Agent IS Needed

If a new skill requires an agent capability that no existing agent has → create new agent definition.

Examples:

- A "prompt optimizer" agent that rewrites prompts (different from critique — it produces revised versions, Carren does not)
- A "knowledge graph analyst" agent that queries and visualizes KG relationships (different from Echo — Echo searches broadly, KG analyst queries structurally)

### When to Reuse an Existing Agent

If a new skill needs a capability that an existing agent already has → add Domain Guidance to the skill, not a new agent.

Examples:

- A "review code changes" skill → reuse Carren with code-review Domain Guidance
- A "summarize research" skill → reuse Echo (already handles exploration) with research-summary Domain Guidance
- A "generate test cases" skill → could reuse Piper with test-generation Domain Guidance (Piper plans; test generation is planning with specific constraints)

### Layer Separation for Agent Definitions

Agent definitions are the **Role Definition layer**. They must NOT contain content that belongs in Domain Guidance. See the cross-layer rules in [Layer Reference](layer-reference.md) for the complete specification.

| Content                                                 | Belongs in Role Definition       | Belongs in Domain Guidance                                                                                          |
| ------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent identity ("You are an Explore agent")             | ✅                               | ❌                                                                                                                  |
| Role-specific constraints ("READ-ONLY", "NO REWRITING") | ✅                               | ❌                                                                                                                  |
| Alignment with System Rules (bridging)                  | ✅                               | ❌                                                                                                                  |
| Tool access and operational rules                       | ✅                               | ❌                                                                                                                  |
| Generic output format shape                             | ✅ ("Produce a structured plan") | ✅ (specific field names)                                                                                           |
| Mempalace room/session instructions                     | ❌                               | ✅ (which room, what headers)                                                                                       |
| CREST domain tables                                     | ❌                               | ✅                                                                                                                  |
| Skill-specific output format fields                     | ❌                               | ✅                                                                                                                  |
| Skill-specific evaluation criteria                      | ❌                               | ✅                                                                                                                  |
| "You are the X agent in the Y Skill"                    | ❌                               | ❌ (identity is Role Definition; context is Domain Guidance — rephrase as "Your mission in this skill context is…") |

**When content appears in both layers, the Domain Guidance version is canonical.** The Role Definition should provide only the generic shape ("produce a structured plan with steps") and let Domain Guidance specify the exact format for each skill.

## Skill Prompt Standards (.pi/skills/_/assets/prompts/_.md)

### Required Sections

Every skill prompt MUST include:

1. **Mission** — What this agent is doing in this skill context (domain framing, NOT identity — identity lives in Role Definition)
2. **Session Context** — How to read/write mempalace for this skill (which room, what headers, what to search)
3. **Domain-specific guidance** — CREST-derived or task-specific checklists
4. **Output Format** — Skill-specific output format (field names, required sections, SUMMARY structure)
5. **Mandatory Structured Output** — The SUMMARY block that the orchestrator reads

### Process-Shaped vs Output-Shaped in Domain Guidance

Domain Guidance files are a **hybrid** — and that's by design:

- **Cognitive instructions** (CREST tables, checklists, review dimensions, analysis workflows) must be **process-shaped** — executable steps, not quality aspirations. Example: "Trace backward to see if input comes from an attacker-controllable source" (action), not "Be thorough in your analysis" (aspiration).
- **Output Format specification** (field names, SUMMARY JSON schema, output structure) is **output-shaped by design** — it defines *what to produce* (a structural contract), not *what quality to aim for*. Example: "Output Format: Goal Restatement, High-Signal Findings, Key Information" — this is a format contract, not a quality aspiration.

The compliance checklist item "Process-shaped cognitive instructions" checks for quality aspirations in cognitive content. It does NOT flag the Output Format section, which is correctly output-shaped. See [Architecture: Process-Shaped vs Output-Shaped Scope](architecture.md#process-shaped-vs-output-shaped-scope-clarification) for the full distinction.

Skill prompts MUST NOT include:

- **Agent identity** ("You are the Explore agent") — that's Role Definition
- **Cognitive Frame rules restated** — the agent body already bridges them
- **Reserved security tags** (`<system_directives>`, `<system_context>`, `<system_boundary>`, `<agent_boundary>`) — these are reserved for the security architecture
- **Template variables** (`{{goal}}`, `{{session_id}}`) — dynamic data flows through task messages and mempalace
- **Actions disguised as abstract nouns** — prefer concrete verbs ("analyze", "review") over nominalized actions ("perform analysis", "conduct a review"); see [Design Principles §10](../../humans/prompts/design-principles.md)

For how skill prompts are injected, see [Orchestration: Skill Context Injection](../skills/orchestration.md#skill-context-injection). For the security constraints on skill prompts, see [System Prompt Security: Skill Context Injection](../agents/system-prompt-security.md#skill-context-injection).

### Conflict-Compliant Language

When instructing agents to work with available context rather than asking the user:

❌ **Don't use:** "Do NOT ask for more information — work with what you have."
✅ **Use instead:** "Work with the context available in mempalace. If critical ambiguity remains that cannot be resolved from available context, set `needs_clarification: true` in your SUMMARY with `clarifying_questions` listing what you need. The parent process will present these questions to the user and resume you with answers. Do NOT call the `questionnaire` tool directly from a subagent subprocess. Do not guess when you can ask."

This respects the Instruction Hierarchy: Priority 2 (Clarity) still allows asking when there's _critical_ ambiguity, while Priority 3 (User Intent) means the user's provided context should be used first.

### Domain Checklists

Domain checklists (for coding, planning, research, etc.) belong in skill prompts (Domain Guidance), NOT in agent definitions (Role Definition) or SYSTEM.md (Cognitive Frame). This enables:

- Same explore agent works across all domains
- Domain context swaps per skill invocation
- New domains require a new skill prompt, not a new agent

### Mempalace Protocol Consistency

All skill prompts should use the same mempalace protocol pattern:

1. **Read**: Search mempalace for relevant prior context
2. **Work**: Perform the agent's task
3. **Write**: Store results in mempalace
4. **Summarize**: Output brief structured summary for the orchestrator

## CREST Methodology for New Domains

When adding domain-specific guidance to a skill prompt, use the CREST framework:

| Letter              | Question                                      | Example (Coding)                                             |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| **C** — Constraints | What are the universal hard limits?           | Must not break existing tests, must follow existing patterns |
| **R** — Resources   | What does this domain consume or require?     | Dependencies, build tools, test frameworks                   |
| **E** — Evaluation  | How do you know a good answer from a bad one? | Tests pass, code reviews clean, deployment succeeds          |
| **S** — Sequence    | Does order matter? What depends on what?      | Dependency analysis → implementation → testing               |
| **T** — Tradeoffs   | What are the fundamental tensions?            | Speed vs. readability, coverage vs. simplicity               |

Each new domain gets a CREST analysis that becomes a section in the relevant skill prompt.

## Token Budget Checks

Before modifying any prompt file:

1. **Count tokens with tiktoken** (`cl100k_base`) — the one canonical counter. Never use a `wc -w` word ratio (tables tokenize differently). For the frame, run `python scripts/system/checks/check_token_budget.py`.
2. **Verify Cognitive Frame ≤1,500 tokens** (the `<system_context>` block; CI-enforced)
3. **Verify Role Definition ≤1200 tokens** per agent definition (`.pi/agents/*.md`)
4. **Verify Domain Guidance ≤1000 tokens** per skill prompt (`.pi/skills/*/assets/prompts/*.md`)
5. **Total system prompt ≤3000 tokens** for a typical skill invocation (Cognitive Frame + Role Definition + Domain Guidance + Project Index + Invocation Context)

When in doubt, cut content rather than add it. Move elaboration to reference documents linked via AGENTS.md indexes.

A combined skill invocation (Role Definition + Domain Guidance) should be ≤2,200 tokens. If the Role Definition has a detailed output format AND the Domain Guidance has its own, prefer the Domain Guidance version — it's the canonical per-skill format. The Role Definition should state only the generic shape.

## Enforcement: Carren Critique + Vera Verification

Changes to Role Definition (`.pi/agents/*.md`) and Domain Guidance (`.pi/skills/*/assets/prompts/*.md`) are enforced by **review, not by a linter** — see [Architecture §Enforcement](architecture.md#enforcement-carren-critique--vera-verification) for the full pipeline specification.

The pipeline:

1. **Carren critiques** (model MUST differ from the one that authored the prompt) — reviews the changed file against the compliance checklists in [Architecture](architecture.md), flagging violations of declarative rules, process-shaped phrasing, and abstract nominalizations with specific line references and suggested fixes.
2. **Corrections are applied** based on Carren's findings.
3. **Vera verifies** — judges each corrected item as PASS or FAIL. A correction PASSES only if it resolves the cited violation without introducing a new one. Any FAIL → return to corrections.

This applies to all changes that add, modify, or reorder rules. Typos, canonical vocabulary additions, and clarifications that don't change semantics do not require the full pipeline.
