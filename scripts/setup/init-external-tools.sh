#!/bin/bash
# Install Penny's external tool dependencies
#
# Handles: go-based tools, system packages, python packages, npm tools,
# playwright browsers, and nuclei templates.
#
# Usage:
#   bash scripts/setup/init-external-tools.sh
#   bash scripts/setup/init-external-tools.sh --skip-go --skip-playwright
#
# This script is idempotent — running twice won't break anything.
# Each tool is checked before install; skip with flags for offline/partial setups.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV_PATH="$PROJECT_ROOT/.venv"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[1;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# ── Flag parsing ────────────────────────────────────────────────────

SKIP_GO=false
SKIP_SYSTEM=false
SKIP_PYTHON=false
SKIP_NPM=false
SKIP_PLAYWRIGHT=false
SKIP_NUCLEI_TEMPLATES=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --skip-go) SKIP_GO=true ;;
        --skip-system) SKIP_SYSTEM=true ;;
        --skip-python) SKIP_PYTHON=true ;;
        --skip-npm) SKIP_NPM=true ;;
        --skip-playwright) SKIP_PLAYWRIGHT=true ;;
        --skip-nuclei-templates) SKIP_NUCLEI_TEMPLATES=true ;;
        --dry-run) DRY_RUN=true ;;
    esac
done

# ── Helpers ─────────────────────────────────────────────────────────

ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; }
info()  { echo -e "  ${CYAN}→${NC} $1"; }
skip()  { echo -e "  ${GRAY}⏭${NC} $1"; }

declare -i PASSED=0
declare -i FAILED=0
declare -i SKIPPED=0

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── Header ──────────────────────────────────────────────────────────

echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Penny External Tools Setup${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Project root: $PROJECT_ROOT"
[ "$DRY_RUN" = true ] && echo -e "${YELLOW}  DRY RUN — no changes will be made${NC}"
echo ""

# ── Pre-flight ──────────────────────────────────────────────────────

echo -e "${BLUE}── Pre-flight Checks ──${NC}"
echo ""

# Go
if ! have_cmd go; then
    if [ "$SKIP_GO" = true ]; then
        skip "Go not found (--skip-go active)"
        SKIPPED+=1
    else
        fail "Go is not installed (required for subfinder/dnsx/httpx/nuclei/katana/gau/gowitness/anew/jsluice)"
        echo "    Install: https://go.dev/dl/ or 'brew install go' or 'apt install golang-go'"
        FAILED+=1
    fi
else
    ok "Go $(go version | awk '{print $3}')"
    PASSED+=1
fi

# Bun
if ! have_cmd bun; then
    fail "Bun is not installed (required for Penny runtime)"
    echo "    Install: curl -fsSL https://bun.sh/install | bash"
    FAILED+=1
else
    ok "Bun $(bun --version 2>/dev/null || echo '?')"
    PASSED+=1
fi

# Node.js / npx
if ! have_cmd npx; then
    fail "npx not found (Node.js required for js-beautify/synchrony/webcrack)"
    echo "    Install: https://nodejs.org/ or 'apt install nodejs npm'"
    FAILED+=1
else
    ok "Node.js / npx available"
    PASSED+=1
fi

# Docker (optional)
if have_cmd docker; then
    ok "Docker available (for rustscan)"
    PASSED+=1
else
    warn "Docker not found — rustscan (deep mode) will need binary alternative"
    echo "    Install: https://docs.docker.com/engine/install/"
fi

echo ""

# ── 1. Go-based tools ───────────────────────────────────────────────

echo -e "${BLUE}── 1. Go-based Bug Bounty Tools ──${NC}"
echo ""

GO_TOOLS=(
    "subfinder:github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest:recon (subdomain enumeration)"
    "dnsx:github.com/projectdiscovery/dnsx/cmd/dnsx@latest:recon (DNS resolution)"
    "httpx:github.com/projectdiscovery/httpx/cmd/httpx@latest:recon (HTTP probing)"
    "anew:github.com/tomnomnom/anew@latest:recon + enumerate (deduplication)"
    "nuclei:github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest:enumerate (vulnerability scanning)"
    "katana:github.com/projectdiscovery/katana/cmd/katana@latest:enumerate (URL crawling, deep mode)"
    "gau:github.com/lc/gau/v2/cmd/gau@latest:enumerate (historical URLs, deep mode)"
    "gowitness:github.com/sensepost/gowitness@latest:enumerate (screenshots, deep mode)"
    "jsluice:github.com/BishopFox/jsluice/cmd/jsluice@latest:jsa + jsluice ext (JS URL/secrets extraction)"
)

GOPATH_BIN="$(go env GOPATH 2>/dev/null || echo "$HOME/go")/bin"
export PATH="$GOPATH_BIN:$PATH"

if [ "$SKIP_GO" = true ]; then
    for entry in "${GO_TOOLS[@]}"; do
        IFS=':' read -r name pkg desc <<< "$entry"
        skip "$name ($desc) — --skip-go active"
        SKIPPED+=1
    done
else
    for entry in "${GO_TOOLS[@]}"; do
        IFS=':' read -r name pkg desc <<< "$entry"

        if have_cmd "$name"; then
            ok "$name ($desc) — already installed"
            PASSED+=1
            continue
        fi

        info "Installing $name ($desc)..."
        if [ "$DRY_RUN" = true ]; then
            info "  [DRY RUN] go install $pkg"
            PASSED+=1
            continue
        fi

        if go install "$pkg" 2>&1; then
            ok "$name installed"
            PASSED+=1
        else
            fail "$name failed to install"
            echo "    Manual: go install $pkg"
            FAILED+=1
        fi
    done
fi

echo ""

# ── 2. System packages ──────────────────────────────────────────────

echo -e "${BLUE}── 2. System Packages ──${NC}"
echo ""

SYSTEM_PKGS=(
    "nmap:enumerate deep mode (service version detection)"
    "curl:jsa ACQUIRE phase (JS file downloads)"
)

detect_pkg_manager() {
    # Detect the system package manager
    if have_cmd apt-get; then echo "apt"; return; fi
    if have_cmd dnf; then echo "dnf"; return; fi
    if have_cmd yum; then echo "yum"; return; fi
    if have_cmd pacman; then echo "pacman"; return; fi
    if have_cmd brew; then echo "brew"; return; fi
    if have_cmd zypper; then echo "zypper"; return; fi
    echo "unknown"
}

PKG_MGR="$(detect_pkg_manager)"

if [ "$SKIP_SYSTEM" = true ]; then
    for entry in "${SYSTEM_PKGS[@]}"; do
        IFS=':' read -r name desc <<< "$entry"
        skip "$name ($desc) — --skip-system active"
        SKIPPED+=1
    done
else
    for entry in "${SYSTEM_PKGS[@]}"; do
        IFS=':' read -r name desc <<< "$entry"

        if have_cmd "$name"; then
            ok "$name ($desc) — already installed"
            PASSED+=1
            continue
        fi

        info "Installing $name ($desc)..."
        if [ "$DRY_RUN" = true ]; then
            info "  [DRY RUN] install $name via $PKG_MGR"
            PASSED+=1
            continue
        fi

        case "$PKG_MGR" in
            apt)
                sudo apt-get install -y "$name" 2>&1 || {
                    fail "$name install failed"; FAILED+=1; continue
                }
                ;;
            brew)
                brew install "$name" 2>&1 || {
                    fail "$name install failed"; FAILED+=1; continue
                }
                ;;
            dnf|yum)
                sudo "$PKG_MGR" install -y "$name" 2>&1 || {
                    fail "$name install failed"; FAILED+=1; continue
                }
                ;;
            pacman)
                sudo pacman -S --noconfirm "$name" 2>&1 || {
                    fail "$name install failed"; FAILED+=1; continue
                }
                ;;
            *)
                warn "Unknown package manager — install $name manually ($desc)"
                ;;
        esac
        ok "$name installed"
        PASSED+=1
    done
fi

echo ""

# ── 3. Feroxbuster (apt via .deb) ───────────────────────────────────

