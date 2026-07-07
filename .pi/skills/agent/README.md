# Agent Skill

Generate a Penny agent definition (`.pi/agents/<name>.md`) from a goal, validated
against the Penny agent standard.

## Architecture

The skill is `AgentPlaybook`, a `BasePlaybook` subclass on the shared
orchestration engine (`apps/orchestration/src/orchestration/playbooks/agent.py`).
`scripts/orchestrate.py` is a thin ~5-line delegate to `orchestration.cli`;
`SKILL.md` carries `metadata.penny.engine: orchestration`. Run state lives in the
engine's durable SQLite checkpointer keyed by `run_id` — there are no `/tmp`
session files, no `--state` argv, and no `extract_state`/`restore_state`.

## Flow

```
intake → exploring → designing → critiquing → scaffolding → verifying → complete
                         ↑___________|             ↑____________|
                     critique revision        verify re-scaffold
                     (re-explore/re-design)      (re-scaffold)
```

- **Critique revision loop**: a non-APPROVE verdict routes back to `exploring`
  (first cycle) or `designing` (later cycles), bounded by `max_iterations`.
- **Verify re-scaffold loop**: a failing verification routes back to
  `scaffolding`, bounded by `max_iterations`.
- Both loops exit to `complete` with `met=False` on honest exhaustion (the
  unresolved issues/checks are reported, never force-approved).
- Escalation: `needs_clarification`, `UNCERTAIN` confidence, or a stall pauses the
  run at `awaiting_clarification`; the user response resumes into `exploring`.

See `resources/flow.mmd` for the exact FSM and `resources/reference.md` for the
full state/transition/gate tables.

## Agents (one per state)

| State       | Agent    | Role                                   |
| ----------- | -------- | -------------------------------------- |
| exploring   | echo     | Gather agent patterns, schema, conventions |
| designing   | piper    | Design the agent definition            |
| critiquing  | carren   | Critique the design vs. the standard   |
| scaffolding | skribble | Generate `.pi/agents/<name>.md`        |
| verifying   | vera     | Validate the generated file (external oracle, evidence-backed) |

## Mempalace

- Room: `skills/agent-<session_id>` (wing `penny`).
- Agents write full findings to the room under per-state headers
  (`<session_id> Explore` / `Design` / `Critique` / `Verify`); the engine sees
  the SUMMARY only.

## Files

| File                     | Purpose                                  |
| ------------------------ | ---------------------------------------- |
| `scripts/orchestrate.py` | Thin delegate to the engine CLI          |
| `SKILL.md`               | Skill metadata + domain guidance         |
| `assets/prompts/*.md`    | Per-agent domain guidance                |
| `resources/reference.md` | State/transition/gate reference          |
| `resources/flow.mmd`     | Mermaid FSM diagram                       |
