# Research Skill

Structured Quick / Standard / Deep research: decompose a query, gather cited evidence, synthesize and critique a thematic report, validate citation grounding, and produce final report files.

## Architecture

`ResearchPlaybook` / `ResearchMachine` lives in `apps/orchestration/src/orchestration/playbooks/research.py`; `scripts/orchestrate.py` is the thin delegate to the shared engine.

- SQLite checkpoint state is keyed by `run_id`; there is no argv state blob or temporary state file.
- Exact agent output lives in the immutable artifact plane, not in run context.
- Every agent directive carries task-provided `input_artifacts` and an owner `output_artifact` contract.
- Agents read exact predecessors with `artifact_read`; their complete response is owner-captured before the routing-only SUMMARY is accepted.
- Recovery reissues the pending state from checkpointed exact refs.
- The entire workflow operates with no memory endpoint or memory extension.

## States

| State | Agent | Role |
|---|---|---|
| `intake` | — | Validate goal, resolve budgets, route explicit quick or planning. |
| `planning` | Piper | Decompose query; declare mode when caller did not. |
| `critiquing_plan` | Carren | Evidence-gated plan critique when `critique_passes >= 2`. |
| `researching` | Echo × N | Dynamic branch fan; single-agent explicit-quick; re-entered for evidence seeking. |
| `synthesizing` | Synthia | Synthesize exact branch artifacts into a cited report. |
| `critiquing_report` | Carren | Evidence-gated report critique when `critique_passes >= 1`. |
| `validating` | Vera | Citation-grounding gate in every mode. |
| `report_writing` | Skribble | Write and return complete report products. |
| `unknown` / `awaiting_clarification` | — | HITL staging and durable pause. |
| `complete` / `error` | — | Terminal states. |

## Mode flows

- **Quick:** `intake → researching → synthesizing → validating → report_writing → complete`
- **Standard:** `intake → planning → researching → synthesizing → validating → report_writing → complete`
- **Deep:** `intake → planning → critiquing_plan → researching → synthesizing → critiquing_report → validating → report_writing → complete`

Mode expands to a verification budget rather than directly gating edges. There is no per-mode sub-query count. `max_sub_queries` is one budget, clamped by `max_fan_width`; one Echo artifact is captured per branch and fan-in maps by exact `branch_id`.

## Exact handoff by phase

The generic engine retains selected refs; the playbook chooses all exact predecessors needed by each consumer:

- planning revision: prior plan + plan critique;
- initial research: plan and any plan critique;
- synthesis: all selected research branches plus relevant prior synthesis/critique/validation;
- report critique: research evidence + current synthesis;
- validation: all research evidence + current synthesis + report critique when present;
- report writing: all research evidence + current synthesis + validation.

Payload bytes never enter `RunContext`. A malformed SUMMARY retry creates an explicit artifact revision. Clarification and fresh-process recovery preserve the same selected refs.

## Loops and honest outcomes

Plan critique, report critique, and validation revision loops are bounded by `max_iterations`. Repeated identical issues escalate instead of consuming the remaining budget. On exhaustion the run proceeds with warnings and unresolved issues rather than inventing approval.

When Vera returns researchable `evidence_needed`, validation can route through a bounded additional Echo fan and Synthia re-synthesis. Branch numbering continues across rounds, so each selected branch has a distinct artifact identity. When no round remains, the workflow re-grounds from existing evidence and eventually exhausts honestly.

`met` records report delivery; `grounded` records Vera's final verdict. These are intentionally separate.

## Clarification and restart

Escalation is driven by `needs_clarification`, incomplete stage flags, `UNCERTAIN`, or a stalled loop. Resume uses the same run and returns to the producer that can act on the answer: planning, researching, or synthesizing. The next directive includes the clarification and exact checkpointed inputs.

`recover_pending` re-presents a clarification or reissues only pending work. Parallel partial recovery keeps accepted sibling refs and redispatches only missing branch IDs.

## Products

Skribble writes to `$PROJECT_ROOT/research/<slug>-<digest>`:

- `report.md`
- `sources.md`
- `README.md`

Skribble also returns the complete contents of all three in the final response. The execution owner captures those bytes as the `report_writing` `agent-output`; the terminal result exposes that exact checkpointed ref as `output_artifact_ref`. The files remain user-facing product files.

## Verification surfaces

- `apps/orchestration/tests/test_research_playbook.py` — control flow and non-memory enhancements.
- `apps/orchestration/tests/test_research_artifact_handoff.py` — exact handoff and memory-absent conformance.
- `apps/orchestration/tests/test_contract_prompt_drift.py` — SUMMARY and semantic-handoff source guards.
- `resources/reference.md` — state, transition, contract, artifact, and terminal reference.
- `resources/flow.html` — state diagram checked against the FSM.
