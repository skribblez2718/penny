# SKILL.md Template — Artifact-first workflow

```markdown
---
name: [skill-name]
description: "[One sentence]. Use when [triggers]. Do not use when [anti-cases]."
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents:
      - [agent]
---

## When to Use

- [Condition]

## When Not to Use

- [Anti-condition]

## Invocation

`skill({ skill_name: "[skill-name]", goal: "[goal]" })`

## Exact Artifact Handoff

Every cognitive directive declares execution-owner `input_artifacts` and an
`output_artifact` contract. Workers read needed exact IDs with `artifact_read`, repeat
with `next_range` until `truncated` is false, return complete stage content, and append
only the active state's routing `SUMMARY`. The owner persists and re-reads exact bytes
before parsing routing.

If a required ID/path is absent, return `missing_input:`; never discover predecessors through
memory, temporary files, repository search, or another channel. Workers do not claim persistence.
Durable memory is optional advisory recall, never workflow handoff or run state; writes remain
primary-owned and memory absence cannot change correctness.

## Output

[Describe user-facing files, terminal fields, `output_artifact_ref`, warnings,
and unresolved issues.]

## Clarification and Recovery

[Describe producer-oriented resume using the same run and selected refs.]
```

## Constraints

- Replace every bracketed placeholder.
- Apply [SKILL.md Format](skill-md-format.md) for description bounds, YAML keys, visibility,
  and license rules. The visible-package template intentionally omits the disable flag.
- Do not add a room-manifest requirement.
- Do not add worker memory tools in a skill manifest. Bounded read-only recall is
  declared only by agent YAML; never add memory-write/logstream, session-room, or
  memory-handoff instructions, duplicate prechecks, routine KG links, or a claim
  that full output lives in memory.
- Keep complete stage output distinct from routing SUMMARY data.

## Verification

- [ ] Frontmatter parses.
- [ ] Trigger and anti-trigger clauses exist.
- [ ] Exact artifact handoff and continuation are explicit.
- [ ] Terminal output identifies exact product refs and honest limitations.

## Files

| File                                    | Purpose              |
| --------------------------------------- | -------------------- |
| `docs/agents/skills/skill-md-format.md` | Format specification |
| `docs/agents/skills/skill-standard.md`  | Full standard        |
