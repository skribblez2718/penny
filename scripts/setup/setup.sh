#!/bin/bash
# Penny Setup — Master initialization script
#
# Usage:
#   cd /path/to/penny
#   bash scripts/setup/setup.sh
#
# Runs every init-*.sh script in scripts/setup/ to set up all Penny features.
# Each feature has its own isolated setup script so they can also be run
# independently.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[1;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Penny Project Setup${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Project root: $PROJECT_ROOT"
echo ""

# Discover setup scripts
declare -a SETUP_SCRIPTS=()
for script in "$SCRIPT_DIR"/init-*.sh; do
    [ -f "$script" ] && SETUP_SCRIPTS+=("$script")
done

if [ ${#SETUP_SCRIPTS[@]} -eq 0 ]; then
    echo -e "${YELLOW}No setup scripts found in $SCRIPT_DIR${NC}"
    echo "Expected: init-*.sh files"
    exit 1
fi

echo "Found ${#SETUP_SCRIPTS[@]} setup script(s):"
for script in "${SETUP_SCRIPTS[@]}"; do
    echo "  - $(basename "$script")"
done
echo ""

# Track results
declare -i TOTAL=0
declare -i PASSED=0

for script in "${SETUP_SCRIPTS[@]}"; do
    name=$(basename "$script")
    echo -e "${BLUE}────────────────────────────────────────────────────────────${NC}"
    echo -e "${YELLOW}▶ Running: $name${NC}"
    echo ""
    TOTAL+=1

    if bash "$script"; then
        echo ""
        echo -e "${GREEN}✓ $name completed${NC}"
        PASSED+=1
    else
        echo ""
        echo -e "${RED}✗ $name FAILED (exit code $?)${NC}"
        echo "  Continuing with remaining scripts..."
    fi
    echo ""
done

# Summary
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Setup Summary${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "${GREEN}Completed: $PASSED / $TOTAL${NC}"

if [ $PASSED -eq $TOTAL ]; then
    echo ""
    echo -e "${GREEN}All setup scripts completed successfully.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Start Pi in the project directory"
    echo "  2. The observability server will auto-start"
    echo "  3. Check health: curl http://localhost:8765/health"
else
    echo ""
    echo -e "${YELLOW}Some setup scripts failed. Review the output above.${NC}"
fi

echo ""