echo -e "${BLUE}── 3. Feroxbuster ──${NC}"
echo ""

if have_cmd feroxbuster; then
    ok "feroxbuster ($(feroxbuster --version 2>/dev/null | head -1 || echo '?')) — already installed"
    PASSED+=1
elif [ "$SKIP_SYSTEM" = true ]; then
    skip "feroxbuster — --skip-system active"
    SKIPPED+=1
elif [ "$DRY_RUN" = true ]; then
    info "[DRY RUN] feroxbuster via apt (.deb from GitHub releases)"
    PASSED+=1
else
    info "Installing feroxbuster via apt (.deb from GitHub releases)..."
    FEROX_DEB_ZIP="feroxbuster_amd64.deb.zip"
    TMP_DIR="$(mktemp -d)"
    ORIG_DIR="$(pwd)"
    FEROX_OK=true
    {
        cd "$TMP_DIR"
        if ! curl -sL --fail "https://github.com/epi052/feroxbuster/releases/latest/download/$FEROX_DEB_ZIP" -o "$FEROX_DEB_ZIP"; then
            fail "feroxbuster download failed"
            FEROX_OK=false
        elif ! unzip -o "$FEROX_DEB_ZIP" >/dev/null; then
            fail "feroxbuster unzip failed"
            FEROX_OK=false
        elif ! sudo apt install -y ./feroxbuster_*_amd64.deb; then
            fail "feroxbuster apt install failed"
            FEROX_OK=false
        fi
    }
    cd "$ORIG_DIR"
    rm -rf "$TMP_DIR"
    if [ "$FEROX_OK" = true ] && have_cmd feroxbuster; then
        ok "feroxbuster installed"
        PASSED+=1
    else
        [ "$FEROX_OK" = true ] || true  # FAILED already incremented by fail()
    fi
fi

echo ""

# ── 4. Rustscan (docker + alias) ────────────────────────────────────

echo -e "${BLUE}── 4. Rustscan ──${NC}"
echo ""

RUSTSCAN_VERSION="2.1.1"
RUSTSCAN_IMAGE="rustscan/rustscan:${RUSTSCAN_VERSION}"
RUSTSCAN_ALIAS="alias rustscan='docker run -it --rm --name rustscan ${RUSTSCAN_IMAGE}'"

if [ "$SKIP_SYSTEM" = true ]; then
    skip "rustscan — --skip-system active"
    SKIPPED+=1
elif ! have_cmd docker; then
    skip "rustscan — Docker not installed (required for docker-based rustscan)"
    SKIPPED+=1
else
    # Pull rustscan docker image
    if docker image inspect "$RUSTSCAN_IMAGE" >/dev/null 2>&1; then
        ok "rustscan docker image ($RUSTSCAN_IMAGE) — already pulled"
        PASSED+=1
    elif [ "$DRY_RUN" = true ]; then
        info "[DRY RUN] docker pull $RUSTSCAN_IMAGE"
        PASSED+=1
    else
        info "Pulling rustscan docker image ($RUSTSCAN_IMAGE)..."
        if docker pull "$RUSTSCAN_IMAGE" 2>&1; then
            ok "rustscan docker image pulled"
            PASSED+=1
        else
            fail "rustscan docker pull failed"
            echo "    Manual: docker pull $RUSTSCAN_IMAGE"
            FAILED+=1
        fi
    fi

    # Check/add alias in ~/.bashrc
    BASHRC="$HOME/.bashrc"
    if [ -f "$BASHRC" ] && grep -qF "alias rustscan='docker run" "$BASHRC" 2>/dev/null; then
        ok "rustscan alias already in ~/.bashrc"
        PASSED+=1
    elif [ "$DRY_RUN" = true ]; then
        info "[DRY RUN] Add rustscan alias to ~/.bashrc"
        PASSED+=1
    else
        info "Adding rustscan alias to ~/.bashrc..."
        cat >> "$BASHRC" << 'RUSTSCAN_EOF'

# rustscan
alias rustscan='docker run -it --rm --name rustscan rustscan/rustscan:2.1.1'
RUSTSCAN_EOF
        ok "rustscan alias added to ~/.bashrc (run 'source ~/.bashrc' to activate)"
        PASSED+=1
    fi
