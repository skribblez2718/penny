# SKILL.md Format — Manifest for artifact-first workflows

## Frontmatter

```yaml
---
name: skill-name
description: "One sentence. Use when [triggers]. Do not use when [anti-cases]."
metadata:
  penny:
    engine: orchestration
    release_status: production
    mempalace: false
    subagents: [echo, vera]
---
```

## Rules

1. `name` matches the directory and uses lowercase kebab-case.
2. `description` contains a role sentence, `Use when`, and an anti-use clause. It has a 1,024-character hard limit and an approximately 500-character preferred target; justified longer text remains valid.
3. `metadata.penny.engine` is `orchestration`; the removed `state_machine` key is forbidden.
4. Every package remains under `.pi/skills/<name>/` and declares
   `metadata.penny.release_status: production|candidate`; location never determines lifecycle status.
   Release status is independent of model visibility. A valid package is model-visible if and only if
   its optional top-level `disable-model-invocation` flag is not `true`. `.pi/skills/.ignore` lists
   exactly packages whose parsed flag is explicitly `true` and remains comment-only when none are
   disabled.
5. `metadata.penny.mempalace` is optional. It describes optional **primary
   durable-memory** integration only. It does not authorize worker memory tools
   or workflow rooms.
6. `metadata.penny.subagents` lists project-local catalog roles with matching
   Domain Guidance files.
7. Body sections include When to Use, When Not to Use, Invocation, Exact Artifact
   Handoff, Output, recovery/escalation as applicable, and terminal truth.

## Content boundaries

| SKILL.md                           | Domain Guidance                              | README/reference                                |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Routing triggers and parameters    | Mission and domain criteria                  | Detailed FSM, contracts, failure modes          |
| Artifact-first invocation contract | Exact input read + complete output + SUMMARY | Selected refs and recovery behavior             |
| Terminal result shape              | Role-specific output fields                  | Diagnostics and tests                           |
| Optional primary memory flag       | No memory instructions                       | Durable-memory boundary explanation if relevant |

SKILL.md is Project Index content, not the worker prompt. It must not instruct
workers to use session rooms, duplicate checks, diaries, or KG links.

## Exact handoff statement

State that cognitive stages receive owner-selected exact `input_artifacts` IDs/refs,
read needed IDs with `artifact_read` through `next_range`, and return complete
stage content for owner capture before routing. State that memory availability
cannot affect workflow correctness.

## Canonical wire terms

| Term                   | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `input_artifacts`      | Unique exact cross-run predecessor slots/IDs selected by the owner. |
| `output_artifact`      | Owner contract for the current stage's exact response bytes.        |
| `output_artifact_ref`  | Canonical selected product ref exposed by the terminal result.      |
| `SUMMARY`              | Minimal model-authored routing payload, never persistence proof.    |
| `needs_clarification`  | Worker requests owner-mediated user input.                          |
| `clarifying_questions` | Questions preserved by the run checkpoint.                          |
| `confidence`           | CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN wire vocabulary.          |

## Verification

- [ ] YAML parses, the engine marker is present, and the routing description meets its shape and budget.
- [ ] No legacy state-machine key.
- [ ] Artifact handoff and terminal product ref are documented.
- [ ] Memory is optional/primary-only and not workflow transport.
- [ ] All listed worker roles have prompts.

## Files

| File                                      | Purpose       |
| ----------------------------------------- | ------------- |
| `docs/agents/skills/skill-standard.md`    | Full standard |
| `docs/agents/skills/skill-md-template.md` | Template      |
