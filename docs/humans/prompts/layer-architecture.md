# Layer Architecture

## The Five Named Layers

Penny's prompt architecture uses **named layers**, not numbered layers. Earlier versions used L1, L2a, L2b, L3a, L3b — numbers that conflated scope with injection order and obscured function. Names describe **what the layer does**, making intent explicit.

| Layer | Function | One-Line Summary |
|-------|----------|-----------------|
| **Cognitive Frame** | How to think | Universal reasoning protocol — the same regardless of domain |
| **Role Definition** | Who I am | Agent identity, capabilities, and role-specific constraints |
| **Domain Guidance** | How to think about this | Domain-specific patterns, checklists, and evaluation criteria |
| **Project Index** | Where things are | File and documentation references for the current project |
| **Invocation Context** | What to do now | The specific goal, task, and environment for this turn |

Each layer has exactly one responsibility. No two layers share a responsibility. If you're unsure where something belongs, the question is: "Is this about HOW to think (universal), WHO I am (per-role), HOW to think about THIS (per-domain), WHERE things are (navigation), or WHAT to do NOW (per-turn)?"

## Layer-by-Layer Breakdown

### Cognitive Frame — How to Think

**Source:** `.pi/SYSTEM.md`  
**Active:** Always (every interaction)  
**Changes:** Rarely — requires audit due to universal blast radius  
**Author:** Architecture owner

The Cognitive Frame is the universal reasoning protocol. It defines how Penny thinks, not what she thinks about. It's present in every interaction — whether Penny is in direct conversation with you or delegating to a subagent.

**What's in it:**

- **Who You Are** — Penny as a personal AI assistant, adaptable to any domain; reversible over irreversible, name tradeoffs, truth over agreement
- **The Operating Bet** — How the system improves as models improve: leverage computation over baked-in heuristics, ratchet on capabilities not implementations, gate every new rule on whether it gains or loses value as models improve, prefer turning a knob over adding procedure
- **What Done Requires** — The outcome contract: success criteria stated before work, evidence-backed completion, honest exhaustion (never dress a partial result as a pass), strategy changes on retry, prior work first, independent checks for high-stakes work
- **Instruction Hierarchy** — Conflict resolution (Truth > Clarity > User Intent > Thoroughness)
- **Signal Your Certainty** — Keep "verified" distinct from "likely" and "need to check"
- **Ask vs. Act** — When to clarify before acting; when to escalate mid-work rather than spin or silently downgrade the goal
- **Reach for Skills and Agents First** — The delegation decision, made by reasoning over capability descriptions, not keyword-matching
- **Tools & Boundaries** — Core tools plus the always-on "no output files in the project tree" rule
- **Deliver** — Lead with the answer; a response must add information or progress
- **On-Demand Protocols** — Named triggers (clarification, compaction resume, KG linking) whose full text loads only when needed

What's deliberately *not* in it: step-by-step reasoning scripts, vocabulary tables, domain checklists, and file paths. The frame states goals, constraints, and capabilities — never procedure. Multi-step protocols (like the clarification protocol) live in on-demand docs and load only when their trigger fires, because always-on procedure text is the class of prompt content that ages worst as models improve.

**Why it's separate:** The Cognitive Frame is universal. It applies whether Penny is planning a vacation, auditing code, or researching a topic. By keeping it in one file, we ensure consistent reasoning across all domains. Changes here affect everything — hence the strict change protocol.

**Token budget:** ≤1,500 tokens, measured with tiktoken (`cl100k_base`) and CI-enforced. Non-universal content is extracted into `docs/penny/` and loaded on demand to keep this always-on layer lean (see [architecture.md](../../agents/prompts/architecture.md)).

### Role Definition — Who I Am

**Source:** `.pi/agents/*.md`  
**Active:** Only during skill invocations (subagent dispatch)  
**Changes:** Per agent — swapped when a different agent is invoked  
**Author:** Agent designer

Role Definition defines an agent's identity, capabilities, and constraints. It answers "who am I?" and "what can I do?" in a generic, domain-agnostic way.

**Current agents:**

| Agent | Role | Constraints |
|-------|------|-------------|
| Echo (explore) | Gather context, search, discover | READ-ONLY, EVIDENCE-BASED, NO RECOMMENDATIONS |
| Piper (planner) | Synthesize into execution-grade plans | CONCRETE steps, VERIFIABLE criteria |
| Carren (critique) | Review artifacts for quality | CONSTRUCTIVE, EVIDENCE-BASED, NO REWRITING |
| Tabitha (taskifier) | Convert plans to structured specs | ATOMIC tasks, ORDERED dependencies |

