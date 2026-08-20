# Research Reference

The research skill is a TypeScript `PlaybookCoreV1` implementation in
`apps/orchestration/src/playbooks/research.ts`. `OrchestrationService` combines it with
the Node SQLite checkpointer, immutable artifact store, signed receipt authority, Pi SDK
workers, and observability. No executable exists in the skill directory.

## Contract

`RESEARCH_SKILL_CONTRACT` is validated before the playbook is constructed. It declares:

- objective, accepted and produced artifact kinds;
- authority and trust profiles;
- phase-specific guidance under `assets/prompts/<agent>-<state>.md`;
- supported feedback kinds and declarative budgets;
- terminal completion requirements.

A shared bidirectional prompt guard compares the complete prompt directory with the
state/agent machine. Missing, orphaned, or misnamed prompts fail.

## State and agent map

| State | Agent | Required routing fields |
|---|---|---|
| `planning` | piper | `plan_steps`, `plan_complete`; optional `mode` |
| `critiquing_plan` | carren | `verdict`, `issues`, non-empty `evidence` |
| `researching` | echo | `explore_complete` |
| `synthesizing` | synthia | `synthesis_complete` |
| `critiquing_report` | carren | `verdict`, `issues`, non-empty `evidence` |
| `validating` | vera | `verdict`, `unsupported_claims`, non-empty `evidence`; optional `evidence_needed` |
| `report_writing` | skribble | `write_complete` |

All phases may report confidence and clarification fields. Invalid or missing routing
fields fail closed; exact output bytes remain persisted as an explicit revision.

## Mode and budget policy

Only an explicit caller `mode: quick` skips planning. Otherwise Piper declares the mode
when the caller leaves it unset. The labels expand to budgets:

| Mode | `critique_passes` | `max_research_rounds` |
|---|---:|---:|
| quick | 0 | 2 |
| standard | 0 | 2 |
| deep | 2 | 3 |

`max_sub_queries` defaults to 4 and is clamped by `max_fan_width` (default 8).
`max_iterations` bounds critique and validation repairs. These are ceilings, not targets.

## Routing

- Explicit quick enters `researching`; other runs enter `planning`.
- Plan critique runs when `critique_passes >= 2`.
- Report critique runs when `critique_passes >= 1`.
- Every run passes through Vera before report writing.
- A Vera failure with researchable `evidence_needed` may re-enter `researching` while
  both iteration and research-round budgets remain.
- Other verification failures re-enter `synthesizing`.
- Exhausted repairs proceed honestly to report writing with unresolved issues recorded.

Clarification pauses at an `await_user` directive. Resume returns to the producer able
to use the answer: planning/plan critique → planning; research → researching; synthesis,
report critique, or validation → synthesizing.

## Exact artifact handoff

The owner persists every worker response before routing. `RunContext.selected_artifacts`
contains refs only. Each directive carries a closed `InputArtifactsV1` grant and output
metadata bound to run, state, branch, producer, operation, version, and consumer scope.

| Consumer | Selected predecessors |
|---|---|
| planning revision | prior plan and plan critique |
| researching | plan/plan critique, or synthesis/validation for evidence seeking |
| synthesizing | selected research branches plus relevant synthesis, critique, and validation revisions |
| report critique | current synthesis and research evidence |
| validating | current synthesis, research branches, and report critique when present |
| report writing | synthesis, evidence, critique when present, and validation |

A later skill-chain step receives a target-run `chain_input` artifact containing the exact
prior terminal bytes. Its consumer scope admits only `planning`, `researching`, and the
owner start seam. The first accepted phase output carries that input into normal same-run
lineage.

## Worker posture and models

Tool authority comes from `.pi/agents/<agent>.md` frontmatter. Hardened workers lose
execution/mutation tools; worker memory is absent unless the owner supplies the bounded
read-only extension.

Production models also come from agent SSOT. A caller may provide a per-invocation model
override (used for test runs) without changing frontmatter. Vera-specific precedence is:
`constraints.validate_model` → verifier environment override → invocation/default model.

## Recovery and terminal truth

The TypeScript v2 database defaults to `$PROJECT_ROOT/.penny/orchestration-v2.db`.
Recovery uses an exact `run_id`; it never scans semantic memory or converts retired
checkpoints. Compaction reads this same v2 database by exact run ID.

Terminal fields:

| Field | Meaning |
|---|---|
| `met` | report delivery completed |
| `grounded` | final citation gate passed |
| `output_artifact_ref` | selected exact `report_writing` product |
| `warnings`, `unresolved_issues`, exhausted flags | honest residual state |

The user-facing files are `report.md`, `sources.md`, and `README.md` under the absolute
report directory. Their complete contents also exist in the owner-captured terminal
artifact.

## Drift enforcement

- `research-parity-pin.test.ts` pins state vocabulary, state/agent binding, budgets, and products.
- `research-parity.test.ts` pins quick/standard/deep traces, recovery, receipts, and terminal truth.
- `prompt-guidance-contract.test.ts` pins the complete phase-prompt surface.
- `flow-diagrams.test.ts` pins machine-readable diagrams.
