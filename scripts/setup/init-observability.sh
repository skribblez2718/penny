#!/usr/bin/env bash
# Build the canonical TypeScript observability service after orchestration.
# State creation and service readiness belong to the explicit setup doctor.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OBS_DIR="$PROJECT_ROOT/apps/observability"
ORCHESTRATION_DIST="$PROJECT_ROOT/apps/orchestration/dist/index.js"

if [[ ! -r "$ORCHESTRATION_DIST" ]]; then
    echo "ERROR: build orchestration before observability: $ORCHESTRATION_DIST" >&2
    exit 1
fi
if [[ ! -f "$OBS_DIR/package.json" ]]; then
    echo "ERROR: TypeScript observability package is missing: $OBS_DIR" >&2
    exit 1
fi

bun run --cwd "$OBS_DIR" build:local
bun run --cwd "$OBS_DIR" verify:runtime-builds

echo "TypeScript observability build is ready."
