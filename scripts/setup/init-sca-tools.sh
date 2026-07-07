#!/bin/bash
# Penny — sca skill tool provisioning
#
# Installs the 8 external tools the `sca` (secure code analysis) skill needs and
# that the existing `init-external-tools.sh` does NOT already handle:
#
#   REQUIRED (baseline scan gate blocks without these):
#     osv-scanner  v2.4.0    (Go release binary -> ~/.local/bin)
#     gitleaks     v8.30.1   (Go release binary -> ~/.local/bin)
#     (semgrep is already provided by the project .venv / semgrep extension)
#
#   OPTIONAL (degrade coverage, never block):
#     trivy        v0.72.0   (Go release binary -> ~/.local/bin)
#     trufflehog   v3.95.7   (Go release binary -> ~/.local/bin)
#     retire.js    v5.4.3    (bun workspace dep  -> wrapper in ~/.local/bin)
#     eslint-plugin-security v4.0.1 (+ no-unsanitized, eslint) (bun -> wrapper)
#     njsscan      v0.4.3    (ISOLATED venv .venv-sca-tools -> wrapper)
#     codeql       v2.25.6   (release bundle -> ~/.local/opt + symlink) [opt-in]
#
# WHY the design looks like this
# ------------------------------
#   * Every sca tool extension resolves its binary by BARE NAME via PATH
#     (execFileSync("osv-scanner", ...)). So a tool is "usable by the skill"
#     iff its binary is on the Pi process PATH. ~/.local/bin IS on that PATH;
#     .venv/bin and node_modules/.bin are NOT. Hence the wrappers/symlinks.
#   * njsscan is installed into a SEPARATE venv (.venv-sca-tools), NOT the main
#     project .venv: njsscan==0.4.3 pins an OLD semgrep (1.86.x) and would
#     DOWNGRADE the project's semgrep (a REQUIRED sca tool) + pydantic + 15
#     other packages. Isolating it keeps the main .venv pristine.
#   * This whole layer is a BRIDGE until the planned project Docker image
#     installs everything in-container and the skills point at that. Downloads
#     are TLS-authenticated from official GitHub releases; codeql is checksum-
#     verified; every tool is version-asserted after install. Full per-binary
#     checksum pinning is deferred to the Docker image.
#
# Auto-discovered and run by scripts/setup/setup.sh (init-*.sh glob), so it runs
# as part of `make setup`. Also runnable standalone and via `make sca-tools`.
#
# Usage:
#   bash scripts/setup/init-sca-tools.sh
#   bash scripts/setup/init-sca-tools.sh --dry-run
#   bash scripts/setup/init-sca-tools.sh --force            # reinstall all
#   bash scripts/setup/init-sca-tools.sh --skip-codeql      # skip opt-in codeql
#   Flags: --skip-go --skip-python --skip-js --skip-codeql --force --dry-run
#
# Idempotent: a tool already present at the pinned version is left untouched
# unless --force is given.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Install locations ───────────────────────────────────────────────
LOCAL_BIN="$HOME/.local/bin"
OPT_DIR="$HOME/.local/opt"
SCA_VENV="$PROJECT_ROOT/.venv-sca-tools"

# ── Pinned versions (single source of truth: sca tool_manifest.py) ───
OSV_VER="2.4.0"
GITLEAKS_VER="8.30.1"
TRIVY_VER="0.72.0"
TRUFFLEHOG_VER="3.95.7"
RETIRE_VER="5.4.3"
ESLINT_SEC_VER="4.0.1"
NJSSCAN_VER="0.4.3"
CODEQL_VER="2.25.6"

# ── Colors ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
BLUE='\033[1;34m'; CYAN='\033[0;36m'; GRAY='\033[0;90m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED+1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED+1)); }
info() { echo -e "  ${CYAN}→${NC} $1"; }
skip() { echo -e "  ${GRAY}⏭${NC} $1"; SKIPPED=$((SKIPPED+1)); }

