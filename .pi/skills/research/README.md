# Research Skill

Structured Quick / Standard / Deep research: decompose a query, gather cited evidence,
synthesize and critique a thematic report, validate citation grounding, and produce final
report files.

## Architecture

`ResearchPlaybook` lives in `apps/orchestration/src/playbooks/research.ts` and is
constructed through the TypeScript playbook registry. The skill directory contains no
executable delegate.

- Node SQLite checkpoint state is keyed by `run_id`.
- Exact agent output lives in the immutable artifact plane, never in run context.
- Every worker receives exact `input_artifacts` and an owner `output_artifact` contract.
- Agents read predecessors with `artifact_read`; complete response bytes are persisted
  before routing fields are accepted.
- Recovery reissues the pending TypeScript directive from checkpointed refs.
- Single, parallel, chain, and chain-resume invocations all use TypeScript.
- The workflow remains correct without durable memory.

## States

| State | Agent | Role |
|---|---|---|
| `planning` | Piper | Decompose the query; declare mode when the caller did not. |
| `critiquing_plan` | Carren | Evidence-gated plan critique when `critique_passes >= 2`. |
| `researching` | Echo × N | Bounded dynamic research fan; single-agent explicit quick. |
| `synthesizing` | Synthia | Integrate exact findings into a cited report. |
| `critiquing_report` | Carren | Evidence-gated report critique when `critique_passes >= 1`. |
| `validating` | Vera | Citation-grounding gate in every mode. |
| `report_writing` | Skribble | Write and return the complete report products. |

## Mode flows

- **Quick:** `researching → synthesizing → validating → report_writing → complete`
- **Standard:** `planning → researching → synthesizing → validating → report_writing → complete`
- **Deep:** `planning → critiquing_plan → researching → synthesizing → critiquing_report → validating → report_writing → complete`

Mode expands to verification budgets rather than hardcoded topology. `max_sub_queries`
is clamped by `max_fan_width`; the model chooses how much of the ceiling to spend.

## Exact handoff and composition

The playbook selects the exact predecessor refs each state needs. Payload bytes never
enter `RunContext`; retries, clarification, recovery, and fan-in retain selected refs.
A malformed routing result creates an explicit output revision rather than advancing.

When research is a later skill-chain step, the owner copies exact predecessor bytes into
an immutable target-run `chain_input` artifact. Only the actual research entry states may
consume it. No `{previous}` payload substitution occurs.

## Honest outcomes

Critique and validation repairs are bounded. Exhaustion records warnings and unresolved
issues rather than inventing approval. Vera may name `evidence_needed`, which drives a
bounded Echo research round followed by re-synthesis and re-validation.

`met` records report delivery; `grounded` records Vera’s final verdict. Surface both.

## Products

Skribble writes beneath `$PROJECT_ROOT/research/<slug>-<digest>`:

- `report.md`
- `sources.md`
- `README.md`

The owner-captured `report_writing` artifact is returned as `output_artifact_ref`; the
files remain user-facing products.

## Verification surfaces

- `apps/orchestration/tests/research-parity.test.ts`
- `apps/orchestration/tests/research-parity-pin.test.ts`
- `apps/orchestration/tests/core-runtime.test.ts`
- `apps/orchestration/tests/initial-artifacts.test.ts`
- `apps/orchestration/tests/prompt-guidance-contract.test.ts`
- `resources/reference.md`
- `resources/flow.html`
