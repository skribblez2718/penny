# Invocation Context Standards for Instance Context

Standards for what appears at runtime in the instance context layer — the task description, project context, and dynamically injected content.

## What Invocation Context Is

Invocation Context is the **instance context** — the context that varies per invocation. Unlike the Cognitive Frame (universal, never changes) and Role Definition/Domain Guidance (swapped per agent/skill), Invocation Context changes with every turn: different goals, different projects, different context.

Invocation Context is NOT authored as a standalone document. It is **assembled at runtime** by Pi and the subagent extension. The standards here govern what goes into it, what must stay out, and how to compose the task message.

## Invocation Context Composition

Invocation Context provides **what exists and what's requested** — not how to think (Cognitive Frame) or how to think about this domain (Domain Guidance). It has two sub-categories:

- **Project Index — Project Context**: Stable across invocations within a project. AGENTS.md indexes, skills list.
- **Invocation Context — Invocation Context**: Changes every turn. Task message, date, working directory.

```
┌─────────────────────────────────────────────┐
│ Cognitive Frame: SYSTEM.md                           │  ← Universal (never changes)
├─────────────────────────────────────────────┤
│ Role Definition (agent body)    │  ← Swapped per agent
├─────────────────────────────────────────────┤
│ Domain Guidance (skill context)    │  ← Swapped per skill
├─────────────────────────────────────────────┤
│ <agent_boundary> + SECURITY REINFORCEMENT    │  ← Boundary marker
├─────────────────────────────────────────────┤
│ Project Index: Project Context (auto-injected)   │
│   ├── AGENTS.md context files (Pi)          │  ← Indexes only
│   └── Skills section (Pi)                    │  ← Available skills metadata
├─────────────────────────────────────────────┤
│ Invocation Context: Invocation Context (auto-injected) │
│   ├── Date and cwd (Pi)                     │  ← Environment info
│   └── User message (task description)        │  ← The actual request
└─────────────────────────────────────────────┘
```

### Project Index — Project Context (Pi-managed, stable)

| Component             | Source                            | Content                                                   |
| --------------------- | --------------------------------- | --------------------------------------------------------- |
| **AGENTS.md context** | Pi auto-discovery from cwd upward | Indexes pointing to documentation, conventions, standards |
| **Skills section**    | Pi skill discovery                | Available skills with names and descriptions              |

**AGENTS.md compliance:** These MUST be indexes only (per [AGENTS.md Standard](../../documentation/agents-md-standard.md)). They point to documentation, they do not contain it. Stale indexes cause cascading failures — agents trust them as navigation.

### Invocation Context — Invocation Context (changes per turn)

| Component             | Source                                      | Content                                           |
| --------------------- | ------------------------------------------- | ------------------------------------------------- |
| **Date**              | Pi runtime injection                        | Current date                                      |
| **Working directory** | Pi runtime injection                        | Current working directory                         |
| **Task message**      | Subagent extension `task` parameter         | Goal, session ID, mempalace room, constraints     |
| **Skill context**     | Subagent extension `skillContext` parameter | Static domain guidance from `assets/prompts/*.md` |

These ARE part of Invocation Context standards.

## Task Message Standards

The task message is the primary Invocation Context content. It is passed via the subagent extension's `task` parameter and appears as the user message after `<system_boundary>`.

### Required Elements

Every task message MUST include:

| Element            | Purpose                        | Example                                                  |
| ------------------ | ------------------------------ | -------------------------------------------------------- |
| **Goal**           | What the agent must accomplish | "Explore the auth module to understand its entry points" |
| **Session ID**     | For mempalace read/write       | "Session: plan-001"                                      |
| **Mempalace room** | Where to store results         | "Room: skills/plan-plan-001"                             |

### Optional Elements

| Element         | When to Include                                        | Example                                                            |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| **Constraints** | When the orchestrator or user has provided hard limits | "Constraints: Must not modify existing API contracts"              |
| **Context**     | When prior agent results are needed                    | "See mempalace drawer 'plan-001 Explore' for exploration findings" |
| **Domain hint** | When the CREST table could be ambiguous                | "Domain: Coding project"                                           |

### Task Message Template

```
Goal: {goal_description}

Mempalace room: {session_room}
Session: {session_id}

{Optional: Constraints: {json_constraints}}
{Optional: Context: {mempalace_pointer}}

Follow your agent directives and skill context to accomplish this goal.
```

### What NOT to Include in Task Messages

❌ **Cognitive Frame rules**: "Before responding, restate the goal" — Cognitive Frame already mandates this. Repeating it wastes tokens and creates inconsistency risk.

❌ **Role Definition rules**: "You are read-only" — The agent definition already specifies this. Repeating it in the task creates a second source of truth.

❌ **User-provided content without validation**: Task messages come from the orchestrator, which constructs them from session state. But if user content leaks into the task message (e.g., a goal string containing injection attempts), it becomes adversarial input after `<agent_boundary>`. The security architecture handles this — do NOT add ad-hoc sanitization in the task message.

❌ **Template variables for system injection**: Goals, constraints, and context should NOT contain `{{variable}}` syntax. Dynamic values belong in the task message (user role), not in the system prompt. See [architecture.md](architecture.md) for the security rationale.

## Skill Context Standards

