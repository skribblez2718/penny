# Subagent Extension

Delegate specialized work to fresh Pi subprocesses while preserving every complete output
as an immutable artifact.

## Modes

```typescript
// Single
subagent({ agent: "carren", task: "Review the design." });

// Parallel — each branch may receive its own multi-source inputs
subagent({
  tasks: [
    { agent: "annie", task: "Analyze A.", input_artifacts: ["art_<id>"] },
    { agent: "carren", task: "Critique B.", input_artifacts: ["art_<id>"] },
  ],
});

// Chain — previous output is automatic; extra exact IDs are optional
subagent({
  chain: [
    { agent: "echo", task: "Collect evidence." },
    { agent: "annie", task: "Analyze {previous}." },
    {
      agent: "synthia",
      task: "Integrate {previous} with the additional review.",
      input_artifacts: ["art_<review-id>"],
    },
  ],
});
```

`{previous}` is an instruction marker only. Payload bytes are never substituted into the
task. The next step receives the previous exact artifact ID automatically.

## Exact communication

`input_artifacts` is an arbitrary-size unique list of exact IDs from any run in the current
opaque project partition. Before spawn, the owner performs exact manifest lookup plus
digest/length verification. A missing or
corrupt ID fails before model usage. There is no same-run restriction, grant creation, or
artifact authorization environment.

Workers read needed IDs with `artifact_read` and repeat with `next_range` until complete.
They must not recover another agent's output by memory search, repository search, `/tmp`
search, or a name-only pointer.

Every final assistant response—including a valid empty response—is persisted and re-read
before success. Persistence failure is a typed communication failure, never a best-effort
warning. Results print IDs in model-visible text:

- single: one exact-output block;
- parallel: one labeled ID per branch beside the bounded preview;
- chain: every step ID in order.

`details.outputArtifactRefs` retains the schema-v2 refs for renderers and compaction.

## Tool authority

`.pi/agents/<agent>.md` YAML `tools:` is the exact model-visible surface.

- Missing, empty, duplicate, or unknown entries fail before model invocation.
- The runner passes the exact list through `--tools` with no additions, removals,
  trust-profile stripping, conditional `artifact_read`, or `--exclude-tools` override.
- Every provider extension is loaded so declared names can register. Missing optional
  backing services remain visible and return typed operational errors when called.
- `authority:` and `tool_profiles:` statically lint the YAML list; they do not alter it at
  runtime.

The runner force-loads Penny's extension modules independently of the worker cwd. Loading
extension code and activating a model tool are separate surfaces.

## Discovery

The sole local catalog is `.pi/agents/*.md`. Discovery requires:

- a filename-matching `name`;
- a description;
- a non-empty, duplicate-free `tools:` list;
- optional model/provider/thinking settings.

Catalog drift after registration returns `SUBAGENT_RELOAD_REQUIRED`; run `/reload` before
retrying. Discovery never queries durable memory or infers remote service presence.

## Prompt assembly

The worker receives the transformed Cognitive Frame, the selected role definition,
optional static `skillContext`, project indexes, and the task. `skillContext` is inserted
immediately before the literal `<agent_boundary>` marker. Dynamic values belong in the
task, not static skill guidance.

## Durable Pi sessions

Worker sessions remain Pi JSONL, but their `--session-dir` is now the current catalog-bound
`subagent-sessions/<agent>/` directory below Penny's state root. The runner no longer
deletes the session directory in `finally`; history and recovery can inspect completed
worker sessions after process exit. Prompt scratch files remain temporary and are deleted.

Each worker session records a path-free custom metadata entry with project ID, agent name,
parent-session ID, and invocation ID. Completed owner-controlled JSONL files use a 30-day,
500-file-per-agent retention policy. The runner never follows or removes symlinks, hard links,
foreign files, broadened-mode files, unrelated files, or sessions modified within the last day.
Before migration, invocation fails before spawn with a typed `STATE_UNINITIALIZED` preflight
instead of a generic agent failure.

## Isolation

Each worker has fresh model context and an exact tool allowlist, but runs with the invoking
user's OS permissions. Receipt/approval secrets and memory-write/logstream configuration
are stripped. This is not filesystem/process isolation; use an external container or VM
for untrusted or unattended work.

## Limits and verification

- Maximum parallel tasks/concurrency: 25.
- Canonical output concatenates all final assistant `text` parts in order, with no inserted
  separator; reasoning/tool-call parts are excluded.

```bash
bun run --cwd .pi/extensions/subagent test:unit
bun run --cwd .pi/extensions/subagent test:integration
```
