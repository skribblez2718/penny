# Research Reference

The research skill is a `BasePlaybook` subclass (`ResearchPlaybook` /
`ResearchMachine`) on the shared orchestration engine
(`apps/orchestration/src/orchestration/playbooks/research.py`). State lives in
the durable SQLite checkpointer keyed by `run_id`; there is no `/tmp` state, no
`--state` argv, and no `extract_state`/`restore_state`. `scripts/orchestrate.py`
is a thin delegate to `orchestration.cli`.

One machine serves all three modes (quick / standard / deep). The mode is
**caller- or model-declared** — `constraints["mode"]` wins, else piper declares it
in its plan SUMMARY and an unrecognized declaration falls back to `standard`.
There is no keyword mode detection — the legacy keyword-matching mode router was
deleted per the Bitter-Lesson gate and must not be reintroduced (rationale in the
`ResearchPlaybook` module docstring). Only an explicit caller `quick` skips
planning.

> **Drift guard.** The State and Transition tables below are enforced against
> `ResearchMachine` by `apps/orchestration/tests/test_reference_drift.py`, and
> `resources/flow.html` by `test_flow_diagrams.py` — a state or edge added,
> removed or rewired without updating both files fails CI. **Prose outside those
> two tables is NOT enforced**; it is hand-maintained and is the part that rots.
> When you change routing, re-read this file, not just the tables.

## States

| State | Agent | Description |
|-------|-------|-------------|
| `intake` | — | Initial. Validate a non-empty goal, resolve the mode, expand it into the rigor budget, seed `max_sub_queries`, route (explicit caller `quick` → `researching`, else `planning`). |
| `planning` | piper | Decompose the query into independently researchable sub-queries; declare the mode unless the caller fixed it. |
| `critiquing_plan` | carren | Critique the plan: coverage, redundancy, feasibility. Runs when `critique_passes >= 2`. Evidence-gated. |
| `researching` | echo × N | **Dynamic fan** — one read-only echo branch per sub-query (arrangement 4), bounded by `max_fan_width`. Re-entered for evidence-seeking rounds. The explicit-quick fast-path stays a single echo agent. |
| `synthesizing` | synthia | Synthesize all branch findings into one thematic, cited report. Has **no web tools by design** — it integrates evidence, it does not gather it. |
| `critiquing_report` | carren | Critique the report: overclaiming, bias, fairness, uncertainty. Runs when `critique_passes >= 1`. Evidence-gated. |
| `validating` | vera | **Independent citation-grounding gate, ALL modes.** Verifies every material claim traces to a cited source that supports it. Evidence-gated. |
| `report_writing` | skribble | Write `report.md`, `sources.md`, `README.md` to the output dir. Adds no claims. Not escalatable. |
| `unknown` | — | Progress-gate escalation staged. |
| `awaiting_clarification` | — | Paused for user clarification; resumes producer-oriented (see Resume). |
| `complete` | — | Final. `done_predicate` = the report was written. |
| `error` | — | Final. Terminal failure (abort). |

## Transitions

| Event | From | To | Guard |
|-------|------|-----|-------|
| `start_plan` | `intake` | `planning` | no explicit caller `quick` (the default path — the model declares the mode at planning) |
| `start_research` | `intake` | `researching` | explicit caller `constraints["mode"] == "quick"` |
| `plan_to_critique` | `planning` | `critiquing_plan` | `critique_passes >= 2` |
| `plan_to_research` | `planning` | `researching` | `critique_passes < 2` (also deep after a clarify resume) |
| `plan_critique_pass` | `critiquing_plan` | `researching` | `verdict == APPROVE` |
| `plan_critique_revise` | `critiquing_plan` | `planning` | `verdict != APPROVE` and `iter+1 < max_iterations` |
| `plan_critique_exhausted` | `critiquing_plan` | `researching` | budget spent; warning recorded, issues surfaced |
| `research_done` | `researching` | `synthesizing` | — (unconditional; ends the round) |
| `synth_to_critique` | `synthesizing` | `critiquing_report` | `critique_passes >= 1` AND the report-critique loop has not already closed (`phase != "validation"`) |
| `synth_to_validate` | `synthesizing` | `validating` | no critique budget, or the report critique already closed |
| `report_critique_pass` | `critiquing_report` | `validating` | `verdict == APPROVE` |
| `report_critique_revise` | `critiquing_report` | `synthesizing` | any non-APPROVE verdict and `iter+1 < max_iterations` |
| `report_critique_exhausted` | `critiquing_report` | `validating` | budget spent; warning recorded, issues surfaced |
| `validate_pass` | `validating` | `report_writing` | `verdict == PASS` |
| `validate_research` | `validating` | `researching` | `verdict != PASS`, vera named `evidence_needed`, `iter+1 < max_iterations` AND a research round remains — **evidence-seeking**: re-fan echo on the named gaps |
| `validate_revise` | `validating` | `synthesizing` | `verdict != PASS` and `iter+1 < max_iterations`, with no researchable gap named or the round budget spent — re-ground from existing findings |
| `validate_exhausted` | `validating` | `report_writing` | budget spent; unverified claims surfaced, never shipped as verified |
| `report_done` | `report_writing` | `complete` | — (completes either way; `done_predicate` reports the honest outcome) |
| `to_unknown` | `planning` \| `critiquing_plan` \| `researching` \| `synthesizing` \| `critiquing_report` \| `validating` | `unknown` | progress gate returned a reason |
| `escalate` | `unknown` | `awaiting_clarification` | — |
| `clarify` | `awaiting_clarification` | `planning` | resume target `planning` (default/fallback) — escalated from `planning` or `critiquing_plan` |
| `clarify` | `awaiting_clarification` | `researching` | resume target `researching` — escalated from `researching`; the plan is KEPT |
| `clarify` | `awaiting_clarification` | `synthesizing` | resume target `synthesizing` — escalated from `synthesizing`, `critiquing_report` or `validating` |
| `abort` | any non-final state | `error` | fatal error |