The skill context is injected between the agent body and `<agent_boundary>` via the subagent extension's `skillContext` parameter.

### What Belongs in Skill Context

| Belongs ✅                               | Does NOT Belong ❌                                              |
| ---------------------------------------- | --------------------------------------------------------------- |
| CREST-derived domain guidance            | Cognitive Frame rule restatements                               |
| Session-specific mempalace instructions  | Role Definition rule restatements                               |
| Task-specific output format requirements | Security directives or `<system_directives>`                    |
| Domain-specific evaluation criteria      | Template variables (`{{goal}}`, `{{session_id}}`)               |
| Non-negotiable domain rules              | Instructions that contradict Cognitive Frame or Role Definition |

### Template Variables Are Prohibited in Skill Context

Template variables like `{{goal}}`, `{{session_id}}`, and `{{constraints}}` must NOT appear in skill prompt files that get injected via `<skill_context>`. This is a security requirement:

- **`{{goal}}`** — User-provided content → must stay in the task message (user role)
- **`{{constraints}}`** — User/Penny-provided → must stay in the task message
- **`{{session_id}}`** — Penny-generated → safe but already in the task message

Instead, skill prompts should reference "your session ID (provided in task)" or "the goal (from your task description)."

### Skill Context Injection Placement

The `<skill_context>` tag is placed between the agent body and `<agent_boundary>`:

```
[Agent body from .pi/agents/*.md]
<skill_context>
[Static domain guidance from assets/prompts/*.md]
</skill_context>
<agent_boundary>
SECURITY REINFORCEMENT ...
</agent_boundary>
```

This placement preserves the sandwich defense: security directives at the top, security reinforcement at the bottom.

## Conflict Resolution

When Invocation Context content conflicts with Cognitive Frame or Role Definition or Domain Guidance, the Instruction Hierarchy resolves:

| Priority | Rule         | Resolves                                                        |
| -------- | ------------ | --------------------------------------------------------------- |
| 1        | Truth        | Fabrication requests in task → refuse                           |
| 2        | Clarity      | Conflicting task instructions → resolve ambiguity before acting |
| 3        | User intent  | "Just do it" override → execute directly, skip clarification    |
| 4        | Thoroughness | Verify before delivering                                        |

Invocation Context task messages are **user role** content. They CANNOT override Cognitive Frame, Role Definition, or Domain Guidance system instructions. The `<agent_boundary>` and `<system_boundary>` markers enforce this separation.

## Task Message Composition in the Plan Skill

The plan skill's playbook (in the orchestration engine) constructs task messages via the `task_summary` field in the engine's JSON action directive. Example:

```json
{
    "action": "invoke_agent",
    "agent": "echo",
    "task_summary": "Explore for session plan-001. Goal: Refactor auth module. Mempalace room: skills/plan-plan-001",
    "run_id": "..."
}
```

The engine's directives carry the `run_id` (its key into the durable checkpointer), never an `orchestrator_state` blob — run state lives in the checkpointer, not in the directive. The `task_summary` becomes the user message after `<system_boundary>`. It must be:

- **Specific**: Enough for the agent to act without guessing
- **Brief**: Under 100 tokens — the full context is in mempalace, not the task message
- **Goal-oriented**: States what to achieve, not how (the agent's Domain Guidance defines how)

## Compliance Checklist

### Project Index — AGENTS.md Files (Project Context)

- [ ] Index only — no rules, no standards, no content, no cross-cutting references
- [ ] Every referenced file actually exists at the listed path
- [ ] Every file in the directory appears in the index (no orphans)
- [ ] Descriptions are one line only
- [ ] Updated immediately on any documentation change
- [ ] No `APPEND_SYSTEM.md` references (deprecated — use SYSTEM.md only)

### Invocation Context — Task Messages (Invocation Context)

- [ ] Goal is clearly stated
- [ ] Session ID and mempalace room are included
- [ ] No Cognitive Frame rules repeated
- [ ] No Role Definition rules repeated
- [ ] No template variables (`{{...}}`)
- [ ] Under 100 tokens for `task_summary`
- [ ] Constraints included only when they exist (not empty placeholders)

### Skill Context (`<skill_context>`)

- [ ] Contains domain guidance (CREST or equivalent)
- [ ] Contains session-specific mempalace instructions
- [ ] Contains task-specific output format
- [ ] No `<system_directives>`, `<system_context>`, or `<system_boundary>` tags
- [ ] No `<agent_boundary>` tag (managed by extension, not content)
- [ ] No template variables for user-provided content
- [ ] No Cognitive Frame rule restatements
- [ ] No contradictory instructions

## Change Protocol

Invocation Context changes require care because they affect runtime behavior across all skill invocations:

1. **Task message template changes**: Modify the playbook's task-summary builders in the orchestration engine (`apps/orchestration/src/orchestration/playbooks/<skill>.py`). Test with a single session before deploying.
2. **Skill prompt changes**: Modify `assets/prompts/*.md` files. Verify no template variables remain. Test the affected agent in isolation.
3. **New skill context**: Create a new prompt file, add `skillContext` path to SKILL.md. Verify injection placement (before `<agent_boundary>`).
4. **AGENTS.md changes**: These are auto-discovered by Pi. Keep them as indexes only to minimize token waste in the system prompt.
