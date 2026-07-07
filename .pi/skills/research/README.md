# Research Skill

Structured research workflow with Quick / Standard / Deep modes: decompose a
query, gather cited evidence, synthesize a thematic report, and write it to
disk.

## Architecture

The research skill is a `BasePlaybook` subclass on the shared orchestration
engine — `ResearchPlaybook` / `ResearchMachine` in
`apps/orchestration/src/orchestration/playbooks/research.py`. `scripts/orchestrate.py`
is a ~5-line delegate to `orchestration.cli`; it holds no FSM logic.

- **State** lives in a durable SQLite checkpointer keyed by `run_id`. There is
  no `/tmp` session file, no `--state` argv, and no
  `extract_state`/`restore_state`.
- **Agents** run in fresh context and communicate via mempalace. Only the
  structured SUMMARY of each step returns to the engine — Penny never sees full
  agent output.
- **Escalation and gates are engine seams.** Progress checks force a single HITL
  escalation; bounded critique loops handle revision.

One machine serves all three modes. The mode is detected at intake
(`detect_mode`) or forced by `constraints.mode`, and selects which edges fire.

## States

| State | Agent | Role |
|-------|-------|------|
| `intake` | — | Detect mode, validate goal, seed `max_sub_queries` |
| `planning` | piper | Decompose query into sub-queries (standard/deep) |
| `critiquing_plan` | carren | Critique the plan (deep only) |
| `researching` | echo | Single agent researches ALL sub-queries |
| `synthesizing` | synthia | Synthesize findings into one report |
| `critiquing_report` | carren | Critique the report (deep only) |
| `report_writing` | skribble | Write report.md, sources.md, README.md |
| `unknown` / `awaiting_clarification` | — | HITL escalation staging / pause |
| `complete` / `error` | — | Terminal states |

Note: `researching` is a single echo agent instructed to research every
sub-query (not a per-sub-query fan-out). Vera is not invoked — the legacy
`validating` state was removed before the port.

## Mode flow

- **Quick:** `intake → researching (echo) → synthesizing (synthia) →
  report_writing (skribble) → complete`. Planning is skipped.
- **Standard:** `intake → planning (piper) → researching → synthesizing →
  report_writing → complete`.
- **Deep:** `intake → planning → critiquing_plan (carren) → researching →
  synthesizing → critiquing_report (carren) → report_writing → complete`, with
  two bounded critique loops.

`max_sub_queries` defaults to 1 (quick) / 3 (standard) / 4 (deep) and is
enforced at dispatch.

## Loops

Both deep-mode critique loops are bounded by `ctx.max_iterations`:

- **Plan critique:** `critiquing_plan → planning → critiquing_plan` while the
  verdict is not APPROVE and budget remains. On exhaustion the run proceeds to
  `researching` with a recorded warning and the unresolved issues surfaced —
  never a forced approval.
- **Report critique:** `critiquing_report → synthesizing → critiquing_report`
  under the same rule; on exhaustion it proceeds to `report_writing`.

A critique that keeps raising the same issues across revisions is treated as
stalled and escalates to the user instead of burning the remaining budget.

## Escalation

Escalation is the engine's single HITL seam, driven by `progress_check`:
`needs_clarification` from any agent, `plan_complete` / `explore_complete` /
`synthesis_complete` returning false, or a stalled critique. The state moves
`to_unknown → escalate → awaiting_clarification`. Resume is a `step` with the
same `run_id` and a `--result` carrying the user's answer; the engine folds the
clarification into the next task and resumes at `planning`. `report_writing`
does not escalate.

## Mempalace

**Room:** `skills/research-{session_id}`

| Drawer | Written By | Content |
|--------|-----------|---------|
| `{sid} Planner` | piper | Sub-queries, scope, rationale |
| `{sid}-echo-{n} Research Findings` | echo | Findings for sub-query N |
| `{sid} Synthesis` | synthia | Synthesized report |
| `{sid} Critique` | carren | Plan / report critique verdicts |
| `{sid} Report Files` | skribble | Written report files |

## Output

`report_writing` writes to the absolute path
`~/projects/penny/research/<sanitized-topic>` (expanded), producing `report.md`,
`sources.md`, and `README.md`. The run completes honestly: if the write fails,
`done_predicate` returns false and the result reports `met: false` rather than
fabricating success.

## Credibility Framework

Embedded in Echo's domain guidance (`assets/prompts/echo.md`):

- **Source Tiers:** T1 Primary/Authoritative (docs, RFCs, arXiv) · T2
  Expert/Established · T3 Community/Practitioner · T4 Unverified/Commercial.
- **Confidence Markers:** High · Medium · Low · Conflicting.

## Reference

- `resources/reference.md` — full state/transition/gate tables.
- `resources/flow.mmd` — the FSM as a Mermaid state diagram (edge-for-edge with
  the playbook).
- `resources/research-frontier-evaluation.md` — the deep-research design
  rationale.
