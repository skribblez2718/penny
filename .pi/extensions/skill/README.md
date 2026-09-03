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

- **Single:** one production or explicitly enabled candidate `ingress:skill` registration.
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
multi-source fan-in. Schema-v2 chain checkpoints retain exact terminal/handoff refs plus every step's release status and
canonical `sha256(canonicalJson(SkillContractV2))` across restart. Schema-v1 checkpoints remain
readable for production registrations only. A generic failure stops with exact refs and
`resumable:true`; it does not manufacture an approve-retry/skip/diagnose questionnaire. Genuine
playbook clarification still surfaces the registration's `await_user` questions.

## Catalog visibility and entrypoints

Pi's native `<available_skills>` system section is the sole model-facing catalog of skill names, YAML descriptions, and locations. The `skill` tool describes orchestration mechanics without repeating those catalog rows. At prompt assembly, this extension replaces Pi's generic read-to-load sentence with a directive to invoke each matching skill's registered entrypoint and reserve `read` for documentation inspection.

The generic engine workflow entrypoint is `skill`; registrations own their ingress, closed start
admission, liveness/thinking, worker opening/guidance, phase schemas, and model policy. The
knowledge-base profile remains `dedicated_tool` and deliberately exposes its separate typed
`knowledge_base` entrypoint. The extension registers both tools, and unit coverage rejects registration drift.

## Production and candidate resolution

`$PROJECT_ROOT/.pi/skills/<name>/` is the only active package root. The extension discovers that root
once, parses `metadata.penny.release_status`, and requires exact package↔registry agreement.
`PLAYBOOK_REGISTRY` is production-only; `CANDIDATE_PLAYBOOK_REGISTRY` is candidate-only. Directory
location grants no lifecycle state. Release status and model visibility are independent: every valid
package is model-visible in Pi native discovery and Penny's listing exactly when its parsed
`disable-model-invocation` flag is not `true`. `.pi/skills/.ignore` must contain exactly the package
directories with an explicit parsed `true`; it remains a safe comment-only file when none are hidden.
The Assess, Decide, Diagnose, Plan, and Produce candidate manifests are model-visible.

Visibility grants no execution authority. User-facing candidate execution additionally requires the ignored static
`$PROJECT_ROOT/.pi/candidate-enablement.json` to bind the exact name and contract SHA-256. Missing
configuration enables nothing; malformed configuration does not disable production Research; runtime
never creates the file. Candidates remain exact-digest host-gated and outside
`PLAYBOOK_REGISTRY`. There is no token, grant, TTL, promotion, package move, or second source root.

Typed refusals are `SKILL_NOT_REGISTERED`, `SKILL_ENTRYPOINT_MISMATCH`, `CANDIDATE_DISABLED`,
`CANDIDATE_CONFIG_INVALID`, `CANDIDATE_CONTRACT_STALE`, and `CANDIDATE_PACKAGE_INVALID`.

## Paired evaluation

Benchmark inputs, guidance, packages, journals, and results are local data. The repository ignores
`$PROJECT_ROOT/evals/`; keep those files there or in another caller-selected location. The normal
publication tests do not require local benchmark data. With a local corpus present, run
`bun run evals:test` for the benchmark-dependent test suites.

The generic evaluator freezes exact population, plan, direct baseline, candidate, ablation, runtime,
thinking, rate, budget, schedule, complete deterministic grading definition, and optional mutation
bindings. It recomputes `grader_registry_sha256` from the definition's closed common-wire,
registration-keyed semantic-normalizer, and deterministic grader/oracle descriptors. Executable
normalizer and grader maps are separate from canonical JSON and must have exact key parity with those
descriptors. Each scheduled registration's normalizer source must match exactly one active output
port. Variant-specific bytes are normalized to one common grading wire before a deterministic grader
sees them; the shared grader does not detect baseline or candidate prose shapes. The frozen grading
digest binds every descriptor/oracle and stable registration-keyed executable implementation revision.

A generic direct-agent baseline factory accepts the registration name, agent, phase, guidance
root/resolution, typed output port, and optional liveness policy. Freeze verifies that the resulting
playbook directive, worker phase, guidance, producer, active output port, and closed baseline
definition agree. `DIRECT_DEMETRI_BASELINE_REGISTRATION` remains the synthetic compatibility
instance; a direct Piper `StrategyDraft` baseline can be constructed without editing evaluator
internals.

The default CLI remains provider-free. A caller-private local-live driver may opt in only with both an
explicit execution flag and `PENNY_EVALUATION_LOCAL_LIVE=1`. Its dedicated evaluator state root is
bound into the process before any Pi client/session resource is created, and a conflicting existing
process selector fails closed without being overwritten. Before workers start, the evaluator persists a
small schedule-bound sentinel and re-reads it through the actual model-visible `artifact_read` runtime
from the same project ID, artifact root, and manifest. No cross-root scan or fallback exists. The helper
also requires the exact zero-rate loopback model preflight.

### Remote C6 calibration

