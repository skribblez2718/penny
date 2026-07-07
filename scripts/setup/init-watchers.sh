#!/bin/bash
# Initialize Penny Ambient Watchers, Self-Improvement, and Weekly Digest Cron Jobs
#
# Wires up three periodic background features:
#   1. Ambient watchers — runs ambient_cron.sh twice daily (09:00, 18:00)
#   2. Self-improvement compression — runs run_compression.py daily at 23:00
#   3. Weekly digest — runs run_digest.py every Monday at 08:00
#
# The cron block is guarded by PENNY_WATCHERS markers so re-running is idempotent.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

VENV_PATH="$PROJECT_ROOT/.venv"
VENV_BIN="$VENV_PATH/bin/python"

AMBIENT_CRON="$PROJECT_ROOT/scripts/system/watchers/ambient_cron.sh"
RUN_COMPRESSION="$PROJECT_ROOT/scripts/system/self_improve/run_compression.py"
RUN_DIGEST="$PROJECT_ROOT/scripts/system/digest/run_digest.py"

# Marker comments used to identify (and skip) already-installed entries.
CRON_MARKER_BEGIN="# PENNY_WATCHERS_BEGIN"
CRON_MARKER_END="# PENNY_WATCHERS_END"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[1;34m'
NC='\033[0m'

echo -e "${GREEN}=== Penny Watchers, Compression & Digest Cron Setup ===${NC}"
echo ""

# Source project environment so runner scripts can read palace/observability config.
if [[ -f "$PROJECT_ROOT/.env" ]]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs) 2>/dev/null || true
fi

# ── Verify Python environment ─────────────────────────────────────────────

if [[ ! -x "$VENV_BIN" ]]; then
    echo -e "${RED}Error: venv Python not found at $VENV_BIN${NC}"
    echo "Run 'make venv' or 'uv venv .venv' first."
    exit 1
fi

echo -e "${GREEN}✓ Python venv ready: $VENV_BIN${NC}"

# ── Make ambient cron executable ──────────────────────────────────────────

if [[ ! -f "$AMBIENT_CRON" ]]; then
    echo -e "${RED}Error: ambient_cron.sh not found at $AMBIENT_CRON${NC}"
    exit 1
fi

chmod +x "$AMBIENT_CRON"
echo -e "${GREEN}✓ Made ambient_cron.sh executable${NC}"

# ── Verify Python runner scripts exist ────────────────────────────────────

for script in "$RUN_COMPRESSION" "$RUN_DIGEST"; do
    if [[ ! -f "$script" ]]; then
        echo -e "${RED}Error: runner script not found at $script${NC}"
        exit 1
    fi
done

echo -e "${GREEN}✓ Runner scripts found${NC}"

# ── Verify crontab is available ───────────────────────────────────────────

if ! command -v crontab > /dev/null 2>&1; then
    echo -e "${RED}Error: crontab command not found; cannot install cron entries${NC}"
    echo "Install cron and re-run this script to enable periodic features."
    exit 1
fi

# ── Check for existing PENNY cron entries ─────────────────────────────────

existing_crontab="$(crontab -l 2>/dev/null || true)"

if echo "$existing_crontab" | grep -q "$CRON_MARKER_BEGIN"; then
    echo -e "${YELLOW}✓ Penny watcher cron entries already installed; skipping${NC}"
    echo ""
    echo -e "${GREEN}=== Watchers Cron Setup Complete ===${NC}"
    echo ""
    echo "To review the installed jobs, run: crontab -l"
    exit 0
fi

# ── Build and install cron block ──────────────────────────────────────────

cron_block=$(cat <<EOF

$CRON_MARKER_BEGIN
# Penny ambient watchers — runs all metric watchers twice daily.
0 9,18 * * * cd "$PROJECT_ROOT" && "$AMBIENT_CRON" >> /tmp/penny_ambient_watchers.log 2>&1
# Penny self-improvement compression — propose amendments from recent outcomes.
0 23 * * * cd "$PROJECT_ROOT" && "$VENV_BIN" "$RUN_COMPRESSION" >> /tmp/penny_compression.log 2>&1
# Penny weekly digest — render and store last week's summary.
0 8 * * 1 cd "$PROJECT_ROOT" && "$VENV_BIN" "$RUN_DIGEST" > /tmp/penny_weekly_digest.md 2>> /tmp/penny_weekly_digest.log
$CRON_MARKER_END
EOF
)

new_crontab="${existing_crontab}${cron_block}"

if printf '%s\n' "$new_crontab" | crontab -; then
    echo -e "${GREEN}✓ Installed Penny watcher cron entries${NC}"
else
    echo -e "${RED}✗ Failed to install cron entries${NC}"
    exit 1
fi

# ── Summary ───────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}=== Watchers Cron Setup Complete ===${NC}"
echo ""
echo "Installed cron jobs:"
echo "  • Ambient watchers     : 09:00, 18:00 daily  → $AMBIENT_CRON"
echo "  • Compression loop     : 23:00 daily           → $RUN_COMPRESSION"
echo "  • Weekly digest        : 08:00 Mondays       → $RUN_DIGEST"
echo ""
echo "Log files:"
echo "  • /tmp/penny_ambient_watchers.log"
echo "  • /tmp/penny_compression.log"
echo "  • /tmp/penny_weekly_digest.md (rendered digest)"
echo "  • /tmp/penny_weekly_digest.log (errors)"
echo ""
echo "To review or edit: crontab -l"
echo ""
