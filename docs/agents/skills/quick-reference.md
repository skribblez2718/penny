# Skill Quick Reference — Artifact-first build checklist

## Design

- Prove the workflow manually.
- Name the failure each phase/order rule prevents.
- Draw the flow before coding.
- Place gates at reversibility cliffs and bound every loop.

## Build

1. Add and register a TypeScript `PlaybookCoreV1` implementation.
2. Write SKILL.md with `engine: orchestration` and normally `mempalace: false`.
3. Write one Domain Guidance prompt per worker/state.
4. Make every cognitive directive declare exact `input_artifacts` and an owner
   `output_artifact` contract.
5. Require workers to use `artifact_read` through `next_range`, return
   complete stage content, and keep routing fields separate from product bytes.
6. Add README, reference, and `resources/flow.html`.
7. Add playbook, artifact-handoff, memory-absent recovery, composition, and source-guard tests.
8. Run the structure checker. Do not register a live skill in
   `tiered_memory/skill_rooms.json`; that file is legacy-corpus classification.

## Validate

- [ ] Manifest and description comply.
- [ ] Playbook registry and flow diagram agree.
- [ ] Skill directory contains no executable delegate.
- [ ] Prompts contain exact handoff and no worker memory instruction.
- [ ] Owner capture/ref verification precedes SUMMARY routing.
- [ ] Payload bytes never enter RunContext.
- [ ] Retry, clarification, restart, and partial fan recovery preserve selected refs.
- [ ] Memory-unavailable paths complete unchanged.
- [ ] Terminal result exposes the selected exact product ref.
- [ ] Full engine suite and repository source guards pass.

## Common mistakes

- Reintroducing `state_machine: true` or argv state.
- Passing predecessor text inline instead of exact refs.
- Treating a SUMMARY or model-authored locator as persistence proof.
- Giving workers `memory_*` tools or room instructions.
- Requiring a room-manifest entry for a new skill.
- Silently truncating artifact content instead of following `next_range`.

## Files

| File                                       | Purpose              |
| ------------------------------------------ | -------------------- |
| `docs/agents/skills/design-methodology.md` | Design method        |
| `docs/agents/skills/skill-standard.md`     | Full standard        |
| `docs/agents/skills/testing.md`            | Tests                |
| `scripts/tools/scaffold-skill.py`          | Canonical scaffolder |
