# Agent Skill

## What It Is

A structured workflow that generates validated Penny agent definitions (`.pi/agents/<name>.md`) from a goal description. It uses five specialized agents and a Python state machine orchestrator to explore, design, critique, scaffold, and verify each new agent.

## When to Use

- You need a new agent definition for a specific role or domain
- Creating an agent as part of a larger skill (sub-skill mode)
- Ensuring a new agent follows Penny's agent definition standard

## When Not to Use

- Modifying an existing agent (edit the file directly)
- Simple one-line edits (execute directly)
- The user explicitly says "just create it" (use `skribble` agent directly)

## How It Works

1. **Explore** (Echo agent): Gathers patterns from existing agents, conventions, and requirements
2. **Design** (Piper agent): Synthesizes findings into a structured agent specification
3. **Critique** (Carren agent): Reviews the design for schema compliance, security, and completeness
4. **Scaffold** (Skribble agent): Generates the actual `.pi/agents/<name>.md` file
5. **Verify** (Vera agent): Validates the generated file against the Penny agent standard

Each agent writes its full output to mempalace (`skills/agent-<session_id>`). Penny only sees structured summaries.

## Safety Features

- **UNKNOWN_STATE**: If any agent reports `UNCERTAIN` confidence, the FSM halts and asks you for direction
- **Approve/Refine Cycle**: After the skill completes, Penny presents the agent definition and asks for approval — it never installs before explicit consent
- **Post-Approval Registration**: Once approved, Penny updates `AGENTS.md` and scaffolds human/agent docs so the new agent is properly indexed and documented

## Constraints

| Constraint              | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| `agent_name`            | Override the name extracted from the goal                |
| `parent_session_id`     | Links to a calling skill when invoked as a sub-skill     |
| `create_skill_scaffold` | Always rejected — agent skill creates agents, not skills |

## Direct Agent Invocation (Not Just Skills)

Agents are also available for **direct ad-hoc delegation** — you don't need a full skill orchestrator. Use the `subagent` tool directly when a task matches an agent's specialty and benefits from its constraints.

| Agent | Specialty | Invoke Directly When |
|-------|-----------|---------------------|
| **echo** | Gather context, investigate, research, explore files | Multi-source investigation, evidence gathering |
| **carren** | Critique, review, gap analysis | Challenging assumptions, reviewing plans or code |
| **vera** | Validate compliance, check assertions | Schema verification, security audits |
| **synthia** | Synthesize research findings | Multi-source research reports |
| **tabitha** | Decompose plans into structured tasks | Breaking approved plans into execution specs |
| **skribble** | Scaffold files, write boilerplate | Creating files from plans/templates |

### Three-Tier Routing

Penny routes every task through one of three tiers — always choosing the simplest that satisfies:

1. **Direct** — Penny does it herself (single tool call, trivial verification)
2. **Agent** — Penny calls `subagent({ agent, task })` (matches specialty, >1 step, benefits from constraints)
3. **Skill** — Penny calls `skill({ skill_name, goal })` (multi-agent orchestration with state machine)

**Delegation litmus:** Does this task benefit from the agent's specialized constraints? YES → delegate. NO → direct.

### Context Passing

When delegating directly, include full context in the `task` parameter — agents have no access to your conversation history:

```
Task: <one-sentence goal> | Context: <background> | Sources: <file paths> | Constraints: <limits>
```

### Anti-Patterns

- **Over-delegation:** Don't spawn an agent for a single file read, simple edit, or one-line bash command.
- **Under-delegation:** Don't read 20 files in-context when `echo` can do it in isolation; don't write code without tests when the code skill enforces TDD.

## Learn More

- Agent docs: `docs/agents/agent-skill.md`
- Design: `.pi/skills/agent/README.md`
- Implementation: `.pi/skills/agent/` — `SKILL.md`, `scripts/orchestrate.py`
- Tests: `.pi/skills/agent/tests/test_*.py`
