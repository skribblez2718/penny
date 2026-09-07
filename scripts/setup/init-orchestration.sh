#!/usr/bin/env bash
# Build or inspect Penny's canonical TypeScript orchestration runtime.
# Status is create-never. Fresh initialization is exposed only as an explicit
# operation and retains the canonical initializer's custody checks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$PROJECT_ROOT/apps/orchestration"
STATE_CLI="$APP/dist/state-cli.js"

usage() {
    cat <<'EOF'
Usage:
  scripts/setup/init-orchestration.sh build
  scripts/setup/init-orchestration.sh status
  scripts/setup/init-orchestration.sh fresh

`status` never creates or repairs state. `fresh` is explicit authorization to
run the guarded fresh-state initializer; retained/incomplete state still fails
closed and must use the documented migration or recovery flow.
EOF
}

operation="${1:-}"
case "$operation" in
    build)
        bun run --cwd "$APP" build
        echo "TypeScript orchestration build is ready."
        ;;
    status)
        if [[ ! -r "$STATE_CLI" ]]; then
            echo "ERROR: orchestration state CLI is not built: $STATE_CLI" >&2
            exit 1
        fi
        exec node "$STATE_CLI" status --project-root="$PROJECT_ROOT"
        ;;
    fresh)
        if [[ ! -r "$STATE_CLI" ]]; then
            echo "ERROR: orchestration state CLI is not built: $STATE_CLI" >&2
            exit 1
        fi
        node "$STATE_CLI" init --project-root="$PROJECT_ROOT"
        exec node "$STATE_CLI" status --project-root="$PROJECT_ROOT"
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