fi

echo ""

# ── 5. Project-level Node tools (bun) ───────────────────────────────

echo -e "${BLUE}── 5. Project-level Node Tools ──${NC}"
echo ""

NODE_TOOLS=(
    "js-beautify:JS prettification for deobfuscation"
    "synchrony:string-array deobfuscation"
    "webcrack:bundle unpacking"
)

if [ "$SKIP_NPM" = true ]; then
    for entry in "${NODE_TOOLS[@]}"; do
        IFS=':' read -r name desc <<< "$entry"
        skip "$name ($desc) — --skip-npm active"
        SKIPPED+=1
    done
elif [ ! -f "$PROJECT_ROOT/package.json" ]; then
    warn "No package.json at $PROJECT_ROOT — skipping project-level node tools"
else
    for entry in "${NODE_TOOLS[@]}"; do
        IFS=':' read -r name desc <<< "$entry"

        # Check if already in devDependencies
        if grep -q "\"$name\"" "$PROJECT_ROOT/package.json" 2>/dev/null; then
            ok "$name ($desc) — already in devDependencies"
            PASSED+=1
            continue
        fi

        # Check if binary exists in node_modules/.bin/
        if [ -x "$PROJECT_ROOT/node_modules/.bin/$name" ]; then
            ok "$name ($desc) — already in node_modules/.bin/"
            PASSED+=1
            continue
        fi

        info "Adding $name to project devDependencies via bun..."
        if [ "$DRY_RUN" = true ]; then
            info "  [DRY RUN] cd $PROJECT_ROOT && bun add -d $name"
            PASSED+=1
            continue
        fi

        if (cd "$PROJECT_ROOT" && bun add -d "$name" 2>&1); then
            ok "$name added to devDependencies"
            PASSED+=1
        else
            fail "$name install failed"
            echo "    Manual: cd $PROJECT_ROOT && bun add -d $name"
            FAILED+=1
        fi
    done
fi

echo ""

# ── 6. Python packages (pip) ────────────────────────────────────────

echo -e "${BLUE}── 6. Python Packages ──${NC}"
echo ""

# Format: pypi-name:import_name:description — the import name is what the
# already-installed check imports (it often differs from the PyPI name).
PYTHON_PKGS=(
    "tree-sitter:tree_sitter:jsa splitter (AST parsing)"
    "tree-sitter-javascript:tree_sitter_javascript:jsa splitter (JS grammar)"
    "tiktoken:tiktoken:CANONICAL token counter (jsa splitter + SYSTEM.md budget check; cl100k_base)"
    "cvss:cvss:sca normalizer (CVSS 4.0 scoring, per .pi/skills/sca/requirements.txt)"
    "PyYAML:yaml:sca targeted-scan rule validation"
    "python-docx:docx:word extension (.docx generation)"
    "python-pptx:pptx:powerpoint extension (.pptx generation)"
    "markdown-it-py:markdown_it:word/powerpoint extensions (markdown parsing)"
    "pillow:PIL:word/powerpoint extensions (image sizing)"
    "lxml:lxml:word/powerpoint extensions (XML processing)"
)

if [ ! -d "$VENV_PATH" ]; then
    warn ".venv not found at $VENV_PATH — creating..."
    uv venv "$VENV_PATH" 2>/dev/null || python3 -m venv "$VENV_PATH"
fi
source "$VENV_PATH/bin/activate" 2>/dev/null || true

if [ "$SKIP_PYTHON" = true ]; then
    for entry in "${PYTHON_PKGS[@]}"; do
        IFS=':' read -r name module desc <<< "$entry"
        skip "$name ($desc) — --skip-python active"
        SKIPPED+=1
    done
