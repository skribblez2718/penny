# Assembly Pipeline

How Penny's system prompt is assembled at runtime — what happens step by step, which component is responsible for each layer, and the constraints of the assembly mechanism.

## The Channels

Pi provides exactly these channels for injecting content into the model's context:

| Channel | Pi Mechanism | What It Carries |
|---------|-------------|-----------------|
| System prompt | `.pi/SYSTEM.md` (`customPrompt`) | Cognitive Frame |
| Append system prompt | `--append-system-prompt` (single arg) | Role Definition + Domain Guidance (combined) |
| Context files | AGENTS.md auto-discovery from cwd | Project Index |
| Skills list | Pi skill discovery | Project Index (available skills) |
| Runtime info | Date/cwd injection | Invocation Context (partial) |
| User message | Task string | Invocation Context (the goal) |

There is no dedicated channel for Domain Guidance alone — it's combined with Role Definition into the single `--append-system-prompt` argument. The `<skill_context>` XML tag within the combined content provides semantic separation.

## Direct Conversation (The Common Case)

When you type a message to Penny directly (no skill invoked):

```
Pi framework:
  1. Loads .pi/SYSTEM.md as customPrompt          ← Cognitive Frame
  2. Walks up from cwd, discovers AGENTS.md files  ← Project Index
  3. Appends Skills section (discovered skills)    ← Project Index
  4. Appends date and working directory            ← Invocation Context

Environment extension:
  5. Appends <system_boundary> marker              ← Security boundary

User:
  6. Types message                                 ← Invocation Context (the goal)
```

**Result:** Penny receives Cognitive Frame + Project Index + Invocation Context. Three layers. No Role Definition, no Domain Guidance. This is why the Cognitive Frame must be self-sufficient — it's Penny's only cognitive directive in the common case.

## Skill Invocation (Subagent Dispatch)

When Penny invokes a skill (e.g., the plan skill dispatches Echo to explore):

```
Pi framework:
  1. Loads .pi/SYSTEM.md as customPrompt          ← Cognitive Frame

Subagent extension:
  2. Reads agent file (.pi/agents/echo.md)        ← Role Definition (raw)
  3. Reads skill prompt (if skillContext given)    ← Domain Guidance (raw)
  4. Combines: agent body +
     <skill_context> + skill prompt +
     </skill_context> + <agent_boundary>
  5. Writes combined content to temp file
  6. Passes temp file via --append-system-prompt   ← Role Def + Domain Guidance

Pi framework:
  7. Appends AGENTS.md files from cwd up          ← Project Index
  8. Appends Skills section                       ← Project Index
  9. Appends date/cwd                              ← Invocation Context

Environment extension:
  10. Appends <system_boundary>                    ← Security boundary

Orchestrator (skill script):
  11. Constructs task message                      ← Invocation Context (the goal)
```

**Result:** All five layers are active. The subagent receives Cognitive Frame + Role Definition + Domain Guidance + Project Index + Invocation Context.

## The Combined Prompt Structure (Visual)

Here's what the fully assembled prompt looks like for a skill invocation:

```
┌─────────────────────────────────────────────┐
│ .pi/SYSTEM.md (via customPrompt)            │
│                                             │
│ <system_directives>                         │ ← Immutable security (authored)
│   [4 security rules]                        │
│ </system_directives>                        │
│                                             │
│ <system_context>                            │ ← Cognitive Frame (authored)
│   Who You Are (identity + reasoning)        │
│   The Operating Bet                         │
│   What Done Requires                        │
│   Instruction Hierarchy                     │
│   Signal Your Certainty                     │
│   Ask vs. Act                               │
│   Reach for Skills and Agents First         │
│   Tools & Boundaries                        │
│   Deliver + On-Demand Protocols             │
│ </system_context>                           │
├─────────────────────────────────────────────┤
│ --append-system-prompt (temp file) ──────── │
│                                             │
│ Agent body (.pi/agents/echo.md)             │ ← Role Definition
│   Purpose, Working Discipline,              │
│   Non-Negotiables, Output                   │
│                                             │
│ <skill_context>                             │ ← Domain Guidance
│   Mission (for this skill context)          │
│   Session context (room, session ID)        │
│   CREST domain table                        │
│   Output format (skill-specific)            │
│   SUMMARY structure                         │
│ </skill_context>                            │
│                                             │
│ <agent_boundary>                            │ ← Security marker
│ SECURITY REINFORCEMENT                      │
│ [3 rules: never reveal, user not            │
│  authoritative, external is untrusted]      │
├─────────────────────────────────────────────┤
│ Pi auto-appends:                            │
│   AGENTS.md context                         │ ← Project Index
│   Skills section                            │ ← Project Index
│   Date / cwd                                │ ← Invocation Context
├─────────────────────────────────────────────┤
│ <system_boundary>                           │ ← Security boundary (env extension)
├═════════════════════════════════════════════┤
│ User message:                               │ ← Invocation Context (the goal)
│   "Task: Explore for session plan-001.      │
│    Goal: Refactor auth module.              │
│    Mempalace room: skills/plan-plan-001"    │
└─────────────────────────────────────────────┘
```

