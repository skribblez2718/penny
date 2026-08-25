#!/bin/bash
# Build target-only orchestration and optionally perform explicit fresh-state setup.
# This script never opens, imports, or creates project-local/XDG legacy state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$PROJECT_ROOT/apps/orchestration"

bun run --cwd "$APP" typecheck
bun run --cwd "$APP" build

STATE_CLI="$APP/dist/state-cli.js"
if node "$STATE_CLI" status --project-root="$PROJECT_ROOT" >/dev/null 2>&1; then
    node "$STATE_CLI" status --project-root="$PROJECT_ROOT"
    exit 0
fi

if [ "${PENNY_SETUP_INITIALIZE_STATE:-}" = "1" ]; then
    node "$STATE_CLI" init --project-root="$PROJECT_ROOT"
    node "$STATE_CLI" status --project-root="$PROJECT_ROOT"
    exit 0
fi

echo "Orchestration build is ready, but Penny state is not initialized."
echo "For a brand-new project with no state to preserve, run:"
echo "  PENNY_SETUP_INITIALIZE_STATE=1 bash scripts/setup/init-orchestration.sh"
echo "For an existing project, use the explicit migrate plan/apply/verify/finalize flow."