PASSED=0; FAILED=0; SKIPPED=0

# ── Flags ───────────────────────────────────────────────────────────
DRY_RUN=false; FORCE=false
SKIP_GO=false; SKIP_PY=false; SKIP_JS=false; SKIP_CODEQL=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    --skip-go) SKIP_GO=true ;;
    --skip-python) SKIP_PY=true ;;
    --skip-js) SKIP_JS=true ;;
    --skip-codeql) SKIP_CODEQL=true ;;
    *) warn "unknown flag: $arg" ;;
  esac
done

have_cmd() { command -v "$1" >/dev/null 2>&1; }
run() { if [ "$DRY_RUN" = true ]; then info "[DRY RUN] $*"; return 0; fi; "$@"; }

# ── Header ──────────────────────────────────────────────────────────
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Penny sca-skill Tool Provisioning${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Project root : $PROJECT_ROOT"
echo "Bin dir      : $LOCAL_BIN"
echo "njsscan venv : $SCA_VENV (isolated)"
[ "$DRY_RUN" = true ] && echo -e "${YELLOW}  DRY RUN — no changes will be made${NC}"
echo ""

# ── Pre-flight ──────────────────────────────────────────────────────
echo -e "${BLUE}── Pre-flight ──${NC}"; echo ""
OSNAME="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OSNAME" != "Linux" ] || [ "$ARCH" != "x86_64" ]; then
  warn "This bridge script targets Linux x86_64 (found: $OSNAME/$ARCH)."
  warn "Download asset names below are linux/amd64; adjust or wait for the Docker image."
fi
for c in curl tar unzip; do
  have_cmd "$c" && ok "$c present" || fail "$c missing (required)"
done
have_cmd uv || warn "uv not found — njsscan (python) step will be skipped/fail"
have_cmd bun || warn "bun not found — retire/eslint (js) step will be skipped/fail"
mkdir -p "$LOCAL_BIN" "$OPT_DIR"
case ":$PATH:" in
  *":$LOCAL_BIN:"*) ok "$LOCAL_BIN is on PATH" ;;
  *) warn "$LOCAL_BIN is NOT on PATH — add it to your shell profile so Pi can find the tools" ;;
esac
echo ""

# ── Helpers ─────────────────────────────────────────────────────────

# Assert a tool reports the pinned version. Soft: warns on mismatch (‐‐version
# output formats vary), hard-fails only if the binary cannot run at all.
assert_version() {
  local name="$1" want="$2"; shift 2
  if [ "$DRY_RUN" = true ]; then info "[DRY RUN] would verify $name $want via '$*'"; PASSED=$((PASSED+1)); return 0; fi
  local out
  out="$("$@" 2>&1)" || { fail "$name installed but '$*' failed to run"; return 1; }
  if echo "$out" | grep -qF "$want"; then
    ok "$name $want verified on PATH"
  else
    warn "$name is on PATH but did not report expected version $want (got: $(echo "$out" | head -1))"
    PASSED=$((PASSED+1))
  fi
}

# Write an exec wrapper in ~/.local/bin pointing at an absolute target.
make_wrapper() {
  local name="$1" target="$2" dest="$LOCAL_BIN/$1"
  if [ "$DRY_RUN" = true ]; then info "[DRY RUN] wrapper $dest -> $target"; return 0; fi
  cat > "$dest" <<EOF
#!/usr/bin/env bash
# Auto-generated by scripts/setup/init-sca-tools.sh — do not edit.
# Bridges the sca skill's PATH lookup to a project-local tool. Replaced by the
# planned project Docker image.
exec "$target" "\$@"
EOF
  chmod +x "$dest"
}

