#!/usr/bin/env bash
# Provision the optional Playwright Chromium binary selected by bun.lock.
# Default `make setup` never invokes this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLAYWRIGHT_BIN="$PROJECT_ROOT/node_modules/.bin/playwright"
DRY_RUN=false

usage() {
    cat <<'EOF'
Usage:
  scripts/setup/init-external-tools.sh [--dry-run]

Installs the optional Chromium browser through the repository-local Playwright
executable. It never invokes `playwright install-deps` or a dynamic bunx package.
EOF
}

for argument in "$@"; do
    case "$argument" in
        --dry-run) DRY_RUN=true ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: unknown option: $argument" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ ! -x "$PLAYWRIGHT_BIN" ]]; then
    echo "ERROR: lockfile-installed Playwright executable is absent: $PLAYWRIGHT_BIN" >&2
    echo "Run the frozen JavaScript install before setup-browser." >&2
    exit 1
fi

if [[ "$DRY_RUN" == true ]]; then
    printf 'Would run repository-local Playwright: %s install chromium\n' "$PLAYWRIGHT_BIN"
    exit 0
fi

"$PLAYWRIGHT_BIN" install chromium
printf 'Optional Playwright Chromium is ready.\n'
printf 'System browser libraries are never installed automatically; use the documented host procedure if required.\n'
