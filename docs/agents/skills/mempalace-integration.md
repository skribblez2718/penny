# MemPalace Integration for Skills — Inter-agent communication via memory

## What

Skills use mempalace as the communication bus between agents. Each agent reads upstream context and writes downstream results to the skill's session room.

## Why

Without a shared memory substrate, agents would need to pass data through Penny's context — bloating it and breaking the context-preservation model.

## Rules

1. **One room per skill session.** `skills/<skill_name>-<session_id>`.
2. **Agents read before acting.** Search the session room for prior agent output.
3. **Agents write after completing.** Store results in named drawers within the session room.
4. **Orchestrator reads SUMMARY only.** Full agent output stays in mempalace.

## Room Convention

```
skills/plan-<session_id>/
├── <session_id> state        # FSM state blob
├── <session_id> explore       # Echo findings
├── <session_id> plan          # Piper plan
├── <session_id> critique      # Carren review
└── <session_id> tasks         # Tabitha task list
```

## Constraints

- **Never pass full agent output through Penny.** SUMMARY only.
- **Drawer names must be consistent** across skill invocations for the same agent role.
- **Clean up session rooms** after skill completion (or let T2 expiry handle it).

## Verification

- [ ] Each agent writes to the correct session room
- [ ] Orchestrator reads SUMMARY, not full output
- [ ] Drawer names follow convention

## Files

| File | Purpose |
|------|---------|
| `docs/agents/memory/integration.md` | Memory integration patterns |
| `docs/agents/skills/orchestration.md` | Orchestrator protocol |
