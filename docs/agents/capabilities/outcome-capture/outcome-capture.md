# Outcome Capture

Operational reference for source-agnostic outcome capture (`scripts/system/outcome_ledger/capture.py`, `rate_recent.py`). Human rationale: [Outcome Capture (Human)](../../../humans/capabilities/outcome-capture/outcome-capture.md).

## Why This Exists

The outcome ledger's only wired source was the orchestration engine's terminal state (`outcome_writer.record_outcome`, called at `engine.py:657/675`). In production that path almost never fires — Penny does most work via direct agent/subagent calls that never drive the engine to completion, so the engine-only ledger stayed empty and the nightly compression cron logged `amendments_created: 0`. (A 2026-07-07 spot check that motivated this work found the checkpointer `runs` table empty against ~1k agent invocations — a dated one-time observation, not a standing metric.) The capture code was correct and enabled (`PENNY_CAPTURE_OUTCOMES` defaults to `1`); it was simply plumbed to a source that doesn't flow.

This capability gives the ledger a source that matches reality and the moderate human-feedback budget.

## Components

| File | Role |
|------|------|
| `capture.py` | `record_work_outcome(...)` — the shared, source-agnostic writer any path calls |
| `rate_recent.py` | Human quick-rating CLI (`make rate`) — reads recent sessions from observability, rates the unrated ones |
| `ledger.py` | Pre-existing (was orphaned) write/read/evaluate API |

## `record_work_outcome` (the shared entry point)

Signature (keyword-only): `goal`, `action_taken`, `delta_score` (MATCH/PARTIAL/MISMATCH), `confidence`, `domain`, `reason`, `session_id`, `decision_id`, `source`, `existing_ids`, `writer`. Returns the `decision_id` on write, `None` on duplicate or write failure. Never raises except on invalid `delta_score`/`confidence`.

Non-negotiables:
- **The `reason` field is load-bearing.** It is the groupable failure signature `compression_loop.identify_patterns` clusters MISMATCHes on. A MISMATCH/PARTIAL without a `reason` is dead weight for pattern mining — the old flywheel break. Always pass a `reason` on non-MATCH.
- **Drawer format matches the engine writer**: a header line (mismatch-signal fields first, truncation-durable) + a JSON body. Both sources are read identically by `eval_lib.parse_outcome` and `run_compression._parse_outcome_record`.
- **Dedup** via `existing_ids` + a stable `decision_id` derived from `(session_id, goal)`, so re-capturing the same work does not double-record.
- **Domain** is model-classified when not supplied — a cheap model picks from the fixed domain menu (gated by `PI_LEDGER_DOMAIN_MODEL`), with the word-boundary keyword table (`infer_domain`) as the resilient fallback on unset/failure. The keyword scaffold is a backstop, not the primary path.

## `make rate` (the human source)

Reads the most recent sessions from observability (each session's opening user prompt = the goal), filters out short/greeting sessions and ones that already have an outcome, and presents each for a one-keystroke rating (MATCH / PARTIAL / MISMATCH / skip) with an optional one-line reason on non-MATCH. Each rating writes via `record_work_outcome` with `source="human_rating"`.

- `make rate` — interactive.
- `make rate ARGS=--json` — prints `{"pending": N}` (used by the session brief).

The session-start brief surfaces a nudge (`count_pending_ratings` in `session_start_checker.py`) when work awaits rating.

## `make auto-capture` (the judge-backed automatic source)

`auto_capture.py` fills the ledger without a human: it runs the **calibrated judge** (MiniMax-M3, the same model wired into vera — see [Judgment Calibration](../judgment-calibration/judgment-calibration.md)) over recent unrated tasks and records an outcome for each. It also runs in the ambient cron (capped at 10/run, best-effort, before the archiver and evals).

- Goal = a session's opening request; work product = **the assistant's answer to that opening goal** (the last substantive assistant message *before the second user turn* — `opening_response`). **Do not pair the opening goal with the session's final message**: in multi-task sessions the final message answers a later, different task, so the judge correctly calls it off-topic and the outcome is mislabeled MISMATCH. Scoping to the opening exchange keeps goal↔response aligned; later tasks in the session are left for `make rate`.
- Label = the judge's PASS→MATCH / FAIL→MISMATCH, with its one-line WHY as the `reason`.
- `source="judge_auto"`; dedup shares the `(session_id, goal)` decision-id with `make rate`, so a task is never both auto-judged and human-rated.
- Best-effort: any judge/spawn failure skips that task (never raises, never blocks). Default judge model is kept in sync with `.pi/agents/vera.md`.

Trust discipline: these labels are only as good as the judge, and the judge's false-pass rate is tracked by the `judgment` eval section (absolute ceiling 0.34). If that metric regresses, auto-capture's labels are known-degraded before they mislead the flywheel.

## Engine path is judge-backed (already)

The orchestration engine's terminal outcome (`outcome_writer.record_outcome`) records `ctx.verify_verdict`, which each playbook's `done_predicate` derives from vera's SUMMARY. Switching vera to minimax-m3 (the calibrated verifier) makes those engine labels calibrated too — no engine code change was needed.

## Validation (2026-07-07, one-time)

Dated results from when the capability shipped — not standing guarantees; re-verify against the live system if in doubt:

- Capture write path works against the live store (probe write to `penny/outcomes`).
- Auto-capture works end-to-end against live MiniMax (2 tasks judged MATCH with sensible reasons).
- `make setup` installs the watcher crons (via `init` → `setup.sh` globbing `init-*.sh`, including `init-watchers.sh`); the crontab confirmed watchers/compression/digest are scheduled.

## Next Steps (planned)

See `plans/self-sustaining-quality/01-flywheel-closure.md`: feed human overrides of the judge's auto-verdict back into the judgment calibration corpus (so rating also sharpens the verifier), and a `make rate --review` mode to spot-check `judge_auto` outcomes.
