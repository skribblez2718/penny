# Agent Overview — Architecture, lifecycle, and invocation patterns

## What

Agents are specialized subprocesses with isolated context. Each agent has a defined role, tool set, and constraints. Penny delegates to agents via the `subagent` tool; skills orchestrate them via state machines.

## Why

Agents provide domain expertise (specialized reasoning) and context preservation (offloading work from Penny's context window). Delegation keeps Penny's context bounded for orchestration and user interaction.

## Rules

1. **Penny routes; agents execute.** Penny decides which agent to invoke. The agent performs the work and returns a SUMMARY.
2. **Full output stays in mempalace.** Agents write complete results to mempalace. Penny only receives the structured SUMMARY.
3. **Agents are context-adaptive.** The same agent works across domains because domain-specific guidance comes from skill prompts, not the agent definition.
4. **No agent variants.** Don't create `echo-weather.md`. Add Domain Guidance to the skill instead.

## Agent Roster

| Agent | Role | Key Constraint |
|-------|------|---------------|
| **echo** | Gather context, investigate | READ-ONLY |
| **piper** | Create execution plans | DOMAIN-AGNOSTIC |
| **carren** | Critique, review | READ-ONLY, NO REWRITING |
| **tabitha** | Convert plans to tasks | ATOMIC tasks |
| **skribble** | Scaffold files | Write from specs only |
| **vera** | Validate compliance | Assertions only |
| **synthia** | Synthesize findings | Read + mempalace only |
| **annie** | Deep analysis | Domain-specific |

## Lifecycle

1. **Invocation:** Penny or skill orchestrator calls `subagent({ agent, task, skillContext })`
2. **Assembly:** Subagent extension combines agent body + skill context + agent_boundary
3. **Execution:** Pi spawns agent subprocess with assembled system prompt + task message
4. **Completion:** Agent writes full output to mempalace, returns SUMMARY to caller

## Three-Tier Routing

1. **Direct** — Penny does it (single tool call, trivial)
2. **Agent** — `subagent({ agent, task })` (matches specialty, >1 step)
3. **Skill** — `skill({ skill_name, goal })` (multi-agent orchestration)

## Constraints

- **Never ingest full agent output into Penny's context.** Read SUMMARY only.
- **Never create agent variants for different domains.** Use Domain Guidance.
- **All agents must have the four memory tools.**

## Verification

- [ ] Agent definitions follow `definition-format.md`
- [ ] No agent variants exist (one file per role)
- [ ] All agents have memory tools

## Files

| File | Purpose |
|------|---------|
| `docs/agents/agents/definition-format.md` | Agent file structure |
| `docs/agents/agents/invocation.md` | Invocation patterns |
| `docs/agents/agents/discovery-and-tools.md` | Tool discovery |
