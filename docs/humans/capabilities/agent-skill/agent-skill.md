# Agent Skill

## What It Is

A structured workflow that generates validated Penny agent definitions (`.pi/agents/<name>.md`) from a goal description. It uses five specialized agents running on the shared orchestration engine to explore, design, critique, scaffold, and verify each new agent.

## When to Use

- You need a new agent definition for a specific role or domain
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

Between critique and verify the workflow loops as needed: a rejected critique sends the design back for revision (once via re-exploration, then straight back to design), and a failed verification re-scaffolds the file. Each agent writes its full output to mempalace (`skills/agent-<session_id>`). Penny only sees structured summaries.

## Safety Features

- **Escalation**: If any agent reports `UNCERTAIN` confidence — or a critique/verification keeps failing the same way with no progress — the run pauses and asks you for direction. Your answer resumes the same run.
- **Honest exhaustion**: Every retry loop is bounded. When the budget is spent, the skill reports the outcome truthfully (`met=false`, unresolved issues listed) rather than fabricating success.
- **Grounded verification**: `vera` must attach the actual per-check evidence (parsed frontmatter, section headers, failing lines); a bare "looks good" verdict is rejected.
- **Crash-safe**: Run state lives in the engine's durable checkpointer. A run interrupted mid-step is recovered automatically and the step is re-issued — no `/tmp` session files.
- **Approve/Refine Cycle**: After the skill completes, Penny presents the agent definition and asks for approval — it never installs before explicit consent.
- **Post-Approval Registration**: Once approved, Penny updates `AGENTS.md` and scaffolds human/agent docs so the new agent is properly indexed and documented.

## Constraints

| Constraint              | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `agent_name`            | Optional hint only — the authoritative name comes from the scaffold output     |
| `create_skill_scaffold` | Always rejected — agent skill creates agents, not skills                        |

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
3. **Skill** — Penny calls `skill({ skill_name, goal })` (multi-agent orchestration on the shared engine)

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

- Agent docs: `docs/agents/capabilities/agent-skill/agent-skill.md`
- Playbook (source of truth): `apps/orchestration/src/orchestration/playbooks/agent.py`
- Tests: `apps/orchestration/tests/test_agent_playbook.py`
- Skill entry: `.pi/skills/agent/SKILL.md` and `.pi/skills/agent/scripts/orchestrate.py` (delegate)