`evaluation-remote-calibration-cli.ts` is the narrow remote-provider path for caller-supplied Decide
and Plan C6 packages. It accepts separate fleet-aware authorization manifests, separate approval
receipts, and a caller-owned verifier module. Preflight uses a credential-empty, network-disabled Pi
model catalog, verifies current agent SSOT provider/model-alias/thinking bindings, exact configured
model IDs/origins/rate cards, package components, registrations, semantic contracts, budgets, roots,
and owner proof, and performs no provider call or durable evaluation write. Live execution additionally
requires both the CLI `--execute-live` flag and the two environment gates below. It executes Decide to
qualified completion before starting Plan, uses distinct manifest-authorized state/evidence roots,
materializes only package-bound calibration inputs, and persists only non-scoring calibration journals
and results. Unknown provider completion is never reinvoked automatically.

Provider-free preflight command:

```bash
cd "$PROJECT_ROOT/.pi/extensions/skill"
bun run evals:remote-calibration -- \
  --project-root "$PROJECT_ROOT" \
  --decide-package "$DECIDE_PACKAGE" \
  --decide-manifest "$DECIDE_AUTHORIZATION_MANIFEST" \
  --decide-approval "$DECIDE_APPROVAL_RECEIPT" \
  --decide-confirm-package-sha256 "$DECIDE_PACKAGE_SHA256" \
  --decide-confirm-max-spend-microusd "$DECIDE_MAX_SPEND_MICROUSD" \
  --plan-package "$PLAN_PACKAGE" \
  --plan-manifest "$PLAN_AUTHORIZATION_MANIFEST" \
  --plan-approval "$PLAN_APPROVAL_RECEIPT" \
  --plan-confirm-package-sha256 "$PLAN_PACKAGE_SHA256" \
  --plan-confirm-max-spend-microusd "$PLAN_MAX_SPEND_MICROUSD" \
  --owner-verifier-module "$OWNER_VERIFIER_MODULE" \
  --preflight-only
```

Separately gated live command (same arguments, with the final mode changed):

```bash
cd "$PROJECT_ROOT/.pi/extensions/skill"
PENNY_EVALUATION_LOCAL_LIVE=1 PENNY_EVALUATION_REMOTE_LIVE=1 \
bun run evals:remote-calibration -- \
  --project-root "$PROJECT_ROOT" \
  --decide-package "$DECIDE_PACKAGE" \
  --decide-manifest "$DECIDE_AUTHORIZATION_MANIFEST" \
  --decide-approval "$DECIDE_APPROVAL_RECEIPT" \
  --decide-confirm-package-sha256 "$DECIDE_PACKAGE_SHA256" \
  --decide-confirm-max-spend-microusd "$DECIDE_MAX_SPEND_MICROUSD" \
  --plan-package "$PLAN_PACKAGE" \
  --plan-manifest "$PLAN_AUTHORIZATION_MANIFEST" \
  --plan-approval "$PLAN_APPROVAL_RECEIPT" \
  --plan-confirm-package-sha256 "$PLAN_PACKAGE_SHA256" \
  --plan-confirm-max-spend-microusd "$PLAN_MAX_SPEND_MICROUSD" \
  --owner-verifier-module "$OWNER_VERIFIER_MODULE" \
  --execute-live
```

Both commands emit canonical JSON containing the exact package, schedule, authorization, approval,
and runtime-binding digests. The executable runtime identity required in every execution-fleet entry
and judge binding is `penny-pi-agent-client-v1`. These commands do not mint an approval or inspect
credential material; provider authentication remains runtime-owned.

Bounded concurrency is 1–4. Optional immutable trial-observation journals make explicit terminals
resumable without changing their bytes or re-running them. Unknown host/process exceptions abort with
the affected journal absent; execution accounting separates new starts, new terminals, retained
journals, outstanding entries, and loopback calls. Deterministic mutation evidence
uses the same generic executor and registered candidate/ablation terminal path as ordinary trials;
host-product mutations use the actual completion and composition protections. Product-only mutations
are not applicable to a draft-only ablation and do not enter that ablation's applicable denominator or
escape count, while the full-product cohort stays frozen. Model output rejected explicitly by
its registered normalizer remains `MALFORMED_TRIAL_OUTPUT` and receives the frozen failure rule.
Registration, artifact-read preflight, normalizer implementation, or grader/parser incompatibility
produces `INVALID_EVALUATION`; it is non-dispositive for candidate quality and never falls through to
`NO_BUILD` or `RETIRED`. Evaluation results remain measurement-only and cannot enable, admit,
promote, move, or production-register a candidate.

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
- Ordinary Assess, Decide, Diagnose, Plan, and Produce candidate phases omit `allowed_tools`, so
  runtime activates each assigned catalog agent's exact YAML list. Their normal liveness policy caps
  external calls at 8 per worker and 64 per run; routing-only repair remains at 0. Evaluation-only
  direct baselines or ablations may still use the generic fixed strict-subset mechanism.
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

`PENNY_ARTIFACT_DISPATCH_MODE` accepts `active|paused`. A pause is retriable and preserves
the pending checkpoint. A fresh recovery under `active` reissues the exact selected refs
and output contract. Unknown mode values fail closed.

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
