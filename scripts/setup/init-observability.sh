#!/bin/bash
# Initialize the Penny Observability Backend (Python).
#
# The observability server runs as a plain Python process (`python -m observability`),
# auto-started by the Pi observability extension when Pi launches. This script prepares the
# environment: it syncs dependencies, verifies the imports, and ensures the data directory
# exists. (There is no Docker deployment — observability is Python-only.)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV_PATH="$PROJECT_ROOT/.venv"
OBS_DIR="$PROJECT_ROOT/apps/observability"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== Penny Observability Backend Setup (Python) ===${NC}"
echo ""

# Check that the observability backend exists
if [ ! -d "$OBS_DIR" ]; then
    echo -e "${RED}Error: observability backend not found at $OBS_DIR${NC}"
    exit 1
fi

if ! command -v uv > /dev/null 2>&1; then
    echo -e "${RED}Error: 'uv' command not found${NC}"
    exit 1
fi

if [ ! -d "$VENV_PATH" ]; then
    echo -e "${RED}Virtual environment not found. Run 'make venv' or 'uv venv .venv' first.${NC}"
    exit 1
fi

source "$VENV_PATH/bin/activate"

echo -e "${YELLOW}Syncing Python dependencies...${NC}"
cd "$PROJECT_ROOT" && uv sync --extra dev

echo -e "${YELLOW}Verifying dependencies...${NC}"
DEPS_OK=true
for pkg in fastapi uvicorn aiosqlite dotenv pydantic apscheduler; do
    if python -c "import $pkg" 2>/dev/null; then
        echo -e "${GREEN}  ✓ $pkg${NC}"
    else
        echo -e "${RED}  ✗ $pkg NOT FOUND${NC}"
        DEPS_OK=false
    fi
done

if [ "$DEPS_OK" = false ]; then
    echo -e "${RED}✗ Some dependencies are missing. Run 'make install-py' or 'uv sync --extra dev'.${NC}"
    exit 1
fi

if python -c "from observability.main import app; print('OK')" 2>/dev/null; then
    echo -e "${GREEN}✓ Observability imports verified${NC}"
else
    echo -e "${RED}✗ Import verification failed. Run 'make install-py' or 'uv sync --extra dev'.${NC}"
    exit 1
fi

DATA_DIR="${PI_OBSERVABILITY_DATA_DIR:-$HOME/.local/share/penny/observability}"
mkdir -p "$DATA_DIR"

# NOTE: no systemd/cron cleanup timer is installed. The observability server bounds its own
# DB in-process via size-based rotation (startup + periodic interval); see
# apps/observability/src/observability/scheduler.py. For manual, out-of-band maintenance run
# scripts/system/observability/cleanup_db.py.

echo ""
echo -e "${GREEN}=== Observability Setup Complete (Python) ===${NC}"
echo ""
echo "Data directory: $DATA_DIR"
echo "The Pi observability extension auto-starts the server when Pi launches."
echo "To run it manually:"
echo "  cd $PROJECT_ROOT && python -m observability"
