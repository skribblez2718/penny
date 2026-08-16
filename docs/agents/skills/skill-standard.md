# Skill Standard — Artifact-first engine workflows

## Required architecture

1. **Manifest:** `.pi/skills/<name>/SKILL.md` with `name`, trigger-rich
   description, `metadata.penny.engine: orchestration`, optional
   `metadata.penny.mempalace`, and the worker roles.
2. **Playbook:** one registered `BasePlaybook` subclass in
   `apps/orchestration/src/orchestration/playbooks/<name>.py`.
3. **Delegate:** the skill's `scripts/orchestrate.py` contains only:

   ```python
   #!/usr/bin/env python3
   from orchestration.cli import main

   if __name__ == "__main__":
       raise SystemExit(main(default_playbook="<name>"))
   ```

4. **Domain Guidance:** one static prompt per worker/state under
   `assets/prompts/`. Prompts define Mission, Exact Artifact Handoff,
   domain-specific guidance, non-negotiables, complete stage output, and routing
   SUMMARY.
5. **Resources:** `README.md`, reference material, and a drift-tested
   `resources/flow.html`.
6. **Tests:** playbook, artifact handoff, recovery, contracts, and source guards.

A live skill does not require a memory room or an entry in
`scripts/system/tiered_memory/skill_rooms.json`. That file classifies historical
legacy corpus only.

## Exact artifact handoff

Every cognitive directive declares execution-owner `input_artifacts` and an
`output_artifact` contract. The playbook selects all exact predecessors needed by
the current consumer. The runner grants only those refs; the worker reads each
with `artifact_read` through complete typed continuation, then returns complete
stage content followed by any required routing SUMMARY.

The owner persists and verifies exact bytes before SUMMARY parsing. Selected refs
survive retry, clarification, restart, parallel partial recovery, and compaction.
Payload bytes never enter `RunContext`. Parallel branches are keyed by stable
`branch_id` and receive no sibling grants.

Workers and skill drivers have no durable-memory tools or instructions. The
unmarked primary runtime may use optional durable recall or curation outside the
workflow transport contract.

## Manifest example

```yaml
---
name: skill-name
description: "One sentence. Use when … Do not use when …"
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [echo, vera]
---
```

`mempalace` describes optional primary durable-memory integration, not handoff.
Artifact-first skills normally set it to `false`; omitting memory must not change
workflow correctness.

## Design and control-flow rules

- Prove the workflow manually; every state/order rule names the failure it prevents.
- Prefer the lowest-complexity shape and model-owned topology where appropriate.
- Keep heuristics as tagged, measured LOANs with ablation paths.
- Keep prompts goal/constraint/capability shaped, not reasoning scripts.
- Require captured evidence for objective verification.
- Bound loops, require strategy change on retry, and report exhaustion honestly.
- Place planned human gates at reversibility cliffs.
- Keep deterministic tool states idempotent because recovery may reissue them.

## Directory shape

```text
apps/orchestration/src/orchestration/playbooks/<name>.py
apps/orchestration/tests/test_<name>_playbook.py

.pi/skills/<name>/
├── SKILL.md
├── README.md
├── scripts/orchestrate.py
├── assets/prompts/*.md
└── resources/
    ├── reference.md
    └── flow.html
```

## Prompt contract

A worker prompt must:

- say that the task supplies `input_artifacts`;
- require `artifact_read` for every granted ref and complete continuation;
- forbid predecessor discovery through another channel;
- require complete stage content in the response;
- state that the owner captures output and the worker must not claim persistence;
- keep SUMMARY as routing data only;
- preserve role consequence boundaries and escalation fields.

It must not mention session-room read/write, duplicate prechecks, model-authored
memory drawer IDs, routine KG links, or claims that full output lives in memory.

## Verification

- [ ] Structure checker passes without a room-manifest requirement.
- [ ] Contract/prompt and source guards pass.
- [ ] Owner capture happens before routing for single and parallel stages.
- [ ] Memory-absent start/step/fan-in/retry/clarification/restart/terminal tests pass.
- [ ] `RunContext` stores refs, not payload bytes.
- [ ] Flow diagram and reference match the FSM.
- [ ] Full engine regression suite passes.

## Files

| File                                                 | Purpose            |
| ---------------------------------------------------- | ------------------ |
| `docs/agents/skills/design-methodology.md`           | Workflow design    |
| `docs/agents/skills/orchestration.md`                | Execution protocol |
| `docs/agents/skills/skill-md-format.md`              | Manifest format    |
| `docs/agents/skills/testing.md`                      | Test requirements  |
| `docs/agents/architecture/atomic-loop-components.md` | Loop doctrine      |
