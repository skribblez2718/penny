#!/bin/bash
# Build the canonical TypeScript observability service.
# State is created only by explicit penny-state setup or migration; this script
# never initializes a catalog or imports the retired Python database.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OBS_DIR="$PROJECT_ROOT/apps/observability"

if [ ! -f "$OBS_DIR/package.json" ]; then
    echo "Error: TypeScript observability package is missing: $OBS_DIR" >&2
    exit 1
fi

bun run --cwd "$OBS_DIR" typecheck
bun run --cwd "$OBS_DIR" build

echo "TypeScript observability build is ready."
echo "After explicit state initialization/migration, run:"
echo "  bun run --cwd \"$OBS_DIR\" start"
echo "The Pi extension may auto-start the same built service on session_start."
