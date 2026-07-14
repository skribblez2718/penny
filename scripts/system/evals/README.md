# Penny Evals — What "Better" Means

Penny's promise is not "runs without errors." It is: **a system that compounds
— every session leaves her measurably better at the next one.** This suite
defines "better" operationally and guards it with a regression ratchet.

## The six north stars

Everything here rolls up to six outcomes. If a proposed metric doesn't serve
one of these, it's probably a proxy.

| # | North star | The question it answers | Primary metrics |
|---|-----------|------------------------|-----------------|
| N1 | **Mistakes don't repeat** | Is the self-improvement loop actually closing? | `quality.repeat_mismatch_rate_90d`, `quality.mismatch_rate_30d`, `flywheel.compression_yield`, `flywheel.amendment_rot` |
| N2 | **Stored ⇒ findable** | Can Penny recall what she stored, when it matters? | `retrieval.golden_recall_hit5`, `flywheel.archiver_backlog` (a bloated hot store degrades recall) |
| N3 | **Work survives interruption** | Do runs finish; does state survive kill/compaction? | `quality.run_completion_30d`, engine resume tests (`apps/orchestration/tests`), `flywheel.obs_run_ingest` |
| N4 | **Confidence means something** | Does CERTAIN predict success better than UNCERTAIN? | `quality.calibration_gap_90d`, `quality.confidence_populated_30d` |
| N5 | **The loop stays alive** | Is every pipeline stage still *receiving* data? | all `flywheel.*` liveness checks, all `compat.*` contract checks |
| N6 | **The frame pays rent** | Does the shipped prompt hold task performance (and not actively hurt), per model family? | `prompt_efficacy.frame_on_pass_rate` (capability guard), `prompt_efficacy.frame_regressed_families` (harm guard), `prompt_efficacy.results_fresh_days`; `frame_gain_overall` is informational |

N5 exists because every historic failure here was a **silent seam death**: the
auto-diary 401'd 3,079 times, the archiver no-opped for months, compression ran
green nightly producing nothing. Senders logged success; receivers got nothing.
So liveness is measured at the **destination store**, never from the sender's
exit code.

## Anti-metrics — proxies this suite refuses to gate on

| Proxy | Why it lies | What we track instead |
|-------|-------------|----------------------|
| Drawer / memory count | Accumulation ≠ learning; 4,000 unfindable drawers are a liability | golden-recall hit rate; archiver backlog |
| `amendments_created` | Proposals that nobody reviews or applies improve nothing | amendment rot count; (eventually) mismatch rate before/after apply |
| `len(outcomes)` as "actions taken" | Volume of activity, says nothing about quality | MATCH/MISMATCH rates over the same records |
| Cron exit 0 / "job ran" | Compression exits 0 while yielding nothing, forever | yield checks: patterns-in ⇒ amendments-out |
| Warning logs as monitoring | 3,079 WARNs changed nothing; logs nobody reads aren't a control | delivery checks against the destination store |
| Tests existing | A test file the runner never collects is reassurance, not coverage | `compat.dead_tests` |
| Confidence labels declared | Decoration unless calibrated against outcomes | `quality.calibration_gap_90d` |

`quality.outcome_volume_30d` is reported **info-only** and can never gate, by
construction (`informational=True`).

## Running

```bash
make evals                  # full suite against the live stores
make evals-update-baseline  # absorb current reality into the ratchet
.venv/bin/python scripts/system/evals/run_evals.py --sections compat   # fast, deterministic
```

The ambient watcher cron also runs the suite twice daily with
`--signal-on-regression`, so a regression lands in `penny/signals` and reaches
the next session brief — the system's own surfacing pipeline, not another log.

## The ratchet (baseline.json)

- **expected_failures** — checks that are known-broken. They show ❌ in the
  scorecard but don't gate. When one starts passing, the runner flags it
  `FIXED`; remove the entry (or rerun `--update-baseline`) to lock the fix in
  as a hard guard. The goal is an empty list.
- **metrics** — last accepted value + tolerance per ratcheted metric.
  Automatic updates only ever **tighten** (move the good direction). Loosening
  a baseline is a human edit with a git diff to answer for.

Run history accumulates in `.penny/evals/history.jsonl` for trend analysis.

## Sections

| Section | File | Needs live stores | Character |
|---------|------|-------------------|-----------|
| compat | `eval_compat.py` | no | writer/consumer contracts, dead tests — belongs in `make test` |
| invariants | `eval_invariants.py` | no | leverage-spine capability invariants — grounded VERIFY, independent verify, HITL gates, checkpoint/resume; regress red if weakened |
| flywheel | `eval_flywheel.py` | yes | per-seam delivery liveness |
| quality | `eval_quality.py` | yes | mismatch, repeats, calibration, completion |
| retrieval | `eval_retrieval.py` | yes | golden-set recall hit@5 |
| prompt_efficacy | `eval_prompt_efficacy.py` | no (reads artifacts) | frame-on vs frame-off deltas per model family |

