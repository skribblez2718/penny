#!/usr/bin/env bash
# Tiered-memory archiver cron entry.
#
# Runs the T2 scratch archiver on its own schedule. (Previously invoked from a
# shared cron script that hosted several since-removed jobs; this preserves the
# archiver's existing scheduled behavior with no other responsibilities.)
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VENV_BIN="${PROJECT_ROOT}/.venv/bin/python"
ARCHIVER="${SCRIPT_DIR}/archiver.py"

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    export $(grep -v '^#' "${PROJECT_ROOT}/.env" | xargs) 2>/dev/null || true
fi

if [[ ! -x "$VENV_BIN" ]]; then
    echo "ERROR: venv Python not found at $VENV_BIN" >&2
    exit 1
fi

cd "$PROJECT_ROOT"
exec "$VENV_BIN" "$ARCHIVER"
