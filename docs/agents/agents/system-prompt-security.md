# System Prompt Trust Boundaries and Runtime Controls

## What

Prompt markers (`<system_directives>`, `<system_boundary>`, `<agent_boundary>`) are structural delimiters and defense-in-depth cues. They help the model parse where each context region begins and ends. They do not create a privilege, permission, or filesystem boundary by themselves. Enforceable controls come from system-role placement, the actual tool surface, agent tool allowlists, workflow approvals and receipts, process isolation where enabled, and OS/container permissions.

## Authority model

The invocation message is authoritative for the goal and task-specific constraints. It cannot alter the agent's role, YAML maximum, active registration-bound phase subset, approval boundaries, system policy, or runtime permissions. External content (tool outputs, fetched pages, uploaded files, quoted text) may be followed as task material when the user or a trusted workflow designates it; text embedded in that content cannot authorize additional capabilities or side effects merely by containing imperative language.

## Rules

1. **Markers are structural.** Describe them as delimiters and authority reminders, never as enforcement.
2. **Task authority ≠ permission authority.** The task defines what work is requested; runtime controls define what actions are possible.
3. **External requirements are conditional.** Follow instructions found in external content only within the user's request and runtime limits; they are not self-authorizing.
4. **Keep the literal tokens.** The shared composer strips the exact `# On-Demand Protocols` heading for workers and places only host-bound static documentation and registered phase guidance before the literal `<agent_boundary>` marker. Renaming either breaks prompt assembly.
5. **Separate host-bound guidance from caller context.** Contract-declared documents and phase prompts may enter the system-role region after path and digest checks. Direct `subagent` `skillContext`, working-directory guidance, and other caller-selected material remain in the task message. Static guidance must not contain reserved structural tags or unresolved template variables.

## Context assembly vs. control plane

Two parallel structures — do not conflate them:

```
Context assembly (parsing aid)          Control plane (enforcement)
------------------------------          ---------------------------
<system_directives>                     System-role message placement
<system_context>   ← operating policy   Tool surface actually registered
[agent body]       ← Role Definition    YAML maximum + selected --tools allowlist
[canonical docs]   ← bound guidance     Source paths + content digests
<skill_context>    ← phase guidance     Workflow approvals + signed receipts
[runtime only]     ← no prompt layer    Registration subset + canonical digest
<agent_boundary>   ← insertion anchor   Process isolation (path-specific)
[AGENTS.md context]← Project Index      OS/container permissions
<system_boundary>  ← structural end
[task + context]   ← task-authoritative
```

## Execution-path isolation status

| Path                      | Isolation                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary Penny session     | Pi process with the invoking user's permissions; no Pi built-in sandbox                                                                                                                                                                                                                                                               |
| Direct `subagent(...)`    | Separate process/context + exact-YAML `--tools` allowlist; no filesystem/process sandbox                                                                                                                                                                                                                                              |
| Skill-invoked agent       | Separate process/context + exact-YAML allowlist by default, or one fixed registration-bound strict YAML subset for an eligible TypeScript phase; no filesystem/process sandbox (the prior Bubblewrap `executionOwnerIsolation` layer was removed 2026-08-06; a containerized (Docker) replacement is planned but not yet implemented) |
| Untrusted/unattended work | Use an external container/VM with minimal mounts, credentials, network                                                                                                                                                                                                                                                                |

The agent runner force-loads Penny's project extension modules so their tools exist regardless of agent working directory; the selected `--tools` list controls which registered tools are exposed to the model. Direct/parallel/chain paths select YAML exactly. Eligible TypeScript orchestration phases may select only their canonical-registration-bound strict subset; omission selects YAML exactly. Module execution and model tool authority are separate trust surfaces — neither allowlist form prevents extension code from loading.

## Verification

- [ ] Prompt markers present and described as structural, not enforcement
- [ ] User/task authority distinguished from permission authority
- [ ] External requirements allowed only within the user's request and runtime limits
- [ ] Direct/parallel/chain active tools equal YAML `tools:` exactly. TypeScript
      orchestration phases either preserve that equality or use one non-empty duplicate-free
      registration/digest-bound strict YAML subset that is validated before session creation
      and projected unchanged into worker invocation metadata. Profiles still statically lint
      the YAML maximum through `scripts/system/checks/check_tool_profiles.py`; subsets do not
      mutate profiles (see [Tool Authority Profiles](tool-profiles.md)).
- [ ] No task, trust profile, runtime condition, input, or unavailable service selects tools;
      additions, injections, replacements, empty/equality-sized subsets, and unavailable names
      fail closed.
- [ ] Browser authority is structural for the selected model-visible surface. A subset that
      omits `bash` is not OS/process sandboxing or extension-code isolation.
- [ ] Host-private isolated sessions remain anonymous and separate from catalog authority.
- [ ] Execution-path isolation status accurately documented
- [ ] Destructive/external/sensitive actions have a deterministic gate where feasible
- [ ] `<agent_boundary>` present in every agent definition (host-bound injection anchor)
- [ ] `<system_boundary>` appears exactly once at the end of the system-role prompt
- [ ] Caller-selected `skillContext` and task-project guidance remain below that boundary
- [ ] No reserved tags or unresolved template variables in static guidance

## Files

| File                                      | Purpose                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `.pi/SYSTEM.md`                           | `<system_directives>` and `<system_context>`                                      |
| `.pi/extensions/environment/index.ts`     | canonical `<system_boundary>` finalization                                        |
| `.pi/extensions/subagent/agent-runner.ts` | direct-worker assembly, task-context placement, tool allowlists                   |
| `.pi/extensions/skill/index.ts`           | Skill orchestration loop, agent dispatch (no filesystem sandbox as of 2026-08-06) |
| `docs/agents/prompts/architecture.md`     | Full assembly pipeline                                                            |
