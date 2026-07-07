#!/bin/bash
# Initialize MemPalace for Penny
# This script sets up the memory palace structure for the Penny project

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV_PATH="$PROJECT_ROOT/.venv"
MEMPALACE_PATH="$PROJECT_ROOT/.mempalace"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Penny Memory Initialization ===${NC}"
echo ""

# Check if virtual environment exists
if [ ! -d "$VENV_PATH" ]; then
    echo -e "${YELLOW}Virtual environment not found. Run 'make venv' or 'uv venv .venv' first.${NC}"
    exit 1
fi

# Activate virtual environment
source "$VENV_PATH/bin/activate"

# Sync dependencies (idempotent — skips if already installed)
echo -e "${YELLOW}Syncing Python dependencies...${NC}"
cd "$PROJECT_ROOT" && uv sync --extra dev

# Verify mempalace is installed
if ! python -c "import mempalace" 2>/dev/null; then
    echo -e "${RED}Error: mempalace not installed. Run 'make install-py' or 'uv sync --extra dev'.${NC}"
    exit 1
fi

# Check if the bridge file exists
BRIDGE_PATH="$PROJECT_ROOT/scripts/system/bridge/memory_bridge.py"
if [ ! -f "$BRIDGE_PATH" ]; then
    echo -e "${RED}Error: memory_bridge.py not found at $BRIDGE_PATH${NC}"
    echo "Please ensure the project is properly set up."
    exit 1
fi

# Initialize MemPalace
echo -e "${GREEN}Initializing MemPalace...${NC}"

# Create palace directory if it doesn't exist
if [ ! -d "$MEMPALACE_PATH" ]; then
    echo -e "${YELLOW}Creating palace directory at $MEMPALACE_PATH${NC}"
    mkdir -p "$MEMPALACE_PATH"
fi

# Create config
CONFIG_FILE="$HOME/.mempalace/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}Creating MemPalace config...${NC}"
    mkdir -p "$HOME/.mempalace"
    cat > "$CONFIG_FILE" << EOF
{
  "palace_path": "$MEMPALACE_PATH",
  "collection_name": "mempalace_drawers"
}
EOF
fi

# Create identity file
IDENTITY_FILE="$HOME/.mempalace/identity.txt"
if [ ! -f "$IDENTITY_FILE" ]; then
    echo -e "${YELLOW}Creating identity file...${NC}"
    cat > "$IDENTITY_FILE" << EOF
Penny - Personal AI Assistant
Purpose: Help users with coding, research, and knowledge management
Memory: MemPalace v3.0.0 (ChromaDB + Knowledge Graph)
EOF
fi

# Create wing config
WING_CONFIG="$HOME/.mempalace/wing_config.json"
if [ ! -f "$WING_CONFIG" ]; then
    echo -e "${YELLOW}Creating wing config...${NC}"
    cat > "$WING_CONFIG" << EOF
{
  "default_wing": "penny",
  "wings": {
    "penny": {
      "type": "project",
      "keywords": ["penny", "assistant", "memory", "extension", "pi"]
    },
    "user": {
      "type": "person",
      "keywords": ["user", "i", "me", "my", "mine"]
    },
    "decisions": {
      "type": "topic",
      "keywords": ["decision", "chose", "selected", "agreed"]
    },
    "code": {
      "type": "topic",
      "keywords": ["code", "function", "class", "module", "refactor"]
    },
    "architecture": {
      "type": "topic",
      "keywords": ["architecture", "design", "structure", "pattern"]
    }
  }
}
EOF
fi

# Test the bridge
echo -e "${GREEN}Testing memory bridge...${NC}"
TEST_RESULT=$(echo '{"tool": "status", "params": {}}' | python "$BRIDGE_PATH" 2>&1)
if echo "$TEST_RESULT" | grep -q '"success"'; then
    echo -e "${GREEN}✓ Memory bridge is working${NC}"
elif echo "$TEST_RESULT" | grep -q '"No palace found"'; then
    echo -e "${YELLOW}⚠ No palace found - run 'mempalace init' to create one${NC}"
    echo -e "${YELLOW}  Running mempalace init $PROJECT_ROOT...${NC}"
    mempalace init "$PROJECT_ROOT" --palace "$MEMPALACE_PATH" 2>/dev/null || true
else
    echo -e "${RED}✗ Memory bridge test failed${NC}"
    echo "$TEST_RESULT"
    exit 1
fi

echo ""
echo -e "${GREEN}=== Initialization Complete ===${NC}"
echo ""
echo "Memory Extension Configuration:"
echo "  - Palace path: $MEMPALACE_PATH"
echo "  - Bridge script: $BRIDGE_PATH"
echo "  - Python: $VENV_PATH/bin/python"
echo ""
echo "Available wings:"
echo "  - penny (project)"
echo "  - user (person)"
echo "  - decisions (topic)"  
echo "  - code (topic)"
echo "  - architecture (topic)"
echo ""
echo "Next steps:"
echo "  1. Restart Penny to load the memory extension"
echo "  2. Use 'memory_status' to check palace status"
echo "  3. Use 'memory_search' to find information"
echo "  4. Use 'memory_add_drawer' to store new memories"