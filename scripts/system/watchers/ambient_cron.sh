#!/bin/bash
# Ambient Watchers — Cron Runner
# Runs all metric watchers and writes signals to penny/signals room.
# Schedule: daily at 09:00 and 18:00 via user crontab.
# Logs are sent to the Penny observability server (not to a local file).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VENV_BIN="${PROJECT_ROOT}/.venv/bin/python"
SCRIPT="${PROJECT_ROOT}/scripts/system/watchers/signal_generators.py"

# Source project environment so watcher_logger.py can find the observability server
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    export $(grep -v '^#' "${PROJECT_ROOT}/.env" | xargs) 2>/dev/null || true
fi

if [[ ! -x "$VENV_BIN" ]]; then
    echo "ERROR: venv Python not found at $VENV_BIN" >&2
    exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
    echo "ERROR: signal_generators.py not found at $SCRIPT" >&2
    exit 1
fi

# Run watchers; capture JSON output on stdout for any downstream consumers
cd "$PROJECT_ROOT"
"$VENV_BIN" "$SCRIPT" cron_session_$(date +%Y%m%d_%H%M%S)
SIGNAL_EXIT=$?

# Run tiered memory archiver (T2→T4 TTL sweeps)
ARCHIVER="${PROJECT_ROOT}/scripts/system/tiered_memory/archiver.py"
if [[ -f "$ARCHIVER" ]]; then
    "$VENV_BIN" "$ARCHIVER" || true  # Don't fail cron if archiver fails
fi

# Run the eval & regression suite. On regression it writes a CRITICAL signal to
# penny/signals, which the session-start brief surfaces — so a seam dying shows
# up in the next session instead of rotting silently in a log.
EVALS="${PROJECT_ROOT}/scripts/system/evals/run_evals.py"
if [[ -f "$EVALS" ]]; then
    "$VENV_BIN" "$EVALS" --quiet --signal-on-regression || true  # advisory, never fails cron
fi

EXIT_CODE=$SIGNAL_EXIT

exit $EXIT_CODE