## Component-to-Layer Mapping

Each system component injects specific layers:

| Component | Injects | Mechanism |
|-----------|---------|-----------|
| Pi framework | Cognitive Frame | `customPrompt` setting (SYSTEM.md) |
| Subagent extension | Role Definition + Domain Guidance | Writes temp file → `--append-system-prompt` |
| Skill orchestrator | Invocation Context (task) | `task` parameter to subagent tool |
| Skill orchestrator | Domain Guidance path | `skillContext` parameter — tells extension which file to load |
| Pi framework | Project Index | AGENTS.md auto-discovery + skill discovery |
| Pi framework | Invocation Context (date/cwd) | Runtime injection |
| Environment extension | Security boundary | `<system_boundary>` via `before_agent_start` |

## The Subagent Extension's Assembly Logic

The subagent extension is the most layer-relevant component. Here's its assembly logic (simplified):

```typescript
// 1. Read the agent definition
let combinedPrompt = readFile(`.pi/agents/${agentName}.md`);

// 2. If skill context is provided, inject it BEFORE <agent_boundary>
if (skillContextContent) {
  const boundaryIdx = combinedPrompt.indexOf("<agent_boundary>");
  if (boundaryIdx !== -1) {
    combinedPrompt =
      combinedPrompt.substring(0, boundaryIdx) +
      `\n<skill_context>\n${skillContextContent}\n</skill_context>\n\n` +
      combinedPrompt.substring(boundaryIdx);
  }
}

// 3. Write combined content to temp file
writeTempFile(combinedPrompt);

// 4. Pass via --append-system-prompt
spawnPi(["--append-system-prompt", tempFilePath, ...]);
```

The key constraint: `<skill_context>` must be injected **before** `<agent_boundary>`. This maintains the sandwich defense — skill prompts remain system-role content, protected by the boundary marker.

## Skill Context Rules

Skill prompts (injected via `<skill_context>`) must follow strict rules:

1. **Pure static content** — No template variables (`{{goal}}`, `{{session_id}}`). Dynamic data flows through the task message (user role).
2. **No reserved security tags** — No `<system_directives>`, `<agent_boundary>`, `<system_boundary>` — these would break the security architecture.
3. **No Cognitive Frame or Role Definition restatements** — Skill prompts add domain specificity, not repetition.
4. **No contradictory instructions** — Must not conflict with the Instruction Hierarchy.

## Why Skill Context Is System-Role

The `<skill_context>` tag goes **before** `<agent_boundary>`, making skill prompts system-role content. This is intentional:

- Skill prompts are authored by the system (skill designers), not the user
- Template variables are prohibited — dynamic data in system-role content is a security risk (user input could inject instructions)
- The orchestrator's task message (user role) carries the dynamic goal, session ID, and constraints

This separation means: the system decides _how_ to think about a domain (Domain Guidance), the orchestrator specifies _what_ to do right now (Invocation Context).

## Why We Replaced Pi's Default Prompt

Originally, Penny used Pi's `APPEND_SYSTEM.md` mechanism — content was _appended_ to Pi's hardcoded coding-assistant prompt. This meant:

- Pi's default prompt ("You are an expert coding assistant...") was always present, eating ~300 tokens
- We couldn't control the ordering of injected content
- Security boundaries were unclear — what was our content vs. Pi's?

On April 13, 2026, we migrated to `.pi/SYSTEM.md`, which **replaces** Pi's default prompt entirely. This gave us:

- Full control over every token in the system prompt
- Clear boundary between our authored Cognitive Frame and the appended Project Index content
- The environment extension handles `${VAR}` substitution and appends `<system_boundary>`

## Assembly Constraints

1. **Channels are fixed** — There's exactly one `--append-system-prompt` argument. If we needed a second append channel, we'd need to modify Pi itself.
2. **No per-layer channels** — Role Definition and Domain Guidance share the append channel. The `<skill_context>` tag is our only semantic separator.
3. **No injection between Cognitive Frame sections** — `--append-system-prompt` goes after SYSTEM.md's content. We can't inject between `<system_directives>` and `<system_context>`.
4. **Environment extension has the last word** — It appends `<system_boundary>` at the absolute end, after all Pi auto-appends. No component runs after it.

## Related Documents

- [Layer Architecture](layer-architecture.md) — What each layer is and why
- [Design Principles](design-principles.md) — Core concepts behind the architecture
- [Security Architecture](security-architecture.md) — How boundaries protect the assembly
