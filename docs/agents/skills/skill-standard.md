# Skill Standard — TypeScript artifact-first workflows

## Required architecture

1. **Manifest:** `.pi/skills/<name>/SKILL.md` with trigger-rich description and
   `metadata.penny.engine: orchestration`.
2. **Playbook:** one registered TypeScript `PlaybookCoreV1` implementation under
   `apps/orchestration/src/playbooks/`.
3. **Contract:** closed `SkillContractV1`, validated before construction.
4. **Domain Guidance:** one static `<agent>-<state>.md` prompt per cognitive state.
5. **Resources:** `README.md`, reference material, and drift-tested `resources/flow.html`.
6. **Tests:** playbook, artifact handoff, receipts, gates, composition, recovery, and source guards.

Skill directories contain no executable delegate. The skill extension invokes the TypeScript
registry in-process.

## Exact artifact handoff

Every cognitive directive declares owner-selected exact `input_artifacts` IDs/refs and an
`output_artifact` contract. Workers read needed IDs through `next_range`, return complete
stage output, and keep routing fields separate from product bytes. The owner persists and
re-reads exact bytes before parsing routing or advancing.

Selected refs survive retries, clarification, restart, fan recovery, compaction, and skill
composition. Payload bytes and semantic memory never enter `RunContext`.

## Directory shape

```text
apps/orchestration/src/playbooks/<name>.ts
apps/orchestration/tests/<name>-playbook.test.ts

.pi/skills/<name>/
├── SKILL.md
├── README.md
├── assets/prompts/<agent>-<state>.md
└── resources/
    ├── reference.md
    └── flow.html
```

## Prompt contract

A worker prompt must:

- identify the state-specific mission and consequence boundary;
- require `artifact_read` for every granted predecessor;
- prohibit predecessor discovery through another channel;
- require complete stage content;
- state that the owner captures output and the worker must not claim persistence;
- carry the exact typed routing contract;
- preserve role boundaries and clarification fields.

## Control-flow rules

- Prove the workflow manually before encoding it.
- Every state/order rule names the failure it prevents.
- Place human gates at reversibility cliffs.
- Split prepare from apply for consequential effects.
- Bound repairs; strategy-free repetition escalates or exhausts honestly.
- Require captured evidence for objective verification.
- Keep deterministic host operations idempotent.
- Export a flow descriptor and update it with the machine.

## Verification

- [ ] Registry and contract reject unknown/malformed skills.
- [ ] Prompt directory exactly matches cognitive states.
- [ ] Owner capture and receipt validation precede routing.
- [ ] `RunContext` stores refs, not payloads.
- [ ] Single, parallel, chain, resume, clarification, and cancellation paths are covered.
- [ ] Memory-absent execution remains correct.
- [ ] Flow descriptor and HTML agree.
- [ ] Full TypeScript engine and extension suites pass.
