#!/usr/bin/env bash
# Supervised MemPalace hub interface. Setup never discovers, initializes,
# migrates, deletes, or opens a palace. Every operation requires a caller-owned
# absolute hub config and delegates to the portable supervisor command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PYTHON="${PROJECT_ROOT}/.venv/bin/python"

usage() {
    cat <<'EOF'
Memory hub setup is explicit and non-destructive.

Usage:
  scripts/setup/init-memory.sh command    --config /absolute/hub.json
  scripts/setup/init-memory.sh foreground --config /absolute/hub.json
  scripts/setup/init-memory.sh health     --config /absolute/hub.json
  scripts/setup/init-memory.sh status     --config /absolute/hub.json
  scripts/setup/init-memory.sh stop       --config /absolute/hub.json

Create caller-specific configs from scripts/setup/mempalace-hub.config.json.in.
No command in this script creates or deletes memory data.
EOF
}

# Memory is core and enabled by default, but ownership is never guessed. A
# no-argument call is therefore an action-required result, not setup success.
if [[ $# -eq 0 ]]; then
    usage >&2
    printf 'ACTION_REQUIRED: supply an explicit operation and absolute caller-owned hub config\n' >&2
    exit 1
fi

if [[ $# -ne 3 || "$2" != "--config" ]]; then
    usage >&2
    exit 2
fi

operation="$1"
config="$3"
case "$operation" in
    command|foreground|health|status|stop) ;;
    *)
        printf 'ERROR: unsupported supervised-hub operation: %s\n' "$operation" >&2
        usage >&2
        exit 2
        ;;
esac

if [[ "$config" != /* ]]; then
    printf 'ERROR: --config must be an explicit absolute path\n' >&2
    exit 2
fi
if [[ ! -x "$PYTHON" ]]; then
    printf 'ERROR: venv Python not found: %s\n' "$PYTHON" >&2
    exit 1
fi

cd "$PROJECT_ROOT"
exec "$PYTHON" -m scripts.system.memory.hub_service "$operation" --config "$config"
