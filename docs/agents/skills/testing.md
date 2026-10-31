# Skill Testing — TypeScript playbook requirements

## What

Test each registered playbook against temporary Node SQLite checkpoints and immutable
artifact roots. Assert directives, state transitions, gates, receipts, exact refs, recovery, and
terminal truth without invoking production models.

## Rules

Use an isolated temporary checkpointer and artifact root. Drive closed engine requests with
fixture `ModelClient` implementations or pre-built signed `PhaseResult` values; mock cognition,
not transitions, custody, or admission. Assert directive, state, exact input selection, and output
metadata. The [required coverage matrix](#required-coverage) below owns evidence obligations;
[Skill Standard](skill-standard.md) owns architecture requirements and
[SKILL.md Format](skill-md-format.md) owns manifest YAML.

For tools, apply the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule).
The guarded zero-tool exception needs its exact registration-bound model, inline payload/disclosure,
zero active tools, and final serialized-opening authorization—not just an empty list. Profiles own
static YAML maxima; host-private matrices are separate. No tool subset proves OS/process sandboxing
or extension-code isolation.

Keep live-model tests separate, explicitly authorized, and selected through caller overrides rather
than production agent frontmatter changes. Run applicable checks for the changed surface, not every
suite merely because a test exists. Record exact commands/results, shared evidence reused, and
unrun gaps; provider-free fixtures do not establish live-model completion reliability.

## Commands

```bash
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd apps/orchestration test:parity
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/skill test:integration
bun run --cwd .pi/extensions/compaction test:unit
```

## Provider-free conformance enrollment

`apps/orchestration/tests/fixtures/provider-free-skill-conformance.v1.json` is the canonical
profile manifest. Every executable registration needs exactly one profile, including a
model-hidden registration such as videogen. Bind each required category to a unique real
`test_file`/`full_name` assertion, with both deterministic-contract and real-path tiers.
Do not infer execution from a file's existence or replace missing evidence with a pass callback.

`apps/orchestration/scripts/provider-free-skill-conformance.mjs`, invoked by
`bun run --cwd apps/orchestration test:skill-conformance`, validates the profile set, executes
the bound files under an isolated environment and Node network-deny guard, and requires every
named assertion in the emitted Vitest evidence. It executes the entire bound file, not just
the named assertion; local HTTP fixtures therefore belong outside these profiles too.
The videogen profile uses closed worker/prompt contracts, deterministic script variations,
real-engine G1/refinement/recovery, missing-provider refusal and consumed raw-PCM owner custody.
It does not enroll opt-in native/CPU cohorts, run a live provider, or prove playback,
whole-skill production completion or semantic quality.

## Loop-protection evidence

`apps/orchestration/tests/loop-shared.test.ts` owns shared source-SUMMARY preservation and
exact recurrence fixtures. Cover all details/confidence, unpreservable sources, attempted
judgment changes, single/parallel correction, branch scoping, A/B/A across restart, atomic
receipt/fingerprint rollback, missing capabilities, invalid/null fingerprints, cancellation
and unchanged unopted behavior. These fixtures do not establish each skill's measurement.

The seven ordinary playbook suites must independently cover `UNVERIFIABLE` negative replay
without author repair or positive admission, actual pre-review native checks and their
failure paths, and each declared fingerprint boundary. In particular, pin Assess/Diagnose's
`null` analysis/evidence routes and permanent measurement withdrawal after upstream prose
changes; Decide/Plan's content-based upstream comparison despite new refs and exact single
mechanical-evidence line on recovery without rewriting the frozen task; and Produce's
stronger review-core binding and existing checks artifact. Test valid domain-incomplete
products separately from verification incapacity.

Report source-mapped fixture results as source evidence, not shipping-package execution.
Compiled checks require a fresh matching build/process; neither source nor compiled fixtures
establish live-model loop qualification. Registration-digest mismatch and cancelled-terminal
replay must not silently upgrade or restart a run. Listed tests are coverage targets, not
claims that they ran.

## Current child-workflow evidence boundary