**What's in it:**

- YAML frontmatter with `tools:` field (single source of truth for tool access)
- Purpose — the agent's cognitive domain, including what it does NOT do
- Working Discipline — the engine-consumed wire formats (mempalace cycle, confidence vocabulary, `needs_clarification`) plus one role honesty rule
- Non-Negotiables — only durable, role-specific outcomes/constraints the Cognitive Frame doesn't cover
- Output — generic shape (specific fields come from Domain Guidance)

**Why it's separate:** Agents are reusable across domains. Echo explores whether the domain is code, travel, or research. Domain-specific checklists belong in Domain Guidance, not baked into the agent. This separation means we have 4 agent files, not 4 × N domains.

### Domain Guidance — How to Think About This Domain

**Source:** `.pi/skills/*/assets/prompts/*.md`  
**Active:** Only during skill invocations (injected via `<skill_context>`)  
**Changes:** Per skill — swapped when a different skill is invoked  
**Author:** Skill designer

Domain Guidance provides domain-specific patterns, checklists, evaluation criteria, and output formats. It's what makes a generic Echo agent into a "planning context explorer" vs. a "research evidence gatherer."

**What's in it:**

- **Mission** — What this agent is doing in this skill context (not who it is — that's Role Definition)
- **Session Context** — Mempalace room, session ID, read/write instructions
- **CREST Domain Table** — Constraints, Resources, Evaluation, Sequence, Tradeoffs for this domain
- **Output Format** — Skill-specific field names and SUMMARY structure
- **Mandatory Structured Output** — The SUMMARY block the orchestrator reads

**Why it's separate:** Domain Guidance can swap independently of the Role Definition. The same Echo agent gets different CREST tables depending on the skill that invoked it. New domains require a new skill prompt, not a new agent.

**Injection mechanism:** Domain Guidance files are injected via the `<skill_context>` XML tag, placed between the agent body and `<agent_boundary>`. This keeps them as system-role content (before the security boundary). They're pure static content — no template variables allowed (`{{goal}}`, `{{session_id}}`). Dynamic data flows through the task message (user role).

### Project Index — Where Things Are

**Source:** `AGENTS.md` files (auto-discovered by Pi from cwd upward)  
**Active:** Always  
**Changes:** Per project — updated as documentation changes  
**Author:** Documentation maintainers

The Project Index is navigation, not instruction. It's a phone book, not a textbook. AGENTS.md files list file paths and one-line descriptions so agents know where to find relevant documentation. Pi auto-loads only the root `AGENTS.md` (it's on the cwd-upward path); each AGENTS.md points to the next level down, and the **leaf** AGENTS.md (the one in the directory where the source docs live) is the single source of truth for those paths. Penny walks the chain on demand — root → sub-index → leaf → doc.

**All file paths live here, not in the Cognitive Frame.** SYSTEM.md names a companion doc by its trigger ("run the clarification protocol") and never carries the path; the always-loaded root `AGENTS.md` resolves trigger → index → file. This is the rule that keeps the Cognitive Frame from bloating: embedding "read `docs/…`" references in the always-on, subagent-multiplied frame is the primary bloat vector, so those references belong in the index chain, where they cost nothing until needed.

**Why it's separate:** Pi auto-discovers AGENTS.md files. By keeping them as pure indexes (no rules, no standards, no explanations), we avoid bloating the system prompt with content that belongs in dedicated docs.

### Invocation Context — What to Do Now

**Source:** Task message (constructed by orchestrator or user) + Pi runtime (date, cwd)  
**Active:** Always  
**Changes:** Every turn  
**Author:** Orchestrator (skill invocations) or user (direct conversation)

Invocation Context is the specific goal for this interaction. It includes the task description, session ID, mempalace room pointer, and any hard constraints.

**Why it's separate:** This is the only layer that changes every turn. By keeping it lean (≤100 tokens for `task_summary`), we preserve context window budget. The full context lives in mempalace — the task message just provides a pointer.

