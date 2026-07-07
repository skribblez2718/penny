#!/bin/bash
# Initialize Penny Observability Backend
# Prefers Docker. Falls back to Python if Docker is not available.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV_PATH="$PROJECT_ROOT/.venv"
OBS_DIR="$PROJECT_ROOT/apps/observability"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[1;34m'
NC='\033[0m'

echo -e "${GREEN}=== Penny Observability Backend Setup ===${NC}"
echo ""

# Check that the observability backend exists
if [ ! -d "$OBS_DIR" ]; then
    echo -e "${RED}Error: observability backend not found at $OBS_DIR${NC}"
    exit 1
fi

# ── Docker path (preferred) ──────────────────────────────────────────────

if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
    echo -e "${BLUE}Docker detected — using containerized observability backend.${NC}"
    echo ""

    # Build the image
    echo -e "${YELLOW}Building observability Docker image...${NC}"
    cd "$PROJECT_ROOT"
    if docker build -t penny-observability -f apps/observability/Dockerfile .; then
        echo -e "${GREEN}✓ Docker image built${NC}"
    else
        echo -e "${RED}✗ Docker build failed${NC}"
        exit 1
    fi

    # Create data directory for volume mount
    DATA_DIR="${PI_OBSERVABILITY_DATA_DIR:-$HOME/.local/share/penny/observability}"
    mkdir -p "$DATA_DIR"

    # Stop and remove any existing container
    docker stop penny-observability 2>/dev/null || true
    docker rm penny-observability 2>/dev/null || true

    # Start the container
    echo -e "${YELLOW}Starting observability container...${NC}"
    if docker run -d --name penny-observability \
        -p 8765:8765 \
        -v "$DATA_DIR:/data" \
        -v "$PROJECT_ROOT/.env:/app/.env:ro" \
        -e PI_OBSERVABILITY_DATA_DIR=/data \
        --restart unless-stopped \
        penny-observability; then
        echo -e "${GREEN}✓ Container started${NC}"
    else
        echo -e "${RED}✗ Container failed to start${NC}"
        exit 1
    fi

    # Wait for health check
    echo -e "${YELLOW}Waiting for health check...${NC}"
    for i in $(seq 1 10); do
        if curl -s http://localhost:8765/health > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Observability backend is healthy${NC}"
            break
        fi
        sleep 1
    done

    echo ""
    echo -e "${GREEN}=== Observability Setup Complete (Docker) ===${NC}"
    echo ""
    echo "Container: penny-observability"
    echo "Data directory: $DATA_DIR"
    echo ""
    echo "Manage with:"
    echo "  make docker-down   — stop container"
    echo "  make docker-up     — restart container"
    echo "  docker logs penny-observability  — view logs"
    exit 0
fi

# ── Python fallback ─────────────────────────────────────────────────────

echo -e "${YELLOW}Docker not available — using Python backend.${NC}"
echo ""

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
for pkg in fastapi uvicorn aiosqlite python-dotenv pydantic apscheduler; do
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

# Install systemd timer for daily database cleanup
if command -v systemctl > /dev/null 2>&1 && systemctl --user > /dev/null 2>&1; then
    echo -e "${YELLOW}Installing systemd cleanup timer...${NC}"
    SYSTEMD_SRC="$PROJECT_ROOT/scripts/system/observability"
    USER_SYSTEMD="$HOME/.config/systemd/user"
    mkdir -p "$USER_SYSTEMD"

    for unit in penny-observability-cleanup.service penny-observability-cleanup.timer; do
        sed -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
            "$SYSTEMD_SRC/$unit" > "$USER_SYSTEMD/$unit"
    done

    systemctl --user daemon-reload
    systemctl --user enable penny-observability-cleanup.timer
    systemctl --user start penny-observability-cleanup.timer
    echo -e "${GREEN}✓ Cleanup timer installed (runs daily)${NC}"
else
    echo -e "${YELLOW}systemd not available — skipping cleanup timer${NC}"
fi

echo ""
echo -e "${GREEN}=== Observability Setup Complete (Python) ===${NC}"
echo ""
echo "Data directory: $DATA_DIR"
echo "To start the server:"
echo "  cd $PROJECT_ROOT && python -m observability"
echo ""
echo "The Pi observability extension will auto-start the server when Pi launches."
