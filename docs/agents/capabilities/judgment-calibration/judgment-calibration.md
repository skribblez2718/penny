# Judgment Calibration

Operational reference for the judgment-calibration harness (`scripts/system/judgment/`). Human-facing rationale: [Judgment Calibration (Human)](../../../humans/capabilities/judgment-calibration/judgment-calibration.md).

## What It Is

When Penny's orchestration loop drops from Fable to a mix of open models (GLM/DeepSeek/Kimi/MiniMax), the system loses Fable's implicit judgment — deciding whether an output is good enough, whether a finding is real, whether work is actually done (`ctx.met`, set by each playbook's `done_predicate`). The judgment-calibration harness **externalizes that judgment** so quality no longer depends on the driver model being smart.

Three artifacts:

| Artifact | What it is |
|----------|-----------|
| `rubrics.json` | Fable-authored grading rubrics per work-product class (`plan_quality`, `finding_validity`, `synthesis_completeness`) — process-shaped `check` lists + a `pass_bar` |
| `calibration_corpus.jsonl` | Fable's PASS/FAIL verdicts (with score, reasoning, failure_mode) on real Penny work products — **the ground truth; authored 2026-07-07, extend only, never loosen** |
| `judge_prompt.md` | The frame-independent grader system prompt a candidate judge runs under |

## The Harness

`run_judge_agreement.py` (`make judge-agreement`) replays every corpus record through each candidate judge model (headless pi: grader prompt + class rubric + work product), parses `VERDICT: PASS|FAIL`, and scores agreement with Fable. Metrics per model:

| Metric | Meaning |
|--------|---------|
| `agreement` | Fraction of records where judge verdict = Fable verdict |
| **`false_pass_rate`** | Of Fable-FAIL records, fraction the judge PASSED — **the autonomy-safety metric** (a judge that waves through bad work is what makes unattended autonomy unsafe) |
| `false_fail_rate` | Of Fable-PASS records, fraction the judge FAILED (too strict — annoying, not dangerous) |
| `kappa` | Cohen's kappa (agreement beyond chance) |
| `per_class` | Agreement broken down by work-product class |

Results → `.penny/evals/judgment/latest.json`. Pick the judge with highest agreement and lowest `false_pass_rate`.

## The Eval Section

`eval_judgment.py` (section `judgment`, runs in every `make evals` — reads the artifact only, never a model call). Ratchets:

- `judgment.best_judge_agreement` (up_good, floor 0.60) — the frontier: our best available judge's agreement. If it falls, the best verifier we can build got worse.
- `judgment.best_judge_false_pass_rate` (down_good, absolute ceiling 0.34) — the safety gate.
- `judgment.results_fresh_days`, `judgment.corpus_size` (informational).

"Best" is recomputed each run (highest agreement, tie-broken by lowest false-pass), so the metric tracks the frontier, not a pinned model.

## How To Use It

1. `make judge-agreement` → read the leaderboard.
2. Wire the winning model into the VERIFY primitive (`apps/orchestration/src/orchestration/primitives/verify.py`, agent `vera`) as its judge — this makes a weak orchestrator's "is it done?" backed by a Fable-calibrated verifier. (Runtime wiring is planned in `plans/`; the harness + eval ship now.)
3. Re-run when a model updates or when you extend the corpus; the eval catches drift.

## Curation Rules

- **Extend, never loosen.** Add a record whenever the chosen judge disagrees with your own call on a real work product (that disagreement is the corpus doing its job). Growing the corpus tightens the metric.
- **Keep the hard cases.** The corpus's value is the score-2 "plausible-but-wrong" FAILs (a fabricated API in a fluent plan, a finding whose scenario can't occur, a synthesis that changed one number). A test enforces their presence.
- **Rubrics are process-shaped** — they name what to CHECK, never "be thorough."
