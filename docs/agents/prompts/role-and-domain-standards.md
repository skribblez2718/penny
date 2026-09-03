# Role Definition and Domain Guidance Standards

## Separation

| Layer           | Source              | Purpose                                           |
| --------------- | ------------------- | ------------------------------------------------- |
| Role Definition | `.pi/agents/*.md`   | Domain-invariant capability and YAML tool maximum |
| Domain Guidance | skill prompt assets | Static task-family criteria and SUMMARY contract  |

## Role Definition

Required order: YAML frontmatter, Purpose, Working Discipline, Non-Negotiables, Output,
canonical `<agent_boundary>`.

Every role declares complete capability metadata plus `authority`, `tool_profiles`, and a
required non-empty duplicate-free `tools:` maximum. Profiles statically expand to it.
Direct/parallel/chain invocation and orchestration phases without a subset activate it
exactly. Only an active TypeScript orchestration phase registration may bind one canonical-
digest-bound strict subset; Domain Guidance, task text, and trust/runtime state cannot
select it or mutate the role metadata.

Working Discipline includes:

```markdown
- **Exact-input discipline**: when `input_artifacts` are supplied, read every needed ID
  with `artifact_read` and repeat with `next_range` until complete. Do not discover
  predecessor output through another channel. If a required ID/path is absent, return
  `missing_input:`.
- **Role honesty rule**: role-specific evidence contract.
- **Confidence is a wire format**: CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN.
```

Role definitions return complete work. They do not claim persistence, direct workers to
memory transport, or prescribe domain-specific methodology.

## Domain Guidance

Required sections:

1. Mission.
2. Exact Artifact Handoff—IDs/paths, `artifact_read`, `next_range`, no substitute search.
3. Domain criteria and evidence constraints.
4. Non-negotiables.
5. Complete Output—owner automatically captures exact bytes.
6. SUMMARY—one exact closed JSON line at the end, routing-only.

Static prompts contain no dynamic template values, reserved boundary tags, memory room
protocol, model-authored persistence fields, or injected result-tool instructions.

## Exact semantics

IDs are ordinary internal communication addresses and may cross runs/sessions. Owner code
preflights exact existence/integrity before spawn. Reads do not expire. Missing/corrupt IDs
fail explicitly; memory, `/tmp`, repository search, and name matching are not fallbacks.

## Context and recovery

Checkpoints retain selected refs. Retry, clarification, restart, fan recovery, and
compaction reuse those exact IDs. Compaction preserves only code-proven current-session
refs and may collapse them into one handoff-index artifact.

## Verification

- [ ] YAML tools equal profiles and are exact on direct/parallel/chain and subset-absent
      orchestration paths.
- [ ] Any orchestration strict subset is active-registration/digest-bound, present in worker
      metadata, validated before session creation, and never prompt/task/trust/runtime-selected.
- [ ] Domain prompts require IDs/ranges, complete output, and final SUMMARY.
- [ ] Owner persistence/re-read precedes parsing SUMMARY.
- [ ] No grant/consumer/expiry or memory-handoff language remains.
