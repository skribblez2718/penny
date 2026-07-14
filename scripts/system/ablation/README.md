# code_detection ablation — heuristic tables vs model-inferred detection

Part of the Bitter-Lesson **non-frame ablation harness** (checklist item #3). It
produces the ship/no-ship evidence for item #9 — retiring
`apps/orchestration/src/orchestration/playbooks/code_detection.py`'s hand-coded
framework/dep tables in favour of model-inferred detection. It embodies the
doctrine's rule: *build the meter, measure, then cut.*

## Why

`code_detection.py` classifies a repo's stack with ~13 hand-maintained tables
(framework→dep-tokens, entry-point filenames, run commands). Framework churn is
monthly, so the tables **rot**: a repo using a framework not in the list is
misclassified. This harness measures that gap directly, per the doctrine's
*ratchet on capabilities, not implementations* — it scores detection *accuracy*,
not any particular code.

## What it does

Runs two detector *arms* over labeled fixtures, scoring each against ground truth
(fields: `is_server`, `language`, `framework`):

- **heuristic** — the existing `_detect_server_framework` (the scaffold under test)
- **model** — a headless-pi call that reads the project files and reports the same
  fields as JSON (the proposed replacement)

Detector-agnostic; the model arm's pi call is injectable (`runner`), so the whole
harness is unit-tested with a fake — **no live model call under `pytest`** (mirrors
the two-part `prompt_efficacy` design).

## Run

```bash
# heuristic only (no model, instant)
.venv/bin/python scripts/system/ablation/run_code_detection_ablation.py --arms heuristic

# both arms (one cheap model call per fixture) — the real evidence
.venv/bin/python scripts/system/ablation/run_code_detection_ablation.py --model anthropic/claude-haiku-4-5
```

Writes `.penny/ablation/code_detection/latest.json`.

## Result (2026-07-13, `claude-haiku-4-5`)

| arm | cases correct | note |
|-----|---------------|------|
| heuristic | 2/3 (67%) | misses `hono` — not in the tables |
| model | 3/3 (100%) | reads the files, catches `hono` |

**+33% delta → evidence to retire the tables** (keeping them as a cheap-tier
fallback per the doctrine). The `hono` fixture is the point: a real HTTP server
the hand-coded tables call "not a server," which a model reading `package.json` +
`new Hono()` identifies correctly.

## Staleness & auto-invalidation (item #4)

The artifact records `invalidators` — the SHA-256 of the scaffold under test
(`code_detection.py`). `tune_freshness.check_ablations_stale()` re-hashes it and
reports the ablation **`invalidated (scaffold changed)`** the moment
`code_detection.py` is edited (or retired), plus **`stale (age)`** after 30 days.
`make tune-deep` surfaces this (it does **not** auto-re-run — the model arm costs
calls). This is the non-frame analogue of the frame's FR-19 (`SYSTEM.md`-hash)
invalidation: the artifact self-declares *what changes it*, so the checker stays
generic.

## Files

- `ablate_lib.py` — detector-agnostic harness (cases, scoring, report, artifact)
- `detectors.py` — heuristic + model detector arms (pi call mirrors `prompt_efficacy_judge`)
- `run_code_detection_ablation.py` — CLI runner (expensive/manual; never in `make evals`)
- `fixtures/code_detection/` — labeled project fixtures + `truth.json`

## Deliberately NOT built

A general scaffold-toggle framework — this is a focused per-scaffold instrument;
speculative generality would itself be the KNOWLEDGE-CONSTRAINT scaffolding the
doctrine warns against. The **#9 production change** (make `code_detection.py`
call the model with a heuristic fallback behind a tier flag) is the follow-on
this evidence unblocks.
