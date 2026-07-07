# Ambient Watchers — Proactive signal generation at session start

## What

Python watcher scripts run at session start, query mempalace for patterns (MISMATCH rates, confidence trends, stale tasks), and surface signals to the user before processing begins.

## Why

Penny cannot initiate — she only responds to user input. Watchers bridge this gap by running pre-session checks and presenting findings proactively.

## Rules

1. **CRITICAL signals must be addressed before proceeding.** Acknowledge resolution in `penny/signals`.
2. **Amendments must be addressed before proceeding.** Same acknowledgment requirement.
3. **Skip duplicate signals.** `check_duplicate` (0.99 threshold) prevents spam.
4. **Individual watcher failures do not crash the pipeline.** Each watcher is wrapped in try/except.

## Watchers

| Watcher | Trigger | Threshold |
|---------|---------|-----------|
| `mismatch_rate` | ≥N MISMATCH outcomes in window | 3 in 7 days |
| `confidence_trend` | Declining confidence across sessions | 0.5 trend over 7 days |
| `mempalace_growth` | Drawer count exceeds threshold | 500 drawers |
| `task_staleness` | Task untouched for N days | 7 days |

## External emitters (same signal pipeline, not in `run_all_metric_watchers`)

| Emitter | Signal | Trigger |
|---------|--------|---------|
| `scripts/system/evals/run_evals.py --signal-on-regression` | `eval_regression_<date>` (CRITICAL) | Any ratchet regression in `make evals` (ambient cron runs this twice daily) |
| `scripts/system/evals/run_prompt_efficacy.py` | `prompt_degradation_<family>_<date>` (CRITICAL, 7-day expiry) | A model family's frame-on pass rate falls below frame-off beyond the noise margin — see `docs/agents/prompts/cognitive-frame-standards.md` (Monitoring) for the response protocol |

## Procedure

### Adding a new watcher
1. Create function in `signal_generators.py` returning `Optional[dict]`
2. Register in `run_all_metric_watchers()`
3. Signal schema must include all required fields per `penny/signals` protocol

## Constraints

- **Watchers are read-only** until `write_signal()` is called.
- **All signals require explicit acknowledgment.** No auto-dismissal.
- **T2 room expiry** auto-removes old signals after 7 days.

## Verification

- [ ] Session start checker runs before user request processing
- [ ] CRITICAL signals block until acknowledged
- [ ] Duplicate signals suppressed

## Files

| File | Purpose |
|------|---------|
| `scripts/system/watchers/signal_generators.py` | Core library |
| `scripts/system/watchers/session_start_checker.py` | CLI orchestration |
| `scripts/system/watchers/test_signal_generators.py` | Unit tests (19) |
| `scripts/system/watchers/test_e2e_signals.py` | E2E tests (3) |
