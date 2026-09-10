# Skill Invocation Extension

Drives durable TypeScript playbooks through `@penny/orchestration`.

## Architecture

```text
Penny → skill tool → TypeScript OrchestrationService
  → closed start/recover/respond request
  → Pi SDK worker(s) with exact input refs
  → TypeScript ArtifactStore persists complete output
  → signed owner receipt and routing result
  → checkpointed transition
  → terminal, clarification, or dispatch-pause boundary
```

No Python process, per-skill executable delegate, or legacy checkpoint conversion exists.

## Modes

- **Single:** one registered `ingress:skill` workflow.
- **Parallel:** independent TypeScript runs with bounded concurrency.
- **Chain:** sequential TypeScript runs with exact terminal-artifact handoff.
- **Resume:** reloads the durable owner-only chain checkpoint and resumes the failed step.

## Progress rendering

The shared `OrchestrationRunner` emits content-free phase-start, worker-completion/failure, and
boundary events projected from directives and admitted worker results. The extension converts every
event into a structured Pi partial result, so new registered playbooks inherit progress without
playbook-specific UI code. Single runs show the current state and agent, parallel mode shows one
bounded aggregate across active skills, and chain/resume mode includes the current step. The renderer
also preserves text-only partial updates rather than replacing them with `No result`.

For chain handoff, the owner verifies and forwards the prior terminal artifact ID directly;
cross-run reads require no target-run copy. `{previous}` becomes a bounded instruction
identifying that ID, never payload text. Additional explicit IDs may be supplied for
multi-source fan-in. Schema-v3 chain checkpoints retain exact terminal/handoff refs plus every step's canonical
`sha256(canonicalJson(SkillContractV2))` across restart. Legacy checkpoints without an immutable
contract digest fail closed on resume. A generic failure stops with exact refs and `resumable:true`;
it does not manufacture an approve-retry/skip/diagnose questionnaire. Genuine playbook clarification
still surfaces the registration's `await_user` questions.

## Catalog visibility and entrypoints

Pi's native `<available_skills>` system section is the sole model-facing catalog of skill names, YAML descriptions, and locations. The `skill` tool describes orchestration mechanics without repeating those catalog rows. At prompt assembly, this extension replaces Pi's generic read-to-load sentence with a directive to invoke each matching skill's registered entrypoint and reserve `read` for documentation inspection.

The generic engine workflow entrypoint is `skill`; registrations own their ingress, closed start
admission, liveness/thinking, worker opening/guidance, phase schemas, and model policy. The
knowledge-base profile remains `dedicated_tool` and deliberately exposes its separate typed
`knowledge_base` entrypoint. The extension registers both tools, and unit coverage rejects registration drift.

## Registered skill resolution

`$PROJECT_ROOT/.pi/skills/<name>/` is the only active package root. The extension discovers that root
once and validates model-invocable orchestration packages against the sole `PLAYBOOK_REGISTRY`.
Directory location does not grant execution authority. Every valid package is model-visible in Pi
native discovery and Penny's listing exactly when its parsed `disable-model-invocation` flag is not
`true`. `.pi/skills/.ignore` must contain exactly the package directories with an explicit parsed
`true`; it remains a safe comment-only file when none are hidden.

A model-disabled development package such as the SCA scaffold remains discoverable for documentation
and static checks while it lacks a playbook registration. Generic invocation refuses it safely until
that registration exists. Typed refusals are `SKILL_NOT_REGISTERED`, `SKILL_ENTRYPOINT_MISMATCH`, and
`SKILL_PACKAGE_INVALID`.

## Model policy

Production worker models come from `.pi/agents/<agent>.md` frontmatter. `model` is an
optional per-invocation override applied to every worker in that run, primarily for tests.
It does not mutate production frontmatter. A step-level chain/parallel override is scoped
to that step.

## Artifact communication and tool authority

- Inputs are unique exact artifact IDs/refs from any run. Before `RunContext` creation, generic
  composition re-reads each manifest ref, resolves exactly one compatible source/kind/schema/version
  port, enforces cardinality, and runs registered semantic exact-byte validators.
- Exact finalized output bytes are persisted and immediately re-read before routing fields
  are parsed or a successful result is returned.
- Receipts bind run, state, branch, agent, attempt, trust posture, invocation digest,
  output digest, and canonical artifact ref.