## SUMMARY contracts

Each state validates against its own contract; `evidence` fields must be present
AND non-empty (the externally-grounded-evidence guarantee — a verifier cannot PASS
on a bare assertion).

| State | Primitive | Required | Notable optional | Evidence-gated |
|-------|-----------|----------|------------------|----------------|
| `planning` | `RESEARCH_PLAN` | `plan_steps`, `plan_complete` | `mode` (model-declared rigor preset) | no |
| `critiquing_plan` | `RESEARCH_CRITIQUE_PLAN` | `verdict`, `issues`, `evidence` | — | **yes** |
| `researching` | `RESEARCH_EXPLORE` (fan branches: `RESEARCH_EXPLORE_SQ<n>` / `RESEARCH_EVIDENCE_SQ<n>`) | `explore_complete` | `findings_count`, `sources_count` | no |
| `synthesizing` | `RESEARCH_SYNTHESIZE` | `synthesis_complete` | `theme_count`, `source_count` | no |
| `critiquing_report` | `RESEARCH_CRITIQUE_REPORT` | `verdict`, `issues`, `evidence` | — | **yes** |
| `validating` | `RESEARCH_VALIDATE` | `verdict`, `unsupported_claims`, `evidence` | **`evidence_needed`** — researchable questions that drive the evidence-seeking loop | **yes** |
| `report_writing` | `RESEARCH_REPORT` | `write_complete`, `files_written` | `word_count` | no |

