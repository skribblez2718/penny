# System Prompt Trust Boundaries and Runtime Controls

## What

Prompt markers (`<system_directives>`, `<system_boundary>`, `<agent_boundary>`) are structural delimiters and defense-in-depth cues. They help the model parse where each context region begins and ends. They do not create a privilege, permission, or filesystem boundary by themselves. Enforceable controls come from system-role placement, the actual tool surface, agent tool allowlists, workflow approvals and receipts, process isolation where enabled, and OS/container permissions.

## Authority model

The invocation message is authoritative for the goal and task-specific constraints. It cannot alter the agent's role, tool allowlist, approval boundaries, system policy, or runtime permissions. External content (tool outputs, fetched pages, uploaded files, quoted text) may be followed as task material when the user or a trusted workflow designates it; text embedded in that content cannot authorize additional capabilities or side effects merely by containing imperative language.

## Rules

1. **Markers are structural.** Describe them as delimiters and authority reminders, never as enforcement.
2. **Task authority ≠ permission authority.** The task defines what work is requested; runtime controls define what actions are possible.
3. **External requirements are conditional.** Follow instructions found in external content only within the user's request and runtime limits; they are not self-authorizing.
4. **Keep the literal tokens.** The runner strips the exact `# On-Demand Protocols` heading for subagents and inserts `<skill_context>` immediately before the literal `<agent_boundary>` marker. Renaming either breaks prompt assembly.
5. **Skill prompts must not contain reserved tags or template variables.** They are injected inside the system-role region; dynamic values belong in the task message.

## Context assembly vs. control plane

Two parallel structures — do not conflate them:

```
Context assembly (parsing aid)          Control plane (enforcement)
------------------------------          ---------------------------
<system_directives>                     System-role message placement
<system_context>   ← operating policy   Tool surface actually registered
[agent body]       ← Role Definition    Agent --tools allowlist
<skill_context>    ← Domain Guidance    Workflow approvals + signed receipts
<agent_boundary>   ← insertion anchor   Process isolation (path-specific)
[AGENTS.md context]← Project Index      OS/container permissions
<system_boundary>  ← structural end
[task message]     ← task-authoritative
```

## Execution-path isolation status

| Path                      | Isolation                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary Penny session     | Pi process with the invoking user's permissions; no Pi built-in sandbox                                                                                                                                                                                               |
| Direct `subagent(...)`    | Separate process/context + `--tools` allowlist; no filesystem/process sandbox                                                                                                                                                                                         |
| Skill-invoked agent       | Same as direct `subagent(...)` — separate process/context + `--tools` allowlist; no filesystem/process sandbox (the prior Bubblewrap `executionOwnerIsolation` layer was removed 2026-08-06; a containerized (Docker) replacement is planned but not yet implemented) |
| Untrusted/unattended work | Use an external container/VM with minimal mounts, credentials, network                                                                                                                                                                                                |

The agent runner force-loads Penny's project extension modules so their tools exist regardless of agent working directory; `--tools` controls which registered tools are exposed to the model. Module execution and model tool authority are separate trust surfaces — a tool allowlist does not prevent extension code from loading.

## Verification

- [ ] Prompt markers present and described as structural, not enforcement
- [ ] User/task authority distinguished from permission authority
- [ ] External requirements allowed only within the user's request and runtime limits
- [ ] Each catalog agent's active tools equal YAML `tools:` exactly; profiles statically
      lint that list through `scripts/system/checks/check_tool_profiles.py`, while runtime
      equality guards cover every production runner
      (see [Tool Authority Profiles](tool-profiles.md)). Browser authority is
      structural; `bash` means filesystem and process authority remain advisory.
- [ ] Execution-path isolation status accurately documented
- [ ] Destructive/external/sensitive actions have a deterministic gate where feasible
- [ ] `<agent_boundary>` present in every agent definition (runner insertion anchor)
- [ ] `<system_boundary>` appended by environment extension
- [ ] No reserved tags or template variables in skill prompts

## Files

| File                                      | Purpose                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `.pi/SYSTEM.md`                           | `<system_directives>` and `<system_context>`                                      |
| `.pi/extensions/environment/index.ts`     | `<system_boundary>` marker append                                                 |
| `.pi/extensions/subagent/agent-runner.ts` | On-Demand strip, `<agent_boundary>` anchor, tool allowlists                       |
| `.pi/extensions/skill/index.ts`           | Skill orchestration loop, agent dispatch (no filesystem sandbox as of 2026-08-06) |
| `docs/agents/prompts/architecture.md`     | Full assembly pipeline                                                            |