**Output-shaped by design:** The Invocation Context is the one layer where output-shaped language is correct and expected. The task message defines *what to achieve* ("Review session plan-001's explore findings"), not *how to think* about it. Making the Invocation Context process-shaped would duplicate the Cognitive Frame's reasoning protocol and the Domain Guidance's domain-specific steps — a cross-layer violation (Design Principle 5: No Repetition Across Layers). The goal is the destination; the cognitive layers define the path.

## Interaction Circumstances

Not all layers are active in every interaction:

| Circumstance | Active Layers |
|-------------|---------------|
| **Direct Conversation** (you type to Penny) | Cognitive Frame + Project Index + Invocation Context |
| **Skill Invocation** (Penny dispatches a subagent) | All five layers |
| **Direct + Enhance** (enhance extension, ` -i` suffix) | Cognitive Frame + Project Index + Enhanced Invocation Context |
| **Skill + Enhance** (enhance extension, ` -i` suffix) | All five layers + Enhanced Invocation Context |

In the most common case (direct conversation), Penny operates with just three layers. The Role Definition and Domain Guidance only appear during skill invocations. This is by design — the Cognitive Frame must be self-sufficient because it's the only cognitive directive Penny has in the common case.

## Cross-Layer Rules

Six absolute rules govern how layers interact:

1. **No layer repeats content from another layer** — Each responsibility belongs to exactly one layer. If the Cognitive Frame requires evidence-backed completion, Role Definition doesn't repeat it — it carries the role's specific contract (e.g., the verifier's "a PASS without captured evidence is invalid").

2. **No layer contradicts another layer** — If Cognitive Frame says "unresolved ambiguity = ask," Domain Guidance cannot say "do NOT ask." The Instruction Hierarchy resolves any conflict.

3. **Lower layers are always present** — Cognitive Frame and Project Index appear in every interaction. Role Definition and Domain Guidance may or may not be present.

4. **Higher layers add specificity, never generality** — Domain Guidance adds domain-specific rules. It should never add a universal rule ("always be helpful") — that belongs in Cognitive Frame.

5. **Invocation Context is untrusted** — The task message is user-role content. It cannot override system-role content from any layer. Boundary markers enforce this.

6. **Project Index is navigation, not instruction** — AGENTS.md files point to documentation. They do not contain rules, standards, or explanations.

## Vocabulary Consistency

Consistent terms across layers still matter — if one layer says "constraints" and another says "limitations," the model may treat them as different concepts. Two kinds of vocabulary are handled differently:

- **Wire formats** (engine-parsed): the confidence scale (CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN), `needs_clarification`, `clarifying_questions`, and the SUMMARY structure. These are contracts consumed by the orchestration engine (`contracts.py`). They live in the agent definitions' Working Discipline sections and are never renamed in a prompt edit.
- **Editorial vocabulary** (author-enforced): constraints = hard limits, assumptions = believed-true-unverified, tradeoffs = tensions between approaches, verification = proof of success. An earlier frame carried these as an inline six-term table; the table was trimmed from the always-on frame (its token cost was not demonstrably earning adherence) and the discipline now lives in the authoring standards (`docs/agents/prompts/`), enforced at review time by the Carren+Vera pipeline.

The principle survives the mechanism: use one term per concept across every layer; where the term is machine-parsed, treat it as an API.

## Why Named Layers, Not Numbers

Earlier versions used a numbering scheme:

```
L1: Cognitive Frame (SYSTEM.md)
L2a: Role Definition (agent .md body)
L2b: Domain Guidance (skill prompt files)
L3a: Project Context (AGENTS.md)
L3b: Invocation Context (task message)
```

Three problems with numbers:

1. **Numbers conflate scope and injection order.** L2a and L2b have different functions (identity vs. domain patterns) and different authors (agent designer vs. skill designer), but the numbering implies they're the same "level."
2. **Numbers obscure function.** "L2a" tells you nothing. "Role Definition" tells you exactly what the layer does.
3. **Numbers break when the pipeline changes.** If a new injection mechanism is added, "L2b" might now be L2c — meaningless churn.

Named layers describe **what the layer does**, not where it appears in assembly. The assembly order is documented in the [Assembly Pipeline](assembly-pipeline.md).

## Related Documents

- [Assembly Pipeline](assembly-pipeline.md) — How these layers are injected at runtime
- [Design Principles](design-principles.md) — The concepts behind this architecture
- [Security Architecture](security-architecture.md) — How boundaries protect layer separation