Quality checks SKIP below minimum sample sizes — a rate over three records is
noise, and ratcheting noise trains the baseline on luck. A wall of SKIPs is
itself a finding: it means the outcome ledger is starved.

### Capability invariants (the leverage spine)

`eval_invariants.py` makes the Bitter-Lesson doctrine self-enforcing
(`docs/agents/architecture/bitter-lesson.md`). It asserts the protected
capabilities — evidence-grounded VERIFY, independent verification (generator ≠
judge), HITL gates on high-stakes skills, durable checkpoint/resume — at the
contract/config level, in-process, no model calls. Per the doctrine's rule
*ratchet on capabilities, not implementations*, each check asserts a capability
(evidence is required; a human gate exists) rather than a code shape, so the
checks don't ossify. Gating checks carry no baseline metric: they pass silently
and **REGRESS loudly** if the capability is weakened. Behavioural invariants
(honest exhaustion) and Aspirational ones (model-scaling self-improvement,
pending checklist #23) are `informational` — tracked in the scorecard, never
gating on a proxy.

## Curating the golden recall set

`golden_recall.json` is curated, not generated. Whenever recall fails you in
real use — you *knew* Penny had stored something and she couldn't surface it —
add the query and target drawer as a case. Never delete a failing case; a
failing case is the eval doing its job. Searches run with `track_recall:
False` so measuring recall doesn't fabricate the reuse signal that retention
decisions key on.

## Prompt efficacy (N6): the two-part design

The prompt architecture's core claim — the universal Cognitive Frame improves
task performance across models — is measured, not assumed. Two parts:

- **`run_prompt_efficacy.py`** (expensive, manual/weekly:
  `make evals-prompt-efficacy`) replays `golden_prompt_tasks.json` through
  headless pi in matched arms — frame-on (`--system-prompt .pi/SYSTEM.md`) vs
  frame-off (a near-empty single-whitespace prompt — the raw model with no
  instructions, deliberately NOT pi's own default) vs per-section
  ablations (`--ablate`) — per
  model family, from a hermetic cwd with tools/extensions/skills/context files
  disabled so the frame text is the only variable. Results land in
  `.penny/evals/prompt_efficacy/latest.json`. Frame-on losing to frame-off
  beyond the noise margin writes a CRITICAL `prompt_degradation_<family>_*`
  signal (7-day expiry) into penny/signals.
- **`eval_prompt_efficacy.py`** (cheap, every `make evals` and cron run) reads
  that artifact only — never a model call. `results_fresh_days` ratchets
  harness liveness (a harness nobody runs is reassurance, not measurement);
  `frame_on_pass_rate` ratchets the absolute frame-on (production-config) pass
  rate — the capability that must not regress; `frame_regressed_families` gates
  at zero (the frame must never actively hurt). `frame_gain_overall` (frame-on
  minus frame-off) is **informational only**: the value-add of task scaffolding
  is allowed to trend to 0 as models improve — ratchet on the capability, not on
  the scaffolding's headroom.

Golden-task curation mirrors the recall set: cases are seeded from real Penny
workload shapes and added whenever the frame fails you in real use or before
adopting a new model family; never delete a failing case. Graders must stay
**behavior-blind** — they score task success (right answer, right structure,
right caution), never frame vocabulary, or the eval measures frame compliance
instead of frame value. Statistical honesty: with n tasks, one flipped task
moves a family's rate by 1/n, so the degradation margin is `max(5pp, 2/n)` and
per-family deltas below `MIN_FAMILY_TASKS` never gate. Growing the task set is
how the margin tightens.

**Hybrid grading (judge grader).** Most tasks grade with deterministic checks
(`contains_*`, `regex*`, `json_fields`). Semantic tasks — where keyword matching is
phrasing-brittle — use a rubric-based **LLM judge** (`type: "judge"`, fixed model
`claude-haiku-4-5`) that scores substance against an inline rubric (`pass_bar` /
`required_facts` / `fail_traps`) and emits `VERDICT: PASS/FAIL` (last verdict wins).
A judge check may only gate a default run after its rubric **and** a frozen
calibration key are human-approved (`approved_by`/`approved_at`);
`run_judge_calibration.py` validates the judge against that key (agreement ≥ 0.80,
false-pass ≤ 0.20, Claude slice included) before it counts. The artifact records
`grading_scheme` + `runner_version` so keyword- and judge-graded pass rates are
never diffed; a judge-call failure retries once then EXCLUDES the cell (never a
silent PASS, never a keyword fallback). Use `--experimental` for a non-gating
iteration lane and `--judge-repeats`/`--max-judge-calls` to tune cost/noise.

Known limits (deliberate v1 scope): tasks are single-turn and tool-less, so
the eval measures the frame's effect on reasoning/answer quality, not on
agentic tool-use behavior; and `--thinking` is pinned per run (default `low`)
so frame effects aren't confounded with reasoning-effort differences.
