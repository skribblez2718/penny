# Judgment Calibration

## What It Is

Judgment Calibration bottles Oracle's judgment into data so the system keeps a Oracle-grade quality bar after Oracle is gone. Oracle authored grading rubrics and a corpus of PASS/FAIL verdicts on real Penny work products (plans, code-review findings, research syntheses). A harness then measures how well each open model reproduces those verdicts — so you can pick, and continuously monitor, a verifier that judges at Oracle's standard instead of inventing its own.

## Why It Exists

When Penny's orchestration loop runs on a mix of open models, the system loses the judgment Oracle supplies for free: knowing when work is actually done, whether an output is good enough, whether a finding is real. Every other improvement mechanism depends on that judgment — the outcome ledger records success/failure, the flywheel learns from those labels, autonomy keys off confidence. If the driver's judgment is unreliable, the ledger learns from noise and the flywheel amplifies it. So the highest-value move is to stop quality from depending on the driver being smart: externalize the judgment into a calibrated verifier.

The corpus can only be authored while Oracle is here — it's the teacher's standard frozen before the teacher leaves. The judge that reproduces it can be chosen and re-checked any day after.

## How It Works

1. `make judge-agreement` runs each candidate open model as a grader over Oracle's corpus and reports a leaderboard: agreement with Oracle, and — most importantly — the **false-pass rate** (how often the judge waves through work Oracle failed).
2. You wire the best judge into the verification step, so a weak orchestrator can't declare work "done" until a Oracle-calibrated verifier agrees.
3. The `judgment` eval section tracks the best judge's agreement and false-pass rate on every `make evals`, so if a model update degrades your verifier, it surfaces as a ratchet regression.

## The One Number That Matters

False-pass rate. A judge that's occasionally too strict just makes you re-review — annoying, safe. A judge that passes bad work is what makes unattended autonomy dangerous. The eval puts an absolute ceiling on it, independent of the ratchet.

## Keeping It Honest

Grow the corpus whenever the judge disagrees with your own call on a real work product — that disagreement is the signal. Never loosen a rubric's pass bar without a git diff to answer for. The corpus's power is its hard cases: the fluent plan with a fabricated API, the confident finding whose scenario can't occur, the faithful-looking synthesis that changed one number — exactly what a weak judge waves through.

## Learn More

- Operational rules, metrics, and curation: `docs/agents/capabilities/judgment-calibration/judgment-calibration.md`
- The harness: `scripts/system/judgment/`
- How it fits the bigger program: `plans/self-sustaining-quality/` (flywheel, behavioral ratchet, graduated autonomy)
