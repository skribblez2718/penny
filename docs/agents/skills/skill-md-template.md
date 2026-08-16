# SKILL.md Template — Artifact-first workflow

```markdown
---
name: [skill-name]
description: "[One sentence]. Use when [triggers]. Do not use when [anti-cases]."
license: MIT
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
`output_artifact` contract. Workers read every granted reference with
`artifact_read`, follow continuation until `truncated` is false, return complete
stage content, and append only the active state's routing `SUMMARY`. The owner
persists and verifies exact bytes before routing.

Durable memory is optional, primary-owned, and never workflow handoff or run state.

## Output

[Describe user-facing files, terminal fields, `output_artifact_ref`, warnings,
and unresolved issues.]

## Clarification and Recovery

[Describe producer-oriented resume using the same run and selected refs.]
```

## Constraints

- Replace every bracketed placeholder.
- Keep `engine: orchestration` and remove the legacy state-machine key.
- Do not add a room-manifest requirement.
- Do not add worker memory tools/instructions, session rooms, duplicate
  prechecks, routine KG links, or a claim that full output lives in memory.
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
