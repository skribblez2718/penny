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

One machine serves all three modes. The mode is **caller- or model-declared**
(`constraints.mode`, else piper declares it in its plan SUMMARY — the keyword
`detect_mode` router was deleted), and selects which edges fire. Only an explicit
caller `quick` skips planning.

## States

| State | Agent | Role |
|-------|-------|------|
| `intake` | — | Validate goal, expand the mode into a rigor budget, seed `max_sub_queries`, route (caller-quick → researching, else planning) |
| `planning` | piper | Decompose query into sub-queries (standard/deep) |
| `critiquing_plan` | carren | Critique the plan (`critique_passes >= 2`) |
| `researching` | echo × N | Dynamic fan: one read-only branch per sub-query (single-agent on the quick fast-path) |
| `synthesizing` | synthia | Synthesize findings into one report |
| `critiquing_report` | carren | Critique the report (`critique_passes >= 1`) |
| `validating` | vera | Independent citation-grounding gate (all modes) |
| `report_writing` | skribble | Write report.md, sources.md, README.md |
| `unknown` / `awaiting_clarification` | — | HITL escalation staging / pause |
| `complete` / `error` | — | Terminal states |

Note: `researching` is a **dynamic fan** — `route_after('planning')` emits one
read-only echo branch per sub-query into `ctx.extras['dynamic_branches']`
(bounded by `max_fan_width`); the explicit-quick fast-path stays single-agent.
Critique and validation are **evidence-gated** (Rec 4): a verdict without captured
evidence is rejected. `validating` (vera) is an independent,
evidence-based citation-grounding gate that runs in every mode before the report
is written — it verifies each material claim in the synthesis is supported by a
cited source (distinct from carren's subjective critique). A FAIL loops back to
`synthesizing` to re-ground (bounded; honest exhaustion still ships; a stall
escalates).

## Mode flow

- **Quick:** `intake → researching (echo) → synthesizing (synthia) →
  validating (vera) → report_writing (skribble) → complete`. Planning is skipped.
- **Standard:** `intake → planning (piper) → researching → synthesizing →
  validating (vera) → report_writing → complete`.
- **Deep:** `intake → planning → critiquing_plan (carren) → researching →
  synthesizing → critiquing_report (carren) → validating (vera) → report_writing
  → complete`, with two bounded critique loops plus the validation gate.

There is **no per-mode sub-query table**. `max_sub_queries` is ONE budget
(default 4, tier-scaled via `PI_MODEL_TIER`, clamped to `max_fan_width`) that the
model spends within, enforced at dispatch — code caps, the model spends. An
over-budget plan is truncated with a recorded warning.

## Loops

Both deep-mode critique loops are bounded by `ctx.max_iterations`:

- **Plan critique:** `critiquing_plan → planning → critiquing_plan` while the
  verdict is not APPROVE and budget remains. On exhaustion the run proceeds to
  `researching` with a recorded warning and the unresolved issues surfaced —
  never a forced approval.
- **Report critique:** `critiquing_report → synthesizing → critiquing_report`
  under the same rule; on exhaustion it proceeds to `validating`.
- **Validation:** `validating → synthesizing → validating` while vera's verdict
  is not PASS and budget remains; on exhaustion it proceeds to `report_writing`
  with the unverified claims surfaced in the result — never shipped as verified.

A critique or validation pass that keeps raising the same issues across revisions
is treated as stalled and escalates to the user instead of burning the remaining
budget.

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
`$PROJECT_ROOT/research/<sanitized-topic>`, producing `report.md`,
`sources.md`, and `README.md`. The run completes honestly: if the write fails,
`done_predicate` returns false and the result reports `met: false` rather than
fabricating success.

## Credibility

Echo's domain guidance (`assets/prompts/echo.md`) states the standard
*relationally* rather than as a fixed taxonomy: every claim is cited, and each
source is ranked **primary > reputable secondary > weak** with uncertainty
flagged as uncertainty. There is deliberately no hard-coded tier enum — source
credibility is contextual (a vendor's own docs are the primary source for their
product; an unreviewed preprint is not authoritative merely for being on arXiv),
so the judgement belongs to the model reading the source, with the citation
gate (vera) as the check.

Confidence rides the engine's canonical taxonomy —
`CERTAIN | PROBABLE | POSSIBLE | UNCERTAIN` (`orchestration/contracts.py`) —
where `UNCERTAIN` on an escalatable state routes to the HITL seam.

## Reference

- `resources/reference.md` — full state/transition/gate tables.
- `resources/flow.html` — the FSM as a self-contained state diagram (edge-for-edge
  with the playbook).
- `resources/research-frontier-evaluation.md` — the deep-research design
  rationale.