# Download a raw single-file binary to ~/.local/bin.
install_raw_binary() {
  local name="$1" url="$2" dest="$LOCAL_BIN/$1"
  info "Downloading $name from $url"
  [ "$DRY_RUN" = true ] && { info "[DRY RUN] curl -> $dest"; return 0; }
  local tmp; tmp="$(mktemp)"
  if curl -fsSL "$url" -o "$tmp"; then
    chmod +x "$tmp"; mv "$tmp" "$dest"
  else
    rm -f "$tmp"; fail "$name download failed ($url)"; return 1
  fi
}

# Download a .tar.gz release and extract one member binary to ~/.local/bin.
install_tar_binary() {
  local name="$1" url="$2" member="$3" dest="$LOCAL_BIN/$1"
  info "Downloading $name from $url"
  [ "$DRY_RUN" = true ] && { info "[DRY RUN] curl+tar ($member) -> $dest"; return 0; }
  local tmpd; tmpd="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmpd/pkg.tgz" && tar -xzf "$tmpd/pkg.tgz" -C "$tmpd" "$member" 2>/dev/null; then
    chmod +x "$tmpd/$member"; mv "$tmpd/$member" "$dest"; rm -rf "$tmpd"
  else
    # Fallback: extract everything, then find the member (some archives nest).
    if tar -xzf "$tmpd/pkg.tgz" -C "$tmpd" 2>/dev/null; then
      local found; found="$(find "$tmpd" -type f -name "$member" | head -1)"
      if [ -n "$found" ]; then chmod +x "$found"; mv "$found" "$dest"; rm -rf "$tmpd";
      else rm -rf "$tmpd"; fail "$name: member '$member' not found in archive"; return 1; fi
    else
      rm -rf "$tmpd"; fail "$name download/extract failed ($url)"; return 1
    fi
  fi
}

# ── 1. Go release binaries (REQUIRED + optional) ────────────────────
echo -e "${BLUE}── 1. Release-binary tools (osv-scanner, gitleaks, trivy, trufflehog) ──${NC}"; echo ""
if [ "$SKIP_GO" = true ]; then
  skip "release-binary tools (--skip-go)"
else
  GH="https://github.com"

  # osv-scanner (REQUIRED) — raw binary
  if have_cmd osv-scanner && [ "$FORCE" = false ]; then
    assert_version "osv-scanner" "$OSV_VER" osv-scanner --version
  else
    install_raw_binary "osv-scanner" \
      "$GH/google/osv-scanner/releases/download/v$OSV_VER/osv-scanner_linux_amd64" \
      && assert_version "osv-scanner" "$OSV_VER" osv-scanner --version
  fi

  # gitleaks (REQUIRED) — tar.gz
  if have_cmd gitleaks && [ "$FORCE" = false ]; then
    assert_version "gitleaks" "$GITLEAKS_VER" gitleaks version
  else
    install_tar_binary "gitleaks" \
      "$GH/gitleaks/gitleaks/releases/download/v$GITLEAKS_VER/gitleaks_${GITLEAKS_VER}_linux_x64.tar.gz" \
      "gitleaks" \
      && assert_version "gitleaks" "$GITLEAKS_VER" gitleaks version
  fi

  # trivy (optional) — tar.gz
  if have_cmd trivy && [ "$FORCE" = false ]; then
    assert_version "trivy" "$TRIVY_VER" trivy --version
  else
    install_tar_binary "trivy" \
      "$GH/aquasecurity/trivy/releases/download/v$TRIVY_VER/trivy_${TRIVY_VER}_Linux-64bit.tar.gz" \
      "trivy" \
      && assert_version "trivy" "$TRIVY_VER" trivy --version
  fi

  # trufflehog (optional) — tar.gz
  if have_cmd trufflehog && [ "$FORCE" = false ]; then
    assert_version "trufflehog" "$TRUFFLEHOG_VER" trufflehog --version
  else
    install_tar_binary "trufflehog" \
      "$GH/trufflesecurity/trufflehog/releases/download/v$TRUFFLEHOG_VER/trufflehog_${TRUFFLEHOG_VER}_linux_amd64.tar.gz" \
      "trufflehog" \
      && assert_version "trufflehog" "$TRUFFLEHOG_VER" trufflehog --version
  fi