- Run context stores selected refs, not payload bytes. Memory is never workflow transport.
- Agent YAML `tools:` is the maximum ordinary catalog authority. Direct/parallel/chain paths
  and orchestration phases without `allowed_tools` activate it exactly. An eligible TypeScript
  phase may use one explicit non-empty duplicate-free strict YAML subset held by the active
  `PlaybookRegistrationV1`; the canonical runtime-registration digest and worker invocation
  metadata bind that exact list. Empty, duplicate, equality-sized, or non-YAML declarations
  fail before session creation; Pi receives the accepted list exactly, and active removal,
  addition, or replacement fails equality before the model prompt. Task, trust profile, input, runtime condition,
  model/liveness policy, and optional-service state cannot select tools.
- Ordinary Assess, Decide, Diagnose, Plan, and Produce phases omit `allowed_tools`, so runtime
  activates each assigned catalog agent's exact YAML list. Their normal liveness policy caps external
  calls at 8 per worker and 64 per run; routing-only repair remains at 0. The generic fixed
  strict-subset mechanism remains covered by synthetic registration tests.
- A phase subset does not mutate agent YAML/profiles and is not OS/process sandboxing or
  extension-code isolation. Every provider extension still loads before session creation.
  Optional-service absence behind a selected registered tool is a typed call error, not
  conditional omission.
- Standard catalog workers return complete assistant output plus their closed `SUMMARY`
  line. Owner code parses routing only from persisted bytes; no injected
  `submit_orchestration_result` tool exists.
- KB's host-tool-matrix session is explicitly anonymous and does not load or claim a
  catalog role. It remains separate from both exact-YAML and registered strict-subset catalog
  sessions.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE` is parsed once by the TypeScript execution owner. Unset and
exact `active` permit dispatch; only exact `paused` pauses it. Blank, padded, case-varied,
and unknown values are invalid and fail closed as paused. While paused or invalid, the
engine does not dispatch workers, tools, child workflows, or parallel branches; `status`
and `cancel` remain available.

Current-engine pause results carry versioned facts for the exact run, session, state,
dispatch setting, observed checkpoint existence, and resumability. Recovery is intentionally
three-way: activate then recover only a current-storage-validated resumable checkpoint;
activate then retry a start that has no resumable checkpoint (whether or not an admission row
exists); or use status/cancel for a saved-but-ineligible checkpoint. Historical pause records
are compatibility-only: their immutable `checkpoint_preserved` value remains an explicitly
unverified legacy claim, never current checkpoint existence or resumability, and the renderer
provides status/cancel guidance only. `LEGACY_UNMETERED` remains a typed ineligibility reason
because adding liveness authority retroactively is forbidden.

The TypeScript database is the current opaque project partition's unversioned
`orchestration/orchestration.db` below `${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}`.
Existing runs remain owner-sticky by `run_id`; retired Python checkpoints are archived
outside the runtime and are never a fallback. Chain checkpoints use the same project
partition and include its opaque project ID.

## KB host-grant authority

Profile-session and parent-delivery grants share one owner-only WAL/FULL database in the current
opaque project's catalog-bound `kb/host-grants` partition. There is no project-local, JSON, or
secondary-directory fallback. Unexpected legacy fragments block the authority rather than being
scanned or adopted.

`penny-kb-gate profile-grant-mint|list|revoke|expire` manages reusable, expiring exact
session/profile grants. Each adapter call consumes an immutable use bound to Pi's exact tool-call
ID, action, request digest, and observed policy digest. Parent delivery additionally uses
`parent-grant-mint|list|revoke|expire`; mint requires the exact invocation ID, provider, model, and
query request, and the resulting grant remains exact single-use by one delivered run.

## Parameters

| Parameter            | Scope       | Description                                          |
| -------------------- | ----------- | ---------------------------------------------------- |
| `skill_name`, `goal` | single      | Registered skill and objective                       |
| `session_id`         | single      | Optional stable run identity                         |
| `constraints`        | all         | Bounded skill-specific constraints                   |
| `input_artifacts`    | single/step | Unique exact IDs from any run; verified before start |
| `model`              | single/step | Test/caller worker-model override                    |
| `skills`             | parallel    | Up to three independent skill steps                  |
| `chain`              | chain       | Up to ten sequential steps                           |
| `resume_chain`       | resume      | Durable chain checkpoint ID                          |
| `step_overrides`     | resume      | Goal/constraint changes for the failed step only     |

## Testing

```bash
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/skill test:integration
bun run --cwd .pi/extensions/skill test:e2e
bun run --cwd apps/orchestration test
```

The unit suite proves every skill mode is TypeScript-only, forwards structured progress in single,
parallel, chain, and resume modes, and never falls back to a Python child. Shared-runner tests verify
phase/worker/boundary events independently of the UI. Integration tests verify discovery through
`SKILL.md` plus the TypeScript playbook registry.
