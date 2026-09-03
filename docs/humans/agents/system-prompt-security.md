# System Prompt Security

## What It Is

System prompt security is the set of layered controls that keep untrusted content — user-quoted text, tool output, fetched web pages, uploaded files — from expanding what Penny and her agents are allowed to do. Prompt markers (`<system_directives>`, `<system_boundary>`, `<agent_boundary>`) are part of that picture, but they are **parsing aids and defense-in-depth cues, not enforcement**. Repeated prompt text and XML tags cannot guarantee injection resistance; Pi has no built-in sandbox, and a sufficiently persuasive injected instruction can still influence a model. What actually bounds the damage is the runtime control plane.

## The Layered Controls

1. **System-role authority.** Penny's operating policy is delivered in the system role, which models are trained to prioritize over user-role content.
2. **User-authorized task scope.** The user's message is authoritative for the goal and request-specific constraints — but not for system policy, tools, permissions, credentials, or consequence limits.
3. **YAML maximums, fixed orchestration subsets, and exact IDs.** Direct/parallel/chain catalog workers and orchestration phases without a subset activate the agent YAML list exactly. One eligible TypeScript orchestration phase may use a fixed non-empty duplicate-free strict YAML subset bound into its canonical registration digest and worker metadata. Trust profiles, tasks, inputs, runtime conditions, model/liveness policy, and optional services cannot select it. `artifact_read` performs direct exact-ID lookup and byte verification without grants or expiry; YAML-declared read-only memory is advisory only.

   Allowlists are now derived from a declared authority class rather than hand-curated, and a CI check fails the build if a role's tools drift from the authority it claims. This closed a real gap: several roles that declared themselves read-only in prose held form-fill, file-upload, and arbitrary-code-execution tools. **Be precise about what that fixed.** Browser authority is now structural — a read-only role genuinely cannot submit a form or execute Playwright code. Filesystem and shell authority are not: every agent still holds `bash`, so a read-only role can still write files, install packages, and reach the network. The allowlist bounds the browser surface; the host boundary and user supervision still bound everything else. See [Tool Authority Profiles](tool-profiles.md).

4. **Workflow approval states and signed receipts.** Consequential skill-workflow steps require approval gates backed by HMAC receipts, not prompt promises.
5. **No filesystem sandbox currently (2026-08-06).** Agents invoked by a workflow skill previously ran under Bubblewrap (filesystem mounted read-only except the work target and selected state paths, owner-protected paths shadowed). That layer was removed after testing showed it did not address the runtime failure mode it had been introduced to mitigate; receipt/approval secrets are still stripped from every spawned agent's environment regardless. A containerized replacement is planned but not yet implemented.
6. **Host/container isolation for primary and direct paths.** The primary session and direct subagent calls run with the invoking user's OS permissions. For untrusted repositories or unattended work, use an external container or VM.

## What the Markers Actually Do

Markers give the model a clear structural map: here is stable policy, here is the role, here is domain guidance, here is project context, here is the task. That clarity genuinely helps models resist confusion attacks — content after the boundary claiming to be system instructions is visibly out of place. But position in the prompt is a cue, not a privilege mechanism. Treat marker language that says "cannot be overridden" as aspiration unless a runtime control backs it.

## Authority in One Sentence

The user defines the task; external content may supply evidence or designated requirements for that task; **neither can mint a tool, permission, or side effect the runtime did not grant.**

## Security by Execution Path

| Execution path                         | Context/tool isolation                                                                  | Filesystem/process isolation                                                                                                        | Effective boundary                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Primary Penny session                  | Pi system role plus current tool inventory                                              | Pi runs with the invoking user's permissions; no Pi built-in sandbox                                                                | Host OS/container, actual tool surface, explicit approvals, user supervision                          |
| Direct `subagent(...)`                 | Separate Pi process/context; exact-YAML agent allowlist                                 | No filesystem/process sandbox on this path                                                                                          | Host OS/container plus tool allowlist — separate context is not a filesystem sandbox                  |
| Skill-invoked agent                    | Separate process/context; exact YAML or one fixed registration-bound strict YAML subset | No filesystem/process sandbox (Bubblewrap removed 2026-08-06; approval/receipt secrets still stripped from the spawned environment) | Selected tool-call surface, workflow gates, receipts, and host boundary; not extension-code isolation |
| Untrusted repository / unattended work | Depends on selected path                                                                | Use an external container, VM, or micro-VM with minimal mounts, credentials, and network                                            | OS or virtualization boundary                                                                         |

One more subtlety: the agent runner force-loads Penny's extension modules so providers can register regardless of working directory. The selected `--tools` allowlist—exact YAML or the eligible registration-bound strict subset—controls what the model can call; it does not prevent extension code from loading. An `artifact_read`-only active surface is therefore not OS/process sandboxing or extension-code isolation. An artifact ID is a communication address, while runtime checks still enforce manifest identity, path containment, digest, length, and UTF-8 ranges.

## What Skill Prompts Must Avoid

Skill Domain Guidance prompts are injected inside the system-role region, before `<agent_boundary>`. Because of that privileged position, they must not contain:

- Template variables such as `{{goal}}` or `{{session_id}}`, which would be filled at runtime from untrusted sources.
- Reserved boundary tags, which would confuse prompt assembly.
- Instructions that try to relax trust or action boundaries.

Dynamic values belong in the task message.

## Learn More

- [Agents Overview](overview.md): Why agents need this layering.
- [Agent Definition Format](definition-format.md): Where `<agent_boundary>` lives in an agent file.
- [Invocation](invocation.md): How task messages are placed after the boundaries.
- Agent-facing reference: [System Prompt Trust Boundaries and Runtime Controls](../../agents/agents/system-prompt-security.md)
