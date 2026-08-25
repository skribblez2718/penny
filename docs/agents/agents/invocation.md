# Agent Invocation — Dispatch, exact IDs, and mandatory capture

## Assembly

1. Resolve the catalog entry from the registered snapshot.
2. Inject optional static Domain Guidance before `<agent_boundary>`.
3. Add Project Index and current task context.
4. Strip approval/receipt secrets and memory-write configuration.
5. Preflight every YAML tool provider and every supplied artifact ID.
6. Spawn with the exact YAML `--tools` list.

## Task contract

A task contains the goal, constraints, optional exact `input_artifacts` IDs, and any
required output/routing contract. IDs may come from any agent, branch, run, or session.
Do not put predecessor payload bytes, memory pointers, or name-only references in task
text.

Workers read needed IDs with `artifact_read` and repeat `next_range` until complete. If a
required ID/path is absent, they return `missing_input:` rather than searching memory,
`/tmp`, the repository, or historical sessions.

## Completion

The execution owner automatically persists the canonical final assistant text (all final
`text` parts in order, no inserted separator) and immediately reads it back. A successful
result is impossible if persistence or re-read fails. The exact ID is printed in result
text and retained in structured details.

For engine workflows, owner persistence/re-read occurs before the final closed `SUMMARY`
line is parsed into routing state. No absent-from-YAML submission tool is injected.

## Modes

- **Single:** arbitrary exact inputs → one persisted result ID → Penny.
- **Parallel:** branch-specific arbitrary inputs; each branch persists independently and
  returns a labeled ID. A branch persistence failure is a communication failure.
- **Chain:** previous step ID is automatic; each step may add explicit multi-source IDs;
  every step persists before the next starts; result text lists all step IDs.
- **Fan-in:** outputs from different runs/agents can be passed together to one consumer.

## Recovery and compaction

Checkpoints retain compact refs, never payloads. Compaction preserves only code-proven
current-session subagent/skill refs, explicitly reused input IDs, and prior exact resume
index records. Large sets become one immutable handoff-index artifact; there is no global
artifact or memory scan.

## Verification

- [ ] Inputs are verified before model usage.
- [ ] Exact YAML tools are active under every production path/profile.
- [ ] Complete output persistence and re-read precede success/routing.
- [ ] Single, parallel, chain, cross-run fan-in, restart, and failure injection pass.
