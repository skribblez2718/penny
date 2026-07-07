#!/usr/bin/env bash
# init-joern.sh — Build the Joern Docker image used by the jsa skill.
#
# Joern is a CORE dependency of the jsa skill's SLICE phase (interprocedural
# data-flow / CPG analysis). jsa invokes it through a Docker image named
# "jsa-joern" (see .pi/skills/jsa/scripts/joern_integration.py: DOCKER_IMAGE).
# This script builds that image from the skill's Dockerfile.joern.
#
# Behaviour:
#   - Idempotent: skips the build if the image already exists (override with
#     JOERN_FORCE_REBUILD=1).
#   - Graceful: if Docker is not installed or the daemon is not running, it
#     warns and exits 0 so `make setup` continues; jsa degrades to a non-Joern
#     mode at runtime. CI without Docker therefore still completes setup.
#   - All paths resolved dynamically — never hardcoded.
#
# Run standalone:  bash scripts/setup/init-joern.sh
# Force rebuild:    JOERN_FORCE_REBUILD=1 bash scripts/setup/init-joern.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[1;34m'; NC='\033[0m'

IMAGE_NAME="jsa-joern"
DOCKERFILE="$PROJECT_ROOT/.pi/skills/jsa/Dockerfile.joern"

echo -e "${BLUE}Joern image setup (jsa skill core dependency)${NC}"
echo "  Image:      $IMAGE_NAME"
echo "  Dockerfile: $DOCKERFILE"

# The image name MUST match jsa's joern_integration.DOCKER_IMAGE. Verify so a
# rename there can't silently leave setup building the wrong tag.
EXPECTED_IMAGE="$(grep -oE 'DOCKER_IMAGE *= *"[^"]+"' \
    "$PROJECT_ROOT/.pi/skills/jsa/scripts/joern_integration.py" 2>/dev/null \
    | sed -E 's/.*"([^"]+)".*/\1/' | head -1 || true)"
if [ -n "$EXPECTED_IMAGE" ] && [ "$EXPECTED_IMAGE" != "$IMAGE_NAME" ]; then
    echo -e "${YELLOW}⚠ jsa expects Docker image '$EXPECTED_IMAGE' but this script builds '$IMAGE_NAME'.${NC}"
    echo "  Update IMAGE_NAME in this script to match joern_integration.py."
    IMAGE_NAME="$EXPECTED_IMAGE"
fi

if [ ! -f "$DOCKERFILE" ]; then
    echo -e "${RED}✗ Dockerfile not found: $DOCKERFILE${NC}"
    echo "  Skipping Joern image build."
    exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Docker is not installed; skipping Joern image build.${NC}"
    echo "  jsa will run its SLICE phase in degraded (non-Joern) mode."
    echo "  Install Docker, then re-run: bash scripts/setup/init-joern.sh"
    exit 0
fi

if ! docker info >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Docker daemon is not running; skipping Joern image build.${NC}"
    echo "  Start Docker, then re-run: bash scripts/setup/init-joern.sh"
    exit 0
fi

if [ "${JOERN_FORCE_REBUILD:-0}" != "1" ] && [ -n "$(docker images -q "$IMAGE_NAME" 2>/dev/null)" ]; then
    echo -e "${GREEN}✓ Image '$IMAGE_NAME' already exists; skipping build.${NC}"
    echo "  Force a rebuild with: JOERN_FORCE_REBUILD=1 bash scripts/setup/init-joern.sh"
    exit 0
fi

# The Dockerfile COPYs nothing from the build context, so use an empty temp
# context to keep the build fast (avoids sending the skill tree to the daemon).
BUILD_CONTEXT="$(mktemp -d)"
trap 'rm -rf "$BUILD_CONTEXT"' EXIT

echo -e "${YELLOW}▶ Building '$IMAGE_NAME' (downloads a JDK base image + Joern CLI; this can take several minutes)...${NC}"
if docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" "$BUILD_CONTEXT"; then
    echo -e "${GREEN}✓ Built image '$IMAGE_NAME'.${NC}"
else
    echo -e "${RED}✗ Failed to build '$IMAGE_NAME'.${NC}"
    echo "  jsa will run its SLICE phase in degraded (non-Joern) mode until this succeeds."
    exit 0
fi

# Smoke test: the image should respond to --help.
if docker run --rm "$IMAGE_NAME" --help >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Joern image smoke test passed.${NC}"
else
    echo -e "${YELLOW}⚠ Joern image built but smoke test did not pass cleanly; check 'docker run --rm $IMAGE_NAME --help'.${NC}"
fi
