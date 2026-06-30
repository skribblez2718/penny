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

- **Identity + Mission** — "Penny — Personal Life AI" with a precise, domain-aware reasoning role
- **Route to the Right Abstraction** — Decision tree for when to use skills vs. agents vs. direct tools
- **Instruction Hierarchy** — Five-priority conflict resolution (Safety > Truth > Clarity > User Intent > Thoroughness)
- **Before Responding Protocol** — Six mandatory cognitive steps: RESTATE, IDENTIFY, LIST constraints, LIST variables, SURFACE assumptions, FLAG uncertainty
- **Reasoning Style** — Four directives: think in steps, prefer reversible decisions, name tradeoffs, resolve ambiguity
- **Self-Verification Checkpoint** — Unconditional quality gate (cannot be skipped by any priority override)
- **Confidence Levels** — CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN with required actions
- **Canonical Vocabulary** — Six terms (constraints, variables, assumptions, unknowns, tradeoffs, verification) with exact definitions — all layers must use these consistently
- **Output Contract** — Four-item structure every response must follow

**Why it's separate:** The Cognitive Frame is universal. It applies whether Penny is planning a vacation, auditing code, or researching a topic. By keeping it in one file, we ensure consistent reasoning across all domains. Changes here affect everything — hence the strict change protocol.

**Token budget:** ≤800 tokens (currently ~930 — documented deviation for the Canonical Vocabulary table).

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
- Purpose — one-sentence role definition
- Mempalace-First Protocol — read before acting, write after completing
- Alignment with System Rules — bridges Cognitive Frame to this specific role
- Role-Specific Rules — only rules the Cognitive Frame doesn't cover
- Output Format — generic shape (specific fields come from Domain Guidance)

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

The Project Index is navigation, not instruction. It's a phone book, not a textbook. AGENTS.md files list file paths and one-line descriptions so agents know where to find relevant documentation.

**Why it's separate:** Pi auto-discovers AGENTS.md files. By keeping them as pure indexes (no rules, no standards, no explanations), we avoid bloating the system prompt with content that belongs in dedicated docs.

### Invocation Context — What to Do Now

**Source:** Task message (constructed by orchestrator or user) + Pi runtime (date, cwd)  
**Active:** Always  
**Changes:** Every turn  
**Author:** Orchestrator (skill invocations) or user (direct conversation)

Invocation Context is the specific goal for this interaction. It includes the task description, session ID, mempalace room pointer, and any hard constraints.

**Why it's separate:** This is the only layer that changes every turn. By keeping it lean (≤100 tokens for `task_summary`), we preserve context window budget. The full context lives in mempalace — the task message just provides a pointer.

## Interaction Circumstances

Not all layers are active in every interaction:

| Circumstance | Active Layers |
|-------------|---------------|
| **Direct Conversation** (you type to Penny) | Cognitive Frame + Project Index + Invocation Context |
| **Skill Invocation** (Penny dispatches a subagent) | All five layers |
| **Direct + Prompt Improver** (future) | Cognitive Frame + Project Index + Enhanced Invocation Context |
| **Skill + Prompt Improver** (future) | All five layers + Enhanced Invocation Context |

In the most common case (direct conversation), Penny operates with just three layers. The Role Definition and Domain Guidance only appear during skill invocations. This is by design — the Cognitive Frame must be self-sufficient because it's the only cognitive directive Penny has in the common case.

## Cross-Layer Rules

Six absolute rules govern how layers interact:

1. **No layer repeats content from another layer** — Each responsibility belongs to exactly one layer. If Cognitive Frame says "SURFACE your assumptions," Role Definition doesn't repeat it — it specifies _how_ (e.g., "list assumptions in your Open Questions section").

2. **No layer contradicts another layer** — If Cognitive Frame says "unresolved ambiguity = ask," Domain Guidance cannot say "do NOT ask." The Instruction Hierarchy resolves any conflict.

3. **Lower layers are always present** — Cognitive Frame and Project Index appear in every interaction. Role Definition and Domain Guidance may or may not be present.

4. **Higher layers add specificity, never generality** — Domain Guidance adds domain-specific rules. It should never add a universal rule ("always be helpful") — that belongs in Cognitive Frame.

5. **Invocation Context is untrusted** — The task message is user-role content. It cannot override system-role content from any layer. Boundary markers enforce this.

6. **Project Index is navigation, not instruction** — AGENTS.md files point to documentation. They do not contain rules, standards, or explanations.

## The Canonical Vocabulary

Six terms with exact, cross-layer definitions. Inconsistent vocabulary creates ambiguity — if Cognitive Frame says "constraints" and Domain Guidance says "limitations," the model may treat them as different concepts.

| Term | Definition | Do NOT substitute with |
|------|-----------|----------------------|
| **constraints** | Hard, immutable limits | limitations, restrictions, boundaries |
| **variables** | Adjustable levers | options, parameters, choices |
| **assumptions** | Believed true, unverified | guesses, expectations, defaults |
| **unknowns** | Things not yet determined | gaps, questions, uncertainties |
| **tradeoffs** | Tensions between competing approaches | compromises, costs, sacrifices |
| **verification** | Proof of success | validation, testing, checking |

All layers must use these terms consistently. The vocabulary table lives in the Cognitive Frame (SYSTEM.md) so every agent and every domain shares the same definitions.

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