else
    for entry in "${PYTHON_PKGS[@]}"; do
        IFS=':' read -r name module desc <<< "$entry"

        if python -c "import ${module}" 2>/dev/null; then
            ok "$name ($desc) — already installed"
            PASSED+=1
            continue
        fi

        info "Installing $name..."
        if [ "$DRY_RUN" = true ]; then
            info "  [DRY RUN] uv pip install $name"
            PASSED+=1
            continue
        fi

        if uv pip install "$name" 2>&1; then
            ok "$name installed"
            PASSED+=1
        else
            fail "$name failed to install"
            echo "    Manual: uv pip install $name"
            FAILED+=1
        fi
    done
fi

echo ""

# ── 7. Playwright browsers ──────────────────────────────────────────

echo -e "${BLUE}── 7. Playwright Browsers ──${NC}"
echo ""

if [ "$SKIP_PLAYWRIGHT" = true ]; then
    skip "Playwright browsers — --skip-playwright active"
    SKIPPED+=1
else
    # Check if chromium is already installed for Playwright
    PLAYWRIGHT_CHROMIUM_NEEDED=false
    if npx playwright install --dry-run chromium 2>/dev/null | grep -q "is already installed"; then
        ok "Playwright Chromium already installed"
        PASSED+=1
    elif [ "$DRY_RUN" = true ]; then
        info "[DRY RUN] npx playwright install chromium"
        PASSED+=1
    else
        info "Installing Playwright Chromium..."
        if npx playwright install chromium 2>&1; then
            ok "Playwright Chromium installed"
            PASSED+=1
        else
            fail "Playwright Chromium install failed"
            echo "    Manual: npx playwright install chromium"
            echo "    System deps: npx playwright install-deps chromium"
            FAILED+=1
        fi
    fi
fi

echo ""

# ── 8. Nuclei templates ─────────────────────────────────────────────

echo -e "${BLUE}── 8. Nuclei Templates ──${NC}"
echo ""

DEFAULT_TEMPLATES="$HOME/nuclei-templates"
TEMPLATES_PATH="${NUCLEI_TEMPLATES_PATH:-$DEFAULT_TEMPLATES}"

if [ "$SKIP_NUCLEI_TEMPLATES" = true ]; then
    skip "Nuclei templates — --skip-nuclei-templates active"
    SKIPPED+=1
elif [ -d "$TEMPLATES_PATH" ] && [ "$(ls -A "$TEMPLATES_PATH" 2>/dev/null)" ]; then
    # Count template files
    COUNT=$(find "$TEMPLATES_PATH" -name "*.yaml" -o -name "*.yml" 2>/dev/null | wc -l)
    ok "Nuclei templates at $TEMPLATES_PATH ($COUNT template files)"
    PASSED+=1
elif have_cmd nuclei; then
    info "Downloading nuclei templates to $TEMPLATES_PATH..."
    if [ "$DRY_RUN" = true ]; then
        info "  [DRY RUN] nuclei -update-templates"
        PASSED+=1
    else
        if nuclei -update-templates -ud "$TEMPLATES_PATH" 2>&1; then
            ok "Nuclei templates downloaded"
            PASSED+=1
        else
            fail "Nuclei templates download failed"
            echo "    Manual: nuclei -update-templates"
            FAILED+=1
        fi
    fi
else
    warn "nuclei not yet installed — templates will be downloaded on first nuclei run"
    echo "    Set NUCLEI_TEMPLATES_PATH in .env to customize template location"
fi

echo ""

# ── Summary ─────────────────────────────────────────────────────────

echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Setup Summary${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

TOTAL=$((PASSED + FAILED + SKIPPED))
echo "  Passed:  $PASSED / $TOTAL"

if [ "$FAILED" -gt 0 ]; then
    echo -e "  ${RED}Failed:  $FAILED / $TOTAL${NC}"
fi
if [ "$SKIPPED" -gt 0 ]; then
    echo -e "  ${YELLOW}Skipped: $SKIPPED / $TOTAL${NC}"
fi

if [ "$FAILED" -eq 0 ]; then
    echo ""
    echo -e "${GREEN}All external tool dependencies are ready.${NC}"
else
    echo ""
    echo -e "${YELLOW}Some tools failed to install. Review the output above.${NC}"
    echo "Re-run with specific --skip flags to bypass problematic sections."
fi

echo ""
echo ""
