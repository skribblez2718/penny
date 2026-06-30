# Ambient Watchers

**Status:** MVP Implemented (2026-04-27)
**Related:** [AI Gaps Resolution — Step 5](/plans/ai-gaps-resolution)

---

## What It Does

Ambient Watchers let Penny notice problems _before_ you ask about them.

At the start of each conversation, Penny runs lightweight checks against the
outcome ledger, mempalace growth, and task staleness. If anything crosses a
threshold, a **signal** is written to `penny/signals`. Penny surfaces CRITICAL
signals immediately; INFO signals are mentioned briefly.

This addresses **Gap 3 — Cannot Initiate** (proactive awareness).

---

## Signal Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│  Watcher detects condition (e.g. >3 MISMATCH outcomes in 7 days)  │
│                         ↓                                           │
│              write_signal() → penny/signals (T2, 7-day expiry)     │
│                         ↓                                           │
│  Penny session start → get_pending_signals()                       │
│                         ↓                                           │
│  CRITICAL signals presented first → user action required           │
│  INFO signals mentioned briefly → user acknowledges or dismisses   │
│                         ↓                                           │
│              acknowledge_signal(signal_id) → status=ACKNOWLEDGED   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How to Use

### Check signals manually

```bash
cd /path/to/penny
source .venv/bin/activate
python scripts/system/watchers/session_start_checker.py
```

Returns JSON with `generated`, `pending.critical`, `pending.info`, and a
`presentation` markdown string.

### Generate signals from your own script

```python
from scripts.watchers.signal_generators import (
    generate_mismatch_rate_signal,
    write_signal,
)

sig = generate_mismatch_rate_signal("my-session-id")
if sig:
    write_signal(sig)
```

### Acknowledge a signal

```python
from scripts.watchers.signal_generators import acknowledge_signal
acknowledge_signal("signal_2026-04-28_001_mismatch_rate", "my-session")
```

---

## Watcher Types

| Watcher          | Trigger                                   | Priority      | Status  |
| ---------------- | ----------------------------------------- | ------------- | ------- |
| MISMATCH rate    | >3 MISMATCH outcomes in 7 days            | CRITICAL/INFO | ✅      |
| Confidence trend | >50% actions at POSSIBLE/UNCERTAIN        | INFO          | ✅      |
| Mempalace growth | >500 drawers in `penny` wing              | INFO          | ✅      |
| Task staleness   | PARTIAL/MISMATCH with no follow-up        | CRITICAL/INFO | ✅      |
| Config drift     | `.env` or `SYSTEM.md` modified externally | —             | ⏳ Stub |
| Test failure     | pytest returns non-zero                   | —             | ⏳ Stub |
| Project dormancy | >14 days since last session               | —             | ⏳ Stub |

---

## Signal Schema

All signals follow the same schema (defined in `penny/signals` room):

| Field              | Required | Description                          |
| ------------------ | -------- | ------------------------------------ |
| `signal_id`        | Yes      | `signal_YYYY-MM-DD_NNN_source`       |
| `signal_type`      | Yes      | `TIME`, `FILE`, or `METRIC`          |
| `source`           | Yes      | Which watcher generated it           |
| `priority`         | Yes      | `CRITICAL` or `INFO`                 |
| `title`            | Yes      | ≤80 chars                            |
| `context`          | No       | Supporting detail                    |
| `suggested_action` | No       | What to do about it                  |
| `timestamp`        | Yes      | ISO-8601                             |
| `expires`          | Yes      | ISO-8601 (+7 days default)           |
| `status`           | Yes      | `PENDING`, `ACKNOWLEDGED`, `EXPIRED` |

---

## Files

| Path                                                | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `scripts/system/watchers/signal_generators.py`      | Core library: signal generation, writing, acknowledgment |
| `scripts/system/watchers/session_start_checker.py`  | CLI: retrieve and format pending signals                 |
| `scripts/system/watchers/test_signal_generators.py` | Unit tests (19 tests)                                    |
| `scripts/system/watchers/test_e2e_signals.py`       | E2E tests (3 tests)                                      |
| `penny/signals` (room)                              | Signal storage (T2, 7-day expiry)                        |

---

## Scheduling

Ambient watchers run **twice daily** (09:00 and 18:00) via cron:

```bash
crontab -l
# Penny Ambient Watchers — generate signals twice daily
0 9 * * * cd /path/to/penny && bash scripts/system/watchers/ambient_cron.sh
0 18 * * * cd /path/to/penny && bash scripts/system/watchers/ambient_cron.sh
```

Cron job logs to `logs/ambient-watchers.log`.

## Constraints

1. **Signal generation is metric-only** — File-based watchers (config drift,
   test failures, new untracked files) remain Phase 2 stubs.
   Time-based dormancy watcher also remains a stub pending diary/sessions
   room maturity.
2. **index.ts integration deferred** — The skill extension doesn't yet
   auto-check signals before invoking planning agents. This is covered by
   `SYSTEM.md` Rule 8, which Penny must follow manually.
3. **TS questionnaire deferred** — Signal acknowledgment in the Pi UI layer
   is handled via Python `acknowledge_signal()`; a TS wrapper could improve UX.
4. **File watchers are stubs** — Config drift and test failure watchers are
   placeholder functions for future Phase 2 work.

---

## Safety

- All watchers are **read-only** until `write_signal()` is called
- Deduplication via `check_duplicate` prevents signal spam
- T2 expiry auto-deletes old signals (7 days)
- No auto-execution: every signal requires explicit acknowledgment
