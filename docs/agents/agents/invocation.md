# Agent Invocation — Dispatch, exact IDs, and mandatory capture

## Assembly

1. For direct/parallel/chain subagents, capture the current catalog once per tool invocation
   and resolve every requested name against it. Registered orchestration phases retain their
   separate registration-bound checks; catalog freshness does not authorize phase drift.
2. Inject optional static Domain Guidance before `<agent_boundary>`.
3. Add Project Index and current task context.
4. Strip approval/receipt secrets and memory-write configuration.
5. Preflight every YAML tool provider and every supplied artifact ID.
6. For direct/parallel/chain dispatch, pass exact YAML tools unchanged and verify active
   equality before the model prompt. For registered TypeScript phase selection or changes
   to tool activation, apply the full [binding runtime rule](discovery-and-tools.md#binding-runtime-rule),
   including its guarded zero-tool exception, before session creation.

## Task contract

For workflow task construction or field changes, use [Invocation Context fields](../prompts/invocation-context-standards.md#required-workflow-context).
IDs may come from any agent, branch, run, or session. Before model use, owner code verifies
every supplied `input_artifacts` ID by exact manifest lookup and digest/length; missing or
corrupt inputs fail explicitly.
Do not put predecessor payload bytes, memory pointers, or name-only references in task
text.

Workers read needed IDs with `artifact_read` using explicit UTF-8 byte ranges and repeat
`next_range` until complete (`truncated: false`). Reads and continuation do not expire. If a
required ID/path is absent, they return `missing_input:` rather than searching memory,
`/tmp`, the repository, or historical sessions.

For substantial assignments, [Bounded Work](bounded-work.md) owns outcome boundaries,
context fit, task readiness, and semantic handoff. One fresh invocation receives one coherent
assignment; multiple tool calls and local correction may serve that outcome. Required
predecessor products must be available before dispatch.

## Completion

The execution owner automatically persists the canonical final assistant text (all `text`
parts of the final assistant message in content-array order, no inserted separator) and
immediately reads it back. A successful result is impossible if persistence or re-read fails. The exact ID is printed in result
text and retained in structured details. Thinking/reasoning and tool-call parts are excluded;
a final message with no text is canonically empty, never replaced by an earlier turn.

Process/model completion and exact response delivery are not semantic task acceptance.
A substantial handoff identifies the assignment, acceptance conditions met and unmet,
actual outputs/changes and revisions, checks/results, decisions to preserve, and incomplete
work. Penny checks appropriate evidence before accepting the task or dispatching work
that depends on its acceptance. Follow registered output formats; do not invent SUMMARY
fields or treat a transport-success chain as a task-acceptance gate.

For engine workflows, owner persistence/re-read occurs before the final closed `SUMMARY`
line is parsed into routing state. An explicitly opted-in phase may instead bind a versioned
registration-owned pure projection from the exact captured core to confidence and complete phase
details. This narrow [domain-standard exception](../prompts/role-and-domain-standards.md#domain-guidance)
preserves source bytes and signed provenance; it supplies no new judgment, tools or admission
authority. Unopted and host-private transports are unchanged. Append that routing-only line only when Domain Guidance
defines it; it does not replace complete output. No absent-from-selected-surface submission
tool is injected.

## Modes

- **Single:** arbitrary exact inputs → one persisted result ID → Penny.
- **Parallel:** branch-specific arbitrary inputs; each branch persists independently and
  returns a labeled ID. A branch persistence failure is a communication failure.
- **Chain:** previous step ID is automatic; each step may add explicit multi-source IDs;
  every step persists before the next starts; result text lists all step IDs.
- **Fan-in:** outputs from different runs/agents can be passed together to one consumer.

## Recovery and compaction

Checkpoints retain compact refs, never payloads. Retry, clarification, restart, and partial
fan recovery reuse selected exact refs rather than reconstructing or searching for payloads.
Compaction preserves only code-proven
current-session subagent/skill refs, explicitly reused input IDs, and prior exact resume
index records in `[RESUME-REFS v2]`. Prose remains the primary orientation after compaction.
Large sets become one immutable handoff-index artifact; there is no global
artifact or memory scan.

## Verification

- [ ] Inputs are verified before model usage; needed reads continue through every range.
- [ ] Direct/parallel/chain dispatch asserts exact YAML equality; registered phase selection
      or tool-activation changes pass [runtime-rule verification](discovery-and-tools.md#verification).
- [ ] Complete output persistence and byte-for-byte re-read precede success/SUMMARY routing.
- [ ] Single, parallel, chain, cross-run fan-in, restart, and failure injection cover missing
      inputs, read/persistence failures, and exact final-text concatenation.