fi
echo ""

# ── 2. njsscan — ISOLATED venv (python, optional) ───────────────────
echo -e "${BLUE}── 2. njsscan (isolated venv, keeps main .venv pristine) ──${NC}"; echo ""
if [ "$SKIP_PY" = true ]; then
  skip "njsscan (--skip-python)"
elif ! have_cmd uv; then
  fail "uv not available — cannot build $SCA_VENV"
else
  if [ ! -d "$SCA_VENV" ]; then
    info "Creating isolated venv $SCA_VENV"
    run uv venv "$SCA_VENV"
  fi
  info "Installing njsscan==$NJSSCAN_VER into isolated venv"
  if run uv pip install --python "$SCA_VENV/bin/python" "njsscan==$NJSSCAN_VER"; then
    make_wrapper "njsscan" "$SCA_VENV/bin/njsscan"
    if [ "$DRY_RUN" = false ]; then
      assert_version "njsscan" "$NJSSCAN_VER" "$LOCAL_BIN/njsscan" --version
    fi
  else
    fail "njsscan install failed"
  fi
fi
echo ""

# ── 3. retire.js + eslint security (js via bun workspaces) ──────────
echo -e "${BLUE}── 3. retire.js + eslint-plugin-security (bun workspaces) ──${NC}"; echo ""
if [ "$SKIP_JS" = true ]; then
  skip "retire/eslint (--skip-js)"
elif ! have_cmd bun; then
  fail "bun not available — cannot install js tools"
else
  # package.json for retire-js / eslint-security extensions already declare the
  # pinned deps; bun install (also run by `make install-js`) hoists them to the
  # root node_modules. Run it here so standalone execution works too.
  info "bun install (retire@$RETIRE_VER, eslint-plugin-security@$ESLINT_SEC_VER, no-unsanitized, eslint)"
  ( cd "$PROJECT_ROOT" && run bun install ) || fail "bun install failed"

  # bun does NOT hoist workspace deps to the root node_modules; it co-locates
  # them under each extension's own node_modules (which is exactly where the
  # eslint flat-config resolves its plugins from). Resolve binaries from either
  # the root .bin or the owning extension's .bin.
  resolve_bin() {
    local name="$1"; shift
    local c; for c in "$@"; do [ -x "$c" ] && { echo "$c"; return 0; }; done
    return 1
  }

  if [ "$DRY_RUN" = false ]; then
    RETIRE_BIN="$(resolve_bin retire \
      "$PROJECT_ROOT/node_modules/.bin/retire" \
      "$PROJECT_ROOT/.pi/extensions/retire-js/node_modules/.bin/retire")"
    if [ -n "$RETIRE_BIN" ]; then
      make_wrapper "retire" "$RETIRE_BIN"
      assert_version "retire" "$RETIRE_VER" "$LOCAL_BIN/retire" --version
    else
      fail "retire binary not found after bun install"
    fi

    ESLINT_BIN="$(resolve_bin eslint \
      "$PROJECT_ROOT/.pi/extensions/eslint-security/node_modules/.bin/eslint" \
      "$PROJECT_ROOT/node_modules/.bin/eslint")"
    if [ -n "$ESLINT_BIN" ]; then
      make_wrapper "eslint" "$ESLINT_BIN"
      if "$LOCAL_BIN/eslint" --version >/dev/null 2>&1; then
        ok "eslint on PATH ($("$LOCAL_BIN/eslint" --version 2>/dev/null))"
      else
        fail "eslint wrapper failed to run"
      fi
    else
      fail "eslint binary not found after bun install"
    fi

    if [ -d "$PROJECT_ROOT/.pi/extensions/eslint-security/node_modules/eslint-plugin-security" ] \
       || [ -d "$PROJECT_ROOT/node_modules/eslint-plugin-security" ]; then
      ok "eslint-plugin-security@$ESLINT_SEC_VER resolved (co-located with config)"
    else
      fail "eslint-plugin-security not resolved — eslint scan will fail to load config"
    fi
  fi
