# The Skill Standard

## What It Is

The skill standard is the contract that every Penny skill must satisfy. It covers four things: the SKILL.md manifest format, the engine playbook and its delegate, the Domain Guidance prompts, and the testing requirements. Following the standard ensures Pi can discover the skill, Penny can route to it correctly, and the agents inside it receive the right instructions.

## Why Standards Matter

Skills run inside a larger system. Pi reads their manifests to decide when to invoke them. Penny trusts their orchestrators to emit valid action directives. Agents rely on their Domain Guidance prompts for context. If every skill invented its own conventions, the integration points would break constantly.

A common standard also makes skills easier to write and easier to maintain. The engine provides the shared machinery — checkpointing, budgets, gates, parallel fan-out, escalation — so authors spend time on the workflow logic, not on boilerplate.

## What the Standard Covers

### 1. SKILL.md Manifest

Every skill has a `SKILL.md` file at its root. The file contains:

- YAML frontmatter with the skill name, description, version, and metadata flags. `metadata.penny.engine: orchestration` is the routing key that runs the skill on the shared engine.
- A Markdown body explaining when to use the skill, when not to use it, and the invocation syntax.

The manifest is the Project Index layer: it tells Penny when to reach for the skill. It is not the place for deep domain guidance; that lives in `assets/prompts/`.

### 2. Engine Playbook and Delegate

The workflow itself is a `BasePlaybook` subclass in the engine package (`apps/orchestration/src/orchestration/playbooks/<skill>.py`), registered in `playbooks/__init__.py`. It defines the named states, per-state SUMMARY contracts, routing (`route_after`), a `done_predicate`, and — as needed — planned gates, parallel fan-out, deterministic tool states, and escalation.

The `scripts/orchestrate.py` file is a ~5-line delegate:

```python
from orchestration.cli import main
raise SystemExit(main(default_playbook="<skill>"))
```

It holds no FSM logic and no state serialization. The engine communicates with Penny through JSON action directives on stdout, supporting `start`, `step`, `status`, and `recover`. This decouples the skill's logic from Penny's execution: the playbook decides what to do next; Penny handles how to invoke the requested agents and tools.

### 3. Domain Guidance Prompts

For every agent role a skill uses, there is a matching prompt file in `assets/prompts/`. These prompts provide the domain-specific instructions that transform a generic agent into a domain expert for this workflow. They are injected at invocation time and sit before the agent's `<agent_boundary>`.

### 4. Testing Requirements

Every skill must have unit, integration, and E2E tests. This is not optional. Skills are too complex to verify by inspection alone; the playbook's states, routing, and agent interactions all need automated coverage. Playbook tests drive the engine step by step against a temporary checkpointer (see `apps/orchestration/tests/test_code_playbook.py` for the reference pattern).

## What Makes a Well-Formed Skill

A well-formed skill is one you can hand to another maintainer and they will immediately know:

- What problem it solves.
- When Penny should use it.
- Which agents are involved and what each one does.
- How to run and test it.
- Where the state is stored and how it recovers from failure.

That clarity comes from following the standard layout, writing a clear manifest, and including comprehensive tests. Where state is stored and how it recovers is uniform: the engine's durable checkpointer keyed by `run_id`, auto-resumed on interruption.

## Learn More

- [Skills Overview](overview.md): What skills are and how they compare to agents.
- [Orchestration](orchestration.md): How the engine dispatches agents.
- [Testing](testing.md): How skills are tested.
- Agent-facing reference: [Skill Standard](../../agents/skills/skill-standard.md)
