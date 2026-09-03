# Skill Standard — TypeScript artifact-first workflows

## Required architecture

1. **Manifest:** `.pi/skills/<name>/SKILL.md` with trigger-rich description and
   `metadata.penny.engine: orchestration`.
2. **Playbook:** one registered TypeScript `PlaybookCoreV1` implementation under
   `apps/orchestration/src/playbooks/`.
3. **Contract:** closed `SkillContractV2`, validated before construction. Its fields are
   `schema_version`, `name`, `release_status`, `objective`, `io`, `behavior`, `guidance`,
   `budget_policy`, `repair_routing`, and `completion_gate`. `release_status` is exactly
   `production|candidate` and must equal the registry namespace. I/O ports, side-effect/approval/stop/escalation
   consequences, and budget resolver/admission/snapshot bindings are consumed or equality-projected;
   declaration-only accepts/produces/invariants/budgets debt is forbidden.
4. **Domain Guidance:** one static `<agent>-<state>.md` prompt per cognitive state.
5. **Resources:** `README.md`, reference material, and a strict-JSON `resources/flow.html` that passes both descriptor drift tests and the shared structural/visual flow validator.
6. **Tests:** playbook, artifact handoff, receipts, gates, composition, recovery, and source guards.

Skill directories contain no executable delegate. The skill extension invokes the TypeScript
registry in-process. Each registration owns `ingress`, typed start admission, liveness/thinking,
worker identity, opening/guidance, phase schemas, optional fixed phase tool subsets, and model
policy. A subset is permitted only as one explicit non-empty duplicate-free strict YAML subset
included in the canonical runtime-registration digest and worker invocation metadata; omission
preserves YAML equality. `ingress:skill` requires start admission; `knowledge-base` remains
`dedicated_tool` with separate host-private tools.

## Release namespaces and composition

`.pi/skills/<name>/` is the only active package root for production and candidate lifecycles.
Packages are discovered once and classified from parsed `metadata.penny.release_status`; directory
location grants no status. Production registrations live only in `PLAYBOOK_REGISTRY` and
source-defined candidates live only in `CANDIDATE_PLAYBOOK_REGISTRY`. Release status and model
visibility are independent. A valid package is model-visible in Pi native discovery and Penny's
listing if and only if its parsed top-level `disable-model-invocation` flag is not `true`.
`.pi/skills/.ignore` contains exactly the package directory names whose parsed flag is explicitly
`true`; a comment-only file is required when no package is disabled.

Model-visible candidates gain no execution authority. User-facing candidate execution requires an
exact static name/contract-digest binding in the ignored
`$PROJECT_ROOT/.pi/candidate-enablement.json`. Missing configuration enables nothing and the runtime
never creates it. Evaluation-only resolution is a third exact-digest path; none of these paths
promotes or moves a package. Candidates remain outside `PLAYBOOK_REGISTRY`, and production/candidate
registry/package mismatch fails closed.

Before run creation, generic composition re-reads every canonical input ref, resolves exactly one
compatible port by source/kind/schema/version, checks cardinality, and validates exact bytes for
semantic products. The initial semantic validator is `penny.grounded-synthesis.v1`.

## Exact artifact handoff

Every cognitive directive declares owner-selected exact `input_artifacts` IDs/refs and an
`output_artifact` contract. Workers read each needed task-provided exact ID with `artifact_read`
and continue bounded reads through `next_range`, then return complete
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
- require `artifact_read` for every needed task-provided predecessor ID;
- prohibit predecessor discovery through memory, temporary files, repository search, or another channel;
- require complete stage content;
- state that the owner captures output and the worker must not claim persistence;
- carry the exact typed routing contract;
- preserve role boundaries and clarification fields.

## Control-flow rules

- Prove the workflow manually before encoding it.
- Every state/order rule names the failure it prevents.
- Place human gates at reversibility cliffs.
- Split prepare from apply for consequential effects.
- Classify valid gaps with `EvaluationResultV2`; never let model/playbook output choose the repair target or exhaustion.
- Register unique state/kind repair routes with finite budgets and honest exhaustion successors.
- Require captured evidence for objective verification.
- Keep deterministic host operations idempotent.
- Export a flow descriptor and update it with the machine.

## Verification

- [ ] Registry rejects unknown/malformed skills, worker phase mismatches, duplicate/unreachable routes, and invalid targets.
- [ ] Required registration guidance reaches workers; direct paths and subset-absent
      catalog phases have exact YAML equality.
- [ ] Any phase subset is strict/non-empty/unique, canonical-registration/digest-bound,
      projected unchanged into invocation metadata, validated before session creation, and
      passed exactly to Pi; invalid or dynamically selected surfaces fail closed.
- [ ] Ordinary candidate phases omit `allowed_tools` and use exact YAML; synthetic or
      evaluation-only strict subsets remain separately tested without OS/process sandboxing or
      extension-code-isolation claims, and host-private tools remain separate.
- [ ] Prompt directory exactly matches cognitive states.
- [ ] Owner capture and receipt validation precede routing.
- [ ] `RunContext` stores refs, not payloads.
- [ ] Single, parallel, chain, resume, clarification, and cancellation paths are covered.
- [ ] Memory-absent execution remains correct.
- [ ] Flow descriptor and HTML agree.
- [ ] Full TypeScript engine and extension suites pass.
