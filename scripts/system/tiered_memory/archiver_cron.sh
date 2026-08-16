#!/usr/bin/env bash
# Explicit supervised-hub retention entrypoint. It never discovers a palace and
# remains a dry-run unless PENNY_MEMORY_RETENTION_APPLY is exactly "1".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PYTHON="${PROJECT_ROOT}/.venv/bin/python"

: "${PENNY_MEMORY_HUB_CONFIG:?set an absolute supervised-hub config path}"
: "${PENNY_MEMORY_RETENTION_MANIFEST:?set a new/reviewed absolute manifest path}"

if [[ ! -x "$PYTHON" ]]; then
    printf 'ERROR: venv Python not found: %s\n' "$PYTHON" >&2
    exit 1
fi

args=(
    -m scripts.system.tiered_memory.archiver
    --config "$PENNY_MEMORY_HUB_CONFIG"
    --manifest "$PENNY_MEMORY_RETENTION_MANIFEST"
)
if [[ "${PENNY_MEMORY_RETENTION_APPLY:-0}" == "1" ]]; then
    : "${PENNY_MEMORY_RETENTION_JOURNAL:?set a new absolute journal path for apply}"
    args+=(--apply --journal "$PENNY_MEMORY_RETENTION_JOURNAL")
fi

cd "$PROJECT_ROOT"
exec "$PYTHON" "${args[@]}"
