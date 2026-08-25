#!/bin/sh
# Scan only the current repository's staged index or an explicit Git range.
# This command never downloads or provisions Gitleaks.

set -eu

# Keep Git's read-only scan subprocesses from taking optional locks or refreshing state.
GIT_OPTIONAL_LOCKS=0
export GIT_OPTIONAL_LOCKS

GITLEAKS_VERSION='8.30.1'
GITLEAKS_BINARY_SHA256='88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509'

usage() {
    printf '%s\n' 'Usage:' >&2
    printf '%s\n' '  scan-secrets.sh staged' >&2
    printf '%s\n' '  scan-secrets.sh range <from>..<to>' >&2
}

fail() {
    printf 'secret scan: %s\n' "$1" >&2
    exit 2
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

check_platform() {
    scan_kernel=$(uname -s 2>/dev/null) || fail 'cannot determine operating system'
    scan_machine=$(uname -m 2>/dev/null) || fail 'cannot determine machine architecture'

    [ "$scan_kernel" = 'Linux' ] || fail "unsupported operating system: $scan_kernel (requires Linux)"
    case "$scan_machine" in
        x86_64 | amd64) ;;
        *) fail "unsupported machine architecture: $scan_machine (requires x64)" ;;
    esac
}

resolve_tool_dir() {
    if [ -n "${PENNY_GITLEAKS_DIR:-}" ]; then
        scan_tool_dir=$PENNY_GITLEAKS_DIR
    elif [ -n "${XDG_CACHE_HOME:-}" ]; then
        scan_tool_dir=$XDG_CACHE_HOME/penny/gitleaks/v$GITLEAKS_VERSION/linux-x64
    elif [ -n "${HOME:-}" ]; then
        scan_tool_dir=$HOME/.cache/penny/gitleaks/v$GITLEAKS_VERSION/linux-x64
    else
        fail 'HOME and XDG_CACHE_HOME are unset; cannot locate the verified Gitleaks tool'
    fi

    case "$scan_tool_dir" in
        /*) ;;
        *) fail 'Gitleaks tool directory must be an absolute path' ;;
    esac
}

sha256_file() {
    scan_sha_output=$(sha256sum "$1" 2>/dev/null) || return 1
    scan_sha_digest=${scan_sha_output%% *}
    case "$scan_sha_digest" in
        '' | *[!0-9a-f]*) return 1 ;;
    esac
    [ "${#scan_sha_digest}" -eq 64 ] || return 1
    printf '%s\n' "$scan_sha_digest"
}

verify_tool() {
    scan_gitleaks=$scan_tool_dir/gitleaks
    [ -f "$scan_gitleaks" ] || fail "verified Gitleaks is unavailable; provision it explicitly with 'bun run security:secrets:provision'"
    [ -x "$scan_gitleaks" ] || fail "Gitleaks is not executable: $scan_gitleaks"

    scan_actual_sha=$(sha256_file "$scan_gitleaks") || fail 'cannot checksum the provisioned Gitleaks binary'
    [ "$scan_actual_sha" = "$GITLEAKS_BINARY_SHA256" ] || fail 'provisioned Gitleaks binary checksum is invalid'

    scan_actual_version=$("$scan_gitleaks" version 2>/dev/null) || fail 'cannot execute the verified Gitleaks binary'
    [ "$scan_actual_version" = "$GITLEAKS_VERSION" ] || fail "provisioned Gitleaks version is invalid: $scan_actual_version"
}

validate_range() {
    scan_range=$1

    case "$scan_range" in
        '' | *[!A-Za-z0-9_./@{}~^+-]*) fail 'Git range contains unsupported characters' ;;
    esac

    case "$scan_range" in
        *...*)
            scan_left=${scan_range%%...*}
            scan_right=${scan_range#*...}
            case "$scan_right" in
                *..*) fail 'Git range must contain exactly one range operator' ;;
            esac
            ;;
        *..*)
            scan_left=${scan_range%%..*}
            scan_right=${scan_range#*..}
            case "$scan_right" in
                *..*) fail 'Git range must contain exactly one range operator' ;;
            esac
            ;;
        *) fail 'Git range must use an explicit two-dot or three-dot range operator' ;;
    esac

    case "$scan_left" in
        '' | -*) fail 'Git range requires a valid, explicit left endpoint' ;;
    esac
    case "$scan_right" in
        '' | -*) fail 'Git range requires a valid, explicit right endpoint' ;;
    esac

    git -C "$scan_repo_root" rev-parse --verify --quiet "$scan_left^{commit}" >/dev/null ||
        fail "Git range left endpoint is not a commit: $scan_left"
    git -C "$scan_repo_root" rev-parse --verify --quiet "$scan_right^{commit}" >/dev/null ||
        fail "Git range right endpoint is not a commit: $scan_right"
    git -C "$scan_repo_root" rev-list --quiet "$scan_range" -- >/dev/null 2>&1 ||
        fail "Git range is invalid: $scan_range"
}

[ "$#" -ge 1 ] || {
    usage
    fail 'scan mode is required'
}

scan_mode=$1
shift
case "$scan_mode" in
    staged)
        [ "$#" -eq 0 ] || {
            usage
            fail 'staged mode does not accept arguments'
        }
        ;;
    range)
        [ "$#" -eq 1 ] || {
            usage
            fail 'range mode requires exactly one Git range argument'
        }
        scan_requested_range=$1
        ;;
    *)
        usage
        fail "unknown scan mode: $scan_mode"
        ;;
esac

require_command uname
require_command git
require_command sha256sum
check_platform

scan_repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'current directory is not inside a Git worktree'
scan_config=$scan_repo_root/.gitleaks.toml
[ -f "$scan_config" ] || fail "required scanner configuration is unavailable: $scan_config"

if [ "$scan_mode" = 'range' ]; then
    validate_range "$scan_requested_range"
fi

resolve_tool_dir
verify_tool

cd "$scan_repo_root" || fail "cannot enter Git worktree: $scan_repo_root"

if [ "$scan_mode" = 'staged' ]; then
    exec "$scan_gitleaks" git \
        --staged \
        --config "$scan_config" \
        --exit-code 1 \
        --ignore-gitleaks-allow \
        --max-archive-depth 0 \
        --max-decode-depth 5 \
        --no-banner \
        --no-color \
        --redact=100 \
        --verbose \
        .
fi

exec "$scan_gitleaks" git \
    --log-opts="$scan_requested_range" \
    --config "$scan_config" \
    --exit-code 1 \
    --ignore-gitleaks-allow \
    --max-archive-depth 0 \
    --max-decode-depth 5 \
    --no-banner \
    --no-color \
    --redact=100 \
    --verbose \
    .