fi
echo ""

# ── 4. codeql (opt-in bundle, checksum-verified) ────────────────────
echo -e "${BLUE}── 4. codeql (opt-in; disabled by default in the skill) ──${NC}"; echo ""
if [ "$SKIP_CODEQL" = true ]; then
  skip "codeql (--skip-codeql)"
elif have_cmd codeql && [ "$FORCE" = false ]; then
  assert_version "codeql" "$CODEQL_VER" codeql version --format=terse
else
  CQ_URL="https://github.com/github/codeql-cli-binaries/releases/download/v$CODEQL_VER/codeql-linux64.zip"
  CQ_SUM_URL="$CQ_URL.checksum.txt"
  CQ_HOME="$OPT_DIR/codeql-$CODEQL_VER"
  info "Downloading codeql v$CODEQL_VER (+ checksum)"
  if [ "$DRY_RUN" = true ]; then
    info "[DRY RUN] curl codeql zip -> unzip $CQ_HOME -> symlink $LOCAL_BIN/codeql"
  else
    tmpd="$(mktemp -d)"
    if curl -fsSL "$CQ_URL" -o "$tmpd/codeql.zip"; then
      # Checksum verify (best-effort: skip if the checksum asset is unavailable).
      if curl -fsSL "$CQ_SUM_URL" -o "$tmpd/codeql.sum" 2>/dev/null; then
        want="$(awk '{print $1}' "$tmpd/codeql.sum" | head -1)"
        got="$(sha256sum "$tmpd/codeql.zip" | awk '{print $1}')"
        if [ -n "$want" ] && [ "$want" != "$got" ]; then
          fail "codeql checksum mismatch (want $want got $got) — refusing to install"
          rm -rf "$tmpd"; CQ_URL=""
        else
          ok "codeql checksum verified"
        fi
      else
        warn "codeql checksum asset unavailable — proceeding on TLS trust only"
      fi
      if [ -n "$CQ_URL" ]; then
        rm -rf "$CQ_HOME"; mkdir -p "$CQ_HOME"
        if unzip -q "$tmpd/codeql.zip" -d "$CQ_HOME"; then
          ln -sf "$CQ_HOME/codeql/codeql" "$LOCAL_BIN/codeql"
          assert_version "codeql" "$CODEQL_VER" codeql version --format=terse
        else
          fail "codeql unzip failed"
        fi
      fi
      rm -rf "$tmpd"
    else
      rm -rf "$tmpd"; fail "codeql download failed ($CQ_URL)"
    fi
  fi
fi
echo ""

# ── Summary ─────────────────────────────────────────────────────────
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  sca Tool Provisioning Summary${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
TOTAL=$((PASSED + FAILED + SKIPPED))
echo -e "  ${GREEN}Passed:  $PASSED / $TOTAL${NC}"
[ "$FAILED"  -gt 0 ] && echo -e "  ${RED}Failed:  $FAILED / $TOTAL${NC}"
[ "$SKIPPED" -gt 0 ] && echo -e "  ${YELLOW}Skipped: $SKIPPED / $TOTAL${NC}"
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}sca tools provisioned.${NC}"
  echo -e "${YELLOW}IMPORTANT:${NC} restart Pi so the tool extensions re-detect the newly installed binaries"
  echo "          (each extension checks its binary at load time, not per-call)."
else
  echo -e "${YELLOW}Some sca tools failed — review above. REQUIRED = osv-scanner, gitleaks.${NC}"
fi
echo ""
# Never hard-fail the aggregate setup run for OPTIONAL gaps; surface via summary.
exit 0
