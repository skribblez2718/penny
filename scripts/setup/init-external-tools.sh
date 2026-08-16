#!/bin/bash
# Provision external runtime dependencies used by Penny's retained extensions.
#
# Usage:
#   bash scripts/setup/init-external-tools.sh
#   bash scripts/setup/init-external-tools.sh --skip-playwright
#
# This script is idempotent. Use --dry-run to inspect the provisioning command.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[1;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
skip() { echo -e "  ${GRAY}⏭${NC} $1"; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

SKIP_PLAYWRIGHT=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --skip-playwright) SKIP_PLAYWRIGHT=true ;;
        --dry-run) DRY_RUN=true ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

declare -i PASSED=0
declare -i FAILED=0
declare -i SKIPPED=0

echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Penny External Tools Setup${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Project root: $PROJECT_ROOT"
[ "$DRY_RUN" = true ] && echo -e "${YELLOW}  DRY RUN — no changes will be made${NC}"
echo ""

if [ "$SKIP_PLAYWRIGHT" = true ]; then
    skip "Playwright browsers — --skip-playwright active"
    SKIPPED+=1
elif ! have_cmd bun; then
    fail "Bun is not installed (required to provision Playwright Chromium)"
    echo "    Install: curl -fsSL https://bun.sh/install | bash"
    FAILED+=1
else
    ok "Bun $(bun --version 2>/dev/null || echo '?')"
    PASSED+=1

    echo ""
    echo -e "${BLUE}── Playwright Browsers ──${NC}"
    echo ""

    if (cd "$PROJECT_ROOT" && bunx playwright install --dry-run chromium 2>/dev/null) | grep -q "is already installed"; then
        ok "Playwright Chromium already installed"
        PASSED+=1
    elif [ "$DRY_RUN" = true ]; then
        info "[DRY RUN] cd $PROJECT_ROOT && bunx playwright install chromium"
        PASSED+=1
    else
        info "Installing Playwright Chromium..."
        if (cd "$PROJECT_ROOT" && bunx playwright install chromium 2>&1); then
            ok "Playwright Chromium installed"
            PASSED+=1
        else
            fail "Playwright Chromium install failed"
            echo "    Manual: cd $PROJECT_ROOT && bunx playwright install chromium"
            echo "    System deps: cd $PROJECT_ROOT && bunx playwright install-deps chromium"
            FAILED+=1
        fi
    fi
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Setup Summary${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

TOTAL=$((PASSED + FAILED + SKIPPED))
echo "  Passed:  $PASSED / $TOTAL"
[ "$FAILED" -gt 0 ] && echo -e "  ${RED}Failed:  $FAILED / $TOTAL${NC}"
[ "$SKIPPED" -gt 0 ] && echo -e "  ${YELLOW}Skipped: $SKIPPED / $TOTAL${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
    echo -e "${YELLOW}Some external dependencies failed to provision. Review the output above.${NC}"
    exit 1
fi

echo -e "${GREEN}All selected external dependencies are ready.${NC}"
