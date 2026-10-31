# Skill Standard — TypeScript artifact-first workflows

## Required architecture

1. **Manifest:** `.pi/skills/<name>/SKILL.md` conforming to
   [SKILL.md Format](skill-md-format.md), the owner of YAML, visibility, and license rules.
2. **Playbook:** one registered TypeScript `PlaybookCore` implementation under
   `apps/orchestration/src/playbooks/`.
3. **Contract:** closed `SkillContractV2`, validated before construction. Its fields are
   `schema_version`, `name`, `objective`, `io`, `behavior`, `guidance`, `budget_policy`,
   `repair_routing`, and `completion_gate`. I/O ports, side-effect/approval/stop/escalation
   consequences, and budget resolver/admission/snapshot bindings are consumed or equality-projected;
   declaration-only accepts/produces/invariants/budgets debt is forbidden.
4. **Domain Guidance:** one static `<agent>-<state>.md` prompt per cognitive state.
5. **Resources:** `README.md`, reference material, and a strict-JSON `resources/flow.html` that passes both descriptor drift tests and the shared structural/visual flow validator.
6. **Tests:** playbook, artifact handoff, receipts, gates, composition, recovery, and source guards.

Skill directories contain no executable delegate. The skill extension invokes the TypeScript
registry in-process. Each registration owns `ingress`, typed start admission, liveness/thinking,
worker identity, opening/guidance, phase schemas, optional fixed phase tool subsets, and model
policy. Tool selection follows the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule);
[profiles](../agents/tool-profiles.md) own the static YAML maximum. A guarded zero-tool phase is
permitted only under that rule's registration-bound model/payload/disclosure/opening conditions,
never from task or runtime selection. `ingress:skill` requires start admission; `knowledge-base`
remains `dedicated_tool` with separate host-private tools.

The seven ordinary generic-child peers—`assess`, `decide`, `define`, `diagnose`, `plan`, `produce`,
`research`—currently omit `allowed_tools` and use exact YAML. This is not a rule for every registered
skill: SCA cognition binds the real `["artifact_read"]` subset. Preserve both registration shapes.

## Registration, visibility, and composition

`PLAYBOOK_REGISTRY` is the sole executable registry; registration explicitly authorizes execution.
Model-invocable orchestration packages require a matching registration. Both visible and hidden
packages load through native Pi discovery; the manifest flag controls only model advertising.
Unregistered packages cannot execute regardless of visibility. Package location and model visibility
confer no execution authority; apply the [manifest rules](skill-md-format.md#rules).

Before run creation, generic composition re-reads every canonical input ref, resolves exactly one
compatible port by source/kind/schema/version, checks cardinality, and validates exact bytes for
semantic products. The initial semantic validator is `penny.grounded-synthesis.v1`.

## Exact artifact handoff

Every cognitive directive declares owner-selected exact `input_artifacts` IDs/refs and an
`output_artifact` contract. Apply [Invocation](../agents/invocation.md) for complete reads,
`missing_input:`, exact final-text concatenation, owner persistence/readback before SUMMARY,
and fan-in/capture failure behavior. Keep the worker-local clauses below self-contained.

Selected refs survive retry, clarification, restart, fan recovery, compaction, and composition.
The [engine](../orchestration/overview.md#persistence) owns checkpoints and admission;
payload bytes and semantic memory never enter `RunContext`.

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
- require `artifact_read` through `next_range` until every needed task-provided predecessor is complete;
- return `missing_input:` for a required absent ID/path, never discover predecessors through memory,
  temporary files, repository search, or another channel;
- require complete stage content;
- state that the owner captures output and the worker must not claim persistence;
- carry the exact typed routing contract;
- preserve role boundaries and the exact phase-permitted escalation fields; closed schemas,
  not generic advice, determine whether confidence/clarification keys are required, optional, or forbidden.

## Control-flow rules

- Justify orchestration and topology with requirements, dependencies, or observed evidence; a manual run is optional.
- Every state/order rule names the failure it prevents.
- Place any required human gate at the reversibility cliff; do not add one without a consequence-based reason.
- Split prepare from apply for consequential effects.
- Classify valid gaps with `EvaluationResult`; never let model/playbook output choose the repair target or exhaustion.
- Register unique state/kind repair routes with policy-led controls and honest exhaustion successors. Derive values from actual operator policy, not test constants or model guesses. Do not require finite step, call, phase-cycle, repair, or correction caps when operator policy supplies none.
- Require captured evidence for objective verification.
- Keep deterministic host operations idempotent.
- Export a flow descriptor and update it with the machine.
- Expose the selected exact terminal `output_artifact_ref`, honest warnings and unresolved issues;
  a rejected draft must not be labeled an accepted canonical product.

## Verification

[Testing](testing.md#required-coverage) owns the evidence matrix for these requirements. Distinguish
shared-runtime evidence from skill-specific routes, prompts, contracts, flow drift, and package
behavior. Cover applicable direct/default YAML equality, real registered subsets (including SCA),
the guarded zero-tool exception, invalid/dynamic refusal, and separate host-private matrices.
Do not claim OS/process or extension-code isolation from a tool subset. Execute the applicable
engine/extension suites for implementation changes; report unrun checks and qualification limits.
