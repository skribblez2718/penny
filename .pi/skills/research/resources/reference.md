# Research Reference

The research skill is a `BasePlaybook` subclass (`ResearchPlaybook` /
`ResearchMachine`) on the shared orchestration engine
(`apps/orchestration/src/orchestration/playbooks/research.py`). State lives in
the durable SQLite checkpointer keyed by `run_id`; there is no `/tmp` state, no
`--state` argv, and no `extract_state`/`restore_state`. `scripts/orchestrate.py`
is a thin delegate to `orchestration.cli`.

One machine serves all three modes (quick / standard / deep). The mode is
detected at intake (`detect_mode`) or forced by `constraints.mode` and selects
which edges fire.

## States

| State | Agent | Description |
|-------|-------|-------------|
| `intake` | — | Initial. Detect mode, validate non-empty goal, seed `max_sub_queries`. |
| `planning` | piper | Decompose the query into sub-queries (standard/deep; quick skips it). |
| `critiquing_plan` | carren | Critique the plan (deep only): coverage, redundancy, feasibility. |
| `researching` | echo | Single agent researches ALL sub-queries; writes tiered, cited findings. |
| `synthesizing` | synthia | Synthesize findings into one thematic, cited report. |
| `critiquing_report` | carren | Critique the report (deep only): overclaiming, bias, fairness, uncertainty. |
| `report_writing` | skribble | Write report.md, sources.md, README.md to the output dir. |
| `unknown` | — | Progress-gate escalation staged. |
| `awaiting_clarification` | — | Paused for user clarification; resumes at `planning`. |
| `complete` | — | Final. `done_predicate` = report was written. |
| `error` | — | Final. Terminal failure (abort). |

## Transitions

| Event | From | To | Guard |
|-------|------|-----|-------|
| `start_plan` | intake | planning | standard or deep |
| `start_research` | intake | researching | quick |
| `plan_to_critique` | planning | critiquing_plan | deep |
| `plan_to_research` | planning | researching | quick or standard (also deep after a clarify resume) |
| `plan_critique_pass` | critiquing_plan | researching | verdict == APPROVE |
| `plan_critique_revise` | critiquing_plan | planning | verdict != APPROVE and `iter+1 < max_iterations` |
| `plan_critique_exhausted` | critiquing_plan | researching | budget spent; warning recorded, issues surfaced |
| `research_done` | researching | synthesizing | — |
| `synth_to_critique` | synthesizing | critiquing_report | deep |
| `synth_to_report` | synthesizing | report_writing | quick or standard |
| `report_critique_pass` | critiquing_report | report_writing | verdict == APPROVE |
| `report_critique_revise` | critiquing_report | synthesizing | verdict != APPROVE and `iter+1 < max_iterations` |
| `report_critique_exhausted` | critiquing_report | report_writing | budget spent; warning recorded, issues surfaced |
| `report_done` | report_writing | complete | — |
| `to_unknown` | planning \| critiquing_plan \| researching \| synthesizing \| critiquing_report | unknown | progress gate returned a reason |
| `escalate` | unknown | awaiting_clarification | — |
| `clarify` | awaiting_clarification | planning | user_response carried into the task |
| `abort` | any non-final state | error | fatal error |

## Loops

Both critique loops are bounded by `ctx.max_iterations`:

- **Plan critique** (deep): `critiquing_plan → planning → critiquing_plan`
  while `verdict != APPROVE` and budget remains. On exhaustion,
  `plan_critique_exhausted` proceeds to `researching` with a recorded warning
  and the unresolved issues surfaced in the result.
- **Report critique** (deep): `critiquing_report → synthesizing →
  critiquing_report` under the same rule. On exhaustion,
  `report_critique_exhausted` proceeds to `report_writing`.

Loop counters are reset between the two loops (`_end_plan_loop` /
`_end_report_loop`) so plan-loop history cannot contaminate report-loop stall
detection.

## Escalation gate (`progress_check`)

Escalation is the engine's single HITL seam. `progress_check` forces
`to_unknown → escalate → awaiting_clarification` when:

- any agent SUMMARY sets `needs_clarification: true` (questions surfaced);
- `planning` returns `plan_complete: false`;
- `researching` returns `explore_complete: false`;
- `synthesizing` returns `synthesis_complete: false`;
- a critique (`critiquing_plan` / `critiquing_report`) is non-APPROVE AND the
  same issues have persisted across revisions (`is_stalled`) — escalate rather
  than burn the remaining budget.

`ESCALATABLE_STATES` = `planning, critiquing_plan, researching, synthesizing,
critiquing_report`. `report_writing` does not escalate.

## Resume

Escalation resume is a `step` with the same `session_id` + `run_id` and a
`--result` carrying the user's answer. The engine sets `clarification_text`,
fires `clarify` (→ `planning`), and folds the clarification into the next task.
There is no `orchestrator_state` to thread back.

## Mempalace

**Room:** `skills/research-{session_id}`

| Drawer | Written By | Content |
|--------|-----------|---------|
| `{sid} Planner` | piper | Sub-queries, scope, rationale |
| `{sid}-echo-{n} Research Findings` | echo | Findings for sub-query N (one drawer per sub-query) |
| `{sid} Synthesis` | synthia | Synthesized report |
| `{sid} Critique` | carren | Plan / report critique verdicts |
| `{sid} Report Files` | skribble | Written report files |

## Output

`report_writing` writes to the absolute path
`~/projects/penny/research/<sanitized-topic>` (expanded), producing `report.md`,
`sources.md`, and `README.md`. The result payload reports `met`, `mode`,
`sub_queries`, `report_dir`, `report_files`, `warnings`, and any
`unresolved_issues` from an exhausted critique loop.