`confidence` is optional everywhere; an `UNCERTAIN` confidence on an escalatable
state routes to the HITL seam. Every prompt in `assets/prompts/` carries its own
typed `SUMMARY:{...}` schema, so the contract survives `PI_MODEL_TIER=strong` (which
strips the engine's restatement) — enforced by `test_contract_prompt_drift.py`.

## Budgets

Code caps; the model spends. Ceilings are safety limits, not targets.

| Budget | Default | Ceiling | Set by |
|--------|---------|---------|--------|
| `max_sub_queries` | 4 (tier-scaled via `PI_MODEL_TIER`) | `max_fan_width` | `constraints["max_sub_queries"]` |
| `max_fan_width` | 8 | — | `constraints["max_fan_width"]` |
| `max_research_rounds` | 2 (deep: 3) | — | `constraints["max_research_rounds"]` — set to `1` to disable evidence-seeking |
| `critique_passes` | 0 (deep: 2) | — | `constraints["critique_passes"]` |
| `max_iterations` | 3 | — | `constraints["max_iterations"]` |
| `STEP_CAP` | 50 | — | engine default |

There is **no per-mode sub-query table**: `max_sub_queries` is one budget the model
spends within, clamped to the fan width and enforced at dispatch (an over-budget
plan is truncated with a recorded warning).

### Mode is a budget preset

Mode does NOT gate FSM edges directly. It expands — at intake when the caller fixed
it, else at `planning` when piper declares it — into a rigor budget the routing
spends (`MODE_BUDGETS` in the playbook):

| Mode | `critique_passes` | `max_research_rounds` |
|------|-------------------|-----------------------|
| `quick` | 0 | 2 |
| `standard` | 0 | 2 |
| `deep` | 2 | 3 |

`critique_passes` is a monotonic ladder that allocates the scarcer budget to the
more valuable critique first: `>= 1` enables the **report** critique (carren reads
the actual output), `>= 2` also enables the **plan** critique. An explicit caller
constraint beats the preset, so rigor is decoupled from the label — a `standard`
run with `critique_passes: 1` gets an adversarial report read without paying for a
plan critique.

`max_sub_queries` is deliberately absent from that table: mode governs
**verification spend**, never decomposition breadth. A per-mode sub-query count was
deleted as a Bitter-Lesson violation and must not be reintroduced here.

### Rigor escalation (opt-in)

With `constraints["rigor_escalation"]` set, a run whose validation FAILS with no
researchable gap named — and which was never budgeted a critique — is granted ONE
report-critique pass, recorded as a warning and surfaced as `rigor_escalated` in
the result. One-shot per run. Evidence-seeking takes precedence: when vera names a
gap, the run searches rather than spending the escalation.

**Default OFF.** Enabling it rewrites the published quick/standard validation loop
(`validating → synthesizing → validating` becomes `validating → synthesizing →
critiquing_report`), and no measurement yet shows the extra pass recovers runs the
re-grounding loop would not.

## Loops

All revise loops are bounded by `ctx.max_iterations`, and every exhaustion is
honest — the run proceeds with a recorded warning and the unresolved issues
surfaced, never a forced approval.

- **Plan critique** (`critique_passes >= 2`): `critiquing_plan → planning →
  critiquing_plan` while `verdict != APPROVE` and budget remains. On exhaustion,
  `plan_critique_exhausted` proceeds to `researching`.
- **Report critique** (`critique_passes >= 1`): `critiquing_report → synthesizing
  → critiquing_report` under the same rule. On exhaustion,
  `report_critique_exhausted` proceeds to `validating`.
- **Validation** (all modes): `validating → synthesizing → validating` while
  `verdict != PASS` and budget remains. On exhaustion, `validate_exhausted`
  proceeds to `report_writing` with the unverified claims surfaced.
- **Evidence-seeking** (all modes): `validating → researching → synthesizing →
  validating` when vera names `evidence_needed` and a research round remains.

### Why evidence-seeking exists

The gate's answer to "this claim has no support" becomes *go find out*, not only
*delete the claim*. Without that edge the sole remedy is deletion — the synthesizer
has no web tools by design — so the gate could only ever make the report thinner,
never better grounded. Bounded by BOTH `max_research_rounds` and
`ctx.max_iterations`; when either is spent the run falls back to `validate_revise`
and ultimately to honest exhaustion.

Branch numbering CONTINUES across rounds (round two writes `-echo-4`, `-echo-5`, …)
so new findings join one flat drawer namespace instead of overwriting round one's.

**The verifier names what is missing; it does not supply it.** vera diagnoses the
gap, echo (read-only, full search toolset) fills it, synthia integrates it, vera
re-checks. A verifier that sourced its own evidence would be judging material it
authored — the generator-as-own-verifier failure relocated inside the verifier.
Researchers are told that "no supporting source found" is a **useful** result;
without that, dispatching an agent to find support for a claim is an incentive to
manufacture it.

Loop counters reset between loops (`_end_plan_loop` / `_end_report_loop` /
`_end_validation_loop`) so one loop's history cannot contaminate another's stall
detection.

## Escalation and resume

Escalation is the engine's single HITL seam. `progress_check` forces
`to_unknown → escalate → awaiting_clarification` when:

- any agent SUMMARY sets `needs_clarification: true` (questions surfaced);
- `planning` returns `plan_complete: false`;
- `researching` returns `explore_complete: false` (fan: ANY branch false);
- `synthesizing` returns `synthesis_complete: false`;
- a critique (`critiquing_plan` / `critiquing_report`) is non-APPROVE AND the same
  issues persist across revisions (`is_stalled`);
- `validating` is non-PASS AND the same unsupported claims persist (`is_stalled`).

`ESCALATABLE_STATES` = `planning, critiquing_plan, researching, synthesizing,
critiquing_report, validating`. `report_writing` does not escalate.

An `UNCERTAIN` confidence on any escalatable state also routes to the seam; a
parallel fan aggregates by **weakest** branch confidence, so one UNCERTAIN branch
escalates the fan.

> **Engine-level opt-in:** with `PENNY_UNCERTAINTY_RETRY` set, a single-agent state
> reporting UNCERTAIN gets ONE bounded re-attempt (with the uncertainty named)
> before reaching a human — compute before human attention. It never applies to
> `needs_clarification`, stalls, or parallel fans. Dormant by default; see
> `engine._maybe_retry_uncertain`.

### Resume

Resume is a `step` with the same `session_id` + `run_id` and a `--result` carrying
the user's answer. The engine sets `clarification_text`, fires `clarify`, and folds
the clarification into the next task. There is no `orchestrator_state` to thread
back.

`clarify` is a **conditional multi-target** transition whose target is
**producer-oriented** — the run resumes at the agent that can actually ACT on the
answer, not at the position where it happened to stop (`_RESUME_TARGET_BY_STATE`):

| Escalated from | Resumes at | Why |
|----------------|-----------|-----|
| `planning` | `planning` | the planner acts on it |
| `critiquing_plan` | `planning` | re-critiquing an unchanged plan cannot use the answer |
| `researching` | `researching` | re-research WITH the clarification; **the plan is kept** |
| `synthesizing` | `synthesizing` | the synthesizer acts on it |
| `critiquing_report` | `synthesizing` | the report has to change |
| `validating` | `synthesizing` | the synthesis has to change |

Loop counters (`ctx.iteration`, `iteration_history`) always reset — the answer is
new information, so the loop earns a fresh budget. A **full restart** (target
`planning`) also clears `phase` and the `*_exhausted` markers so an abandoned pass
cannot leak into the fresh one; a **mid-pipeline resume** deliberately PRESERVES
them, because they are historical facts the result must still report honestly.

## Verification independence

synthia and vera run the **same model by default**, so `validating` is a same-model
gate over the generator's own synthesis. Two things mitigate it: the gate is
evidence-based (every claim must trace to a captured source), and carren's report
critique is cross-model — but that only runs when `critique_passes >= 1`, so a
default quick/standard run has a same-model final gate.

`model_for_state` exposes an **opt-in** cross-model hook scoped to `validating`:

`constraints["validate_model"]` → `RESEARCH_VERA` → `RESEARCH_DEFAULT` → vera's own
frontmatter model. Unset or malformed values fall through, so the default path is
unchanged and a typo cannot break a run. The hook never re-points the generator —
scoping it to the verifier is what makes it independence.

The edge is a registered, dated `SAME_MODEL` exception in
`orchestration/independence.py`. Measured against the labelled grounding corpus
(`tests/research_grounding_corpus.py`; artifact at
`.penny/ablation/research_grounding/latest.json`): the deterministic floor
(`research.grounding_floor`) already decides **40%** of grounding defects with zero
model spend and zero false positives. The **60% judgement residual** is the only
slice a second model could affect — cross-model does not become the default until
it is measured on that slice.

## MemPalace

**Room:** `skills/research-{session_id}`

| Drawer | Written By | Content |
|--------|-----------|---------|
| `{sid} Planner` | piper | Sub-queries, scope, rationale |
| `{sid}-echo-{n} Research Findings` | echo | Findings for branch N — numbering continues across evidence-seeking rounds, so nothing is overwritten |
| `{sid} Synthesis` | synthia | Synthesized report |
| `{sid} Critique` | carren | Plan / report critique verdicts |
| `{sid} Report Files` | skribble | Written report files |

## Output

`report_writing` writes to the absolute path
`$PROJECT_ROOT/research/<slug>-<digest>`, producing `report.md`, `sources.md`, and
`README.md`. The directory name is a readable slug plus a short digest of the FULL
query: two long queries sharing an 80-char prefix would otherwise collide and the
second run would silently overwrite the first's report. Deterministic, so
re-running the same query refreshes in place.

The result payload reports:

| Field | Meaning |
|-------|---------|
| `met` | **DELIVERY** — the report was written (`done_predicate`) |
| `grounded` | **VERIFICATION** — vera's citation gate passed |
| `mode`, `sub_queries`, `research_rounds`, `critique_passes`, `rigor_escalated` | what the run actually spent |
| `report_dir`, `report_files`, `room`, `iterations` | where the output and working state live |
| `warnings`, `unresolved_issues`, the three `*_exhausted` flags | the honest record |

`met` and `grounded` answer different questions: a validation-exhausted run is
`met=True, grounded=False` — delivered, with its unverified claims named. The
validation verdict is also mirrored onto the run context (`ctx.verify_verdict` /
`ctx.verify_gaps`) and into the outcome-ledger **header**, so the improvement loop
records grounding rather than merely delivery.
