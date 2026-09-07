#!/usr/bin/env bash
# Penny setup compatibility wrapper.
# The Makefile owns the explicit dependency graph; no setup scripts are
# discovered by filename.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec make -C "$PROJECT_ROOT" setup "$@"
