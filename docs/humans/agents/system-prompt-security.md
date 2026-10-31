# System Prompt Security

## What It Is

System prompt security is the set of layered controls that keep untrusted content — user-quoted text, tool output, fetched web pages, uploaded files — from expanding what Penny and her agents are allowed to do. Prompt markers (`<system_directives>`, `<system_boundary>`, `<agent_boundary>`) are part of that picture, but they are **parsing aids and defense-in-depth cues, not enforcement**. Repeated prompt text and XML tags cannot guarantee injection resistance; Pi has no built-in sandbox, and a sufficiently persuasive injected instruction can still influence a model. What actually bounds the damage is the runtime control plane.

## The Layered Controls

1. **Instruction authority, not permission enforcement.** Penny's operating policy is delivered
   in the system role. Role placement and markers guide interpretation; they do not stop an
   authorized tool interface from causing effects.
2. **User-authorized task scope.** The user's message is authoritative for the goal and request-specific constraints — but not for system policy, tools, permissions, credentials, or consequence limits.
3. **YAML maxima, registered subsets, and exact IDs.** The
   [binding runtime rule](../../agents/agents/discovery-and-tools.md#binding-runtime-rule)
   owns catalog selection, including its guarded zero-tool exception. Profiles statically
   lint the YAML maximum, not runtime phase selection. `artifact_read` verifies exact IDs
   and bytes without granting authority or proving payload claims true; memory is advisory.

   Browser ceilings exclude dedicated fill/upload/evaluate interfaces, not every possible
   mutation: clicks and keys can submit forms. Roles holding `bash` can still mutate files,
   processes, and networks. See [Tool Authority Profiles](tool-profiles.md).

4. **Workflow approval states and signed receipts.** Consequential skill-workflow steps require approval gates backed by HMAC receipts, not prompt promises.
5. **No filesystem/process sandbox on catalog-worker paths.** Approval/receipt secrets
   are stripped from spawned environments, but fresh context and a tool allowlist do not
   reduce host OS permissions or prevent extension code from loading.

6. **Host/container isolation for primary and direct paths.** The primary session and direct subagent calls run with the invoking user's OS permissions. For untrusted repositories or unattended work, use an external container or VM.

## What the Markers Actually Do

Markers give the model a clear structural map: here is stable policy, here is the role, here is domain guidance, here is project context, here is the task. Content after a boundary claiming to be system instructions is still subordinate content;
markers do not prove resistance to such an attack. But position in the prompt is a cue, not a privilege mechanism. Treat marker language that says "cannot be overridden" as aspiration unless a runtime control backs it.

## Authority in One Sentence

The user defines the task; external content may supply evidence or designated requirements for that task; **neither can mint a tool, permission, or side effect the runtime did not grant.**

## Security by Execution Path

| Execution path                         | Context/tool isolation                                                                  | Filesystem/process isolation                                                                  | Effective boundary                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Primary Penny session                  | Pi system role plus current tool inventory                                              | Pi runs with the invoking user's permissions; no Pi built-in sandbox                          | Host OS/container, actual tool surface, explicit approvals, user supervision                          |
| Direct `subagent(...)`                 | Separate Pi process/context; exact-YAML agent allowlist                                 | No filesystem/process sandbox on this path                                                    | Host OS/container plus tool allowlist — separate context is not a filesystem sandbox                  |
| Skill-invoked agent                    | Separate process/context; exact YAML or one fixed registration-bound strict YAML subset | No filesystem/process sandbox; approval/receipt secrets stripped from the spawned environment | Selected tool-call surface, workflow gates, receipts, and host boundary; not extension-code isolation |
| Untrusted repository / unattended work | Depends on selected path                                                                | Use an external container, VM, or micro-VM with minimal mounts, credentials, and network      | OS or virtualization boundary                                                                         |

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