The [engine feature-status table](../orchestration/overview.md#child-workflow-feature-status)
owns availability. Keep these evidence scopes distinct; listed assertions are not an execution receipt:

| Source suite                                                 | Evidence boundary                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/orchestration/tests/child-workflows-storage.test.ts`   | Exact V1/V2 codec and custody, atomic reservation/rollback, adopt-or-conflict, corrupt/artifact-only refusal, fresh-process readback, lifecycle CAS without consumption, store retention, exact v11→v12 V1-byte migration and current/unknown schema handling. Current control schema is v13; v12→v13 adds the host journal, not synthetic calls. |
| `apps/orchestration/tests/child-workflows-authority.test.ts` | Exact all-seven runtime projection, native request/output and fixed phase tool/network carriers, YAML snapshot drift refusal, digest sensitivity, default-deny unknown/absence, knowledge-base exclusion, worker refusal and Gate 2 `not_run`; no provider call.                                                                                  |
| `apps/orchestration/tests/child-workflows-runtime.test.ts`   | Real child engine/runner dispatch, exact terminal capture/one consumption, parent continuation without parent success, project admission, silence expiry, runner/durable-parent cancellation; version-2 projected waits, mediated reply identity/version/digest refusal, parent/child reply crash windows and waiting-child cancellation.         |
| `apps/orchestration/tests/child-workflows-imagegen.test.ts`  | Separate opt-in native asset reuse, serial/revision lineage, frozen provider/current G1/rights checks, captured-terminal reopen adoption, cancellation between prepare/consume, quarantined-host holds, and eventual linked control/session eviction. Immutable artifact preservation is not garbage collection or live qualification.            |

Storage-only evidence does not establish the active runtime rows; active or provider-free evidence
does not promote/discover a provider or supply Gate 2 evidence. Waiting/captured recovery preserves
frozen registration and operands; arbitrary linkage reconstruction remains forbidden.

`apps/orchestration/smoke/child-workflow-model-smoke.test.ts` is a separate, opt-in local-model
smoke. `PENNY_CHILD_WORKFLOW_MODEL_SMOKE=1` runs one disposable active parent/child fixture and
pins every child worker session to the Ollama model selected by
`PENNY_CHILD_WORKFLOW_MODEL_SMOKE_MODEL` (default `qwen3.8:latest`); it asserts dispatch, exact
resolved model identity, terminal-core acceptance, one consumption event, and an incomplete parent
that does not claim success. The smoke is fail-closed and does not promote a provider, grant
discovery, or by itself constitute Gate 2 qualification evidence.

## Required coverage

Shared-runtime checks can be reused when their bindings still cover the change. Each skill must
supply evidence for its own schemas, state/agent map, topology, prompts, budgets, and declared
consequences; a shared pass does not establish a new route or product's behavior.

| Surface                             | Required evidence and negative cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Ownership / scope                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Registration and contracts          | Closed skill/start/request/phase schemas; exact state vocabulary and state/agent/prompt sets; unknown/malformed skills, duplicate/unreachable routes, invalid targets and extra/missing SUMMARY keys refuse before work. Preserve literal completion/confidence and phase-specific escalation.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Shared validation plus each skill's bindings.                                                                             |
| Tool selection                      | Direct/parallel/chain and subset-absent catalog phases activate exact YAML. Pin absent `allowed_tools` for the seven ordinary peers: assess, decide, define, diagnose, plan, produce, research. Pin real SCA cognitive phases to `["artifact_read"]`; retain synthetic strict-subset coverage. Subsets exist only in the active `PlaybookRegistration`, change the canonical runtime-registration digest, reach invocation metadata unchanged, validate before session creation and reach Pi exactly; reject unguarded-empty, duplicate, additive, replacement, equality-sized, unavailable, non-YAML or task/trust/runtime-selected surfaces and active drift. Cover the guarded zero-tool exception and separate anonymous host-private matrices. | [Binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule); profiles lint maxima, not phase selection. |
| Execution and terminals             | Every happy edge, review order, declared gate approve/refine/deny, unplanned clarification, negative terminal and exhaustion route. Positive admission uses exact origin/visits/latest product/receipt predicates/unresolved policy; refusal is durable `incomplete/met:false` with artifacts retained. Negative terminals remain reachable; terminal `output_artifact_ref`, warnings and unresolved issues match the selected product and actual outcome.                                                                                                                                                                                                                                                                                          | Shared admission plus skill-specific topology/evidence.                                                                   |
| Repair and failure                  | Present and absent operator limits for semantic repair and reserved attempts, strategy delta, measured stall behavior where declared; malformed P1.2 correction stays separate. No fixture constant becomes production policy. Re-enter evidence/review after changed products; no stale approval. Diagnostics survive recovery, with current feedback reports distinct from partial products.                                                                                                                                                                                                                                                                                                                                                      | Registered routes/budgets and [Resilience](resilience.md).                                                                |
| Artifact transport                  | Complete exact output persistence/readback and signed receipt validation before SUMMARY routing; persistence/readback failure cannot succeed. Exact revisions and wrong-run/state/branch/producer/consumer or stale/corrupt refs refuse where the contract requires identity; admitted cross-run terminal IDs and fan-in remain valid. Missing input returns `missing_input:`; multi-range reads complete.                                                                                                                                                                                                                                                                                                                                          | [Invocation](../agents/invocation.md) transport/capture plus phase contracts.                                             |
| Continuity and composition          | Single/parallel/chain/chain-resume, clarification, cancellation, dispatch pause, restart/compaction, concurrency limits and branch-ID partial fan recovery retain selected refs and accepted siblings. `RunContext` has refs, not payloads. Memory-absent execution is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared runtime plus changed skill-specific paths.                                                                         |
| Typed imports                       | Before run/model creation reject stale refs, wrong source/kind/version/schema, ambiguous/missing ports, missing validators, envelopes-for-cores and corrupt bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Composition and each declared port.                                                                                       |
| Package and guidance                | Discover both visibility classes from the unified root through normal Pi loading; native/Penny model listings match the parsed flag under [manifest rules](skill-md-format.md#rules). Exercise literal `/skill:<name>` expansion and normal parent tool dispatch for visible and hidden packages. Unregistered packages refuse generic execution regardless of visibility. Reject forbidden manifest fields; required guidance reaches every phase. Cover package surface/clean pack and source guards.                                                                                                                                                                                                                                             | Discovery, registration and package-specific evidence.                                                                    |
| Flow                                | Descriptor and `resources/flow.html` agree exactly; structural, visual, accessibility-oriented and network-denial checks at required viewports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [Flow Diagrams](flow-diagrams.md), not an authoring-order mandate.                                                        |
| Child storage/runtime/qualification | Exercise the separate suite boundaries above: concrete project-bound store, exact-byte custody before mutation, atomic reservation, fresh-process adoption/rollback/conflict, schema migration/refusal and retention; independently test dispatch/capture/consumption, gate/reply/restart, cancellation/selection fences and cohort holds/cleanup. Active contracts omit predicted per-child allocations and aggregate/reserve fields. Gate 2 stays `not_run`.                                                                                                                                                                                                                                                                                      | Storage-only ≠ active-runtime ≠ live/provider qualification.                                                              |
| Ordinary product sealing            | Initial/final rejection, draft-addressed version-1 product/diagnostic adoption after interrupted writes, wrong-run epoch anchor, reviewer-repair reseal and fresh review order. `seal_diagnostics` identifies draft/final diagnostic separately from `repair_diagnostics` and best partial refs. Seal-correction policies cover both actual operator limits and unspecified allowances, without inventing one-/two-correction defaults.                                                                                                                                                                                                                                                                                                             | Skill-specific sealing plus shared diagnostics/recovery.                                                                  |
| Define / Plan assurance             | Host manifest/source-coverage fidelity, protected-content refusal before run/model creation; FrameV2 question/challenge/response and target-specific allowed-use support/locators, blocked/ready and product-bound trace/reviews. Plan/Define-revise V2 strict vs semantic-only and V1 compatibility across single/parallel/chain/resume/child-native; strict refusal before consumer creation never downgrades.                                                                                                                                                                                                                                                                                                                                    | Domain contracts; provider-free tests do not establish live completion reliability.                                       |
