#!/bin/sh
# Explicitly provision the one approved Gitleaks build outside the project tree.

set -eu
umask 077

GITLEAKS_VERSION='8.30.1'
GITLEAKS_RELEASE_BASE='https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/'
GITLEAKS_ARCHIVE='gitleaks_8.30.1_linux_x64.tar.gz'
GITLEAKS_CHECKSUMS='gitleaks_8.30.1_checksums.txt'
GITLEAKS_ARCHIVE_SHA256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
GITLEAKS_CHECKSUMS_SHA256='061476c21adaf5441516f96f185c1a4706a83cd6329b9b38762271b3d4a52fae'
# Derived from the binary inside the approved, checksum-verified archive above.
GITLEAKS_BINARY_SHA256='88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509'

provision_temp_dir=''
provision_install_temp=''

cleanup() {
    if [ -n "$provision_install_temp" ]; then
        rm -f "$provision_install_temp"
    fi
    if [ -n "$provision_temp_dir" ]; then
        rm -rf "$provision_temp_dir"
    fi
}

trap cleanup 0
trap 'exit 1' 1 2 3 15

fail() {
    printf 'Gitleaks provisioning failed: %s\n' "$1" >&2
    exit 2
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

check_platform() {
    provision_kernel=$(uname -s 2>/dev/null) || fail 'cannot determine operating system'
    provision_machine=$(uname -m 2>/dev/null) || fail 'cannot determine machine architecture'

    [ "$provision_kernel" = 'Linux' ] || fail "unsupported operating system: $provision_kernel (requires Linux)"
    case "$provision_machine" in
        x86_64 | amd64) ;;
        *) fail "unsupported machine architecture: $provision_machine (requires x64)" ;;
    esac
}

resolve_tool_dir() {
    if [ -n "${PENNY_GITLEAKS_DIR:-}" ]; then
        provision_tool_dir=$PENNY_GITLEAKS_DIR
    elif [ -n "${XDG_CACHE_HOME:-}" ]; then
        provision_tool_dir=$XDG_CACHE_HOME/penny/gitleaks/v$GITLEAKS_VERSION/linux-x64
    elif [ -n "${HOME:-}" ]; then
        provision_tool_dir=$HOME/.cache/penny/gitleaks/v$GITLEAKS_VERSION/linux-x64
    else
        fail 'HOME and XDG_CACHE_HOME are unset; cannot choose an external tool directory'
    fi

    case "$provision_tool_dir" in
        /*) ;;
        *) fail 'Gitleaks tool directory must be an absolute path' ;;
    esac
    case "$provision_tool_dir" in
        */../* | */.. | */./* | */.) fail 'Gitleaks tool directory must not contain dot traversal segments' ;;
    esac
}

sha256_file() {
    provision_sha_output=$(sha256sum "$1" 2>/dev/null) || return 1
    provision_sha_digest=${provision_sha_output%% *}
    case "$provision_sha_digest" in
        '' | *[!0-9a-f]*) return 1 ;;
    esac
    [ "${#provision_sha_digest}" -eq 64 ] || return 1
    printf '%s\n' "$provision_sha_digest"
}

is_verified_binary() {
    [ -f "$1" ] || return 1
    [ -x "$1" ] || return 1
    provision_candidate_sha=$(sha256_file "$1") || return 1
    [ "$provision_candidate_sha" = "$GITLEAKS_BINARY_SHA256" ] || return 1
    provision_candidate_version=$("$1" version 2>/dev/null) || return 1
    [ "$provision_candidate_version" = "$GITLEAKS_VERSION" ]
}

verify_checksum_entry() {
    provision_entry_digest=''
    provision_entry_count=0
    while IFS=' ' read -r provision_digest provision_name provision_remainder; do
        if [ "$provision_name" = "$GITLEAKS_ARCHIVE" ]; then
            provision_entry_digest=$provision_digest
            provision_entry_count=$((provision_entry_count + 1))
        fi
    done < "$1"

    [ "$provision_entry_count" -eq 1 ] || fail "official checksums file does not contain exactly one entry for $GITLEAKS_ARCHIVE"
    [ "$provision_entry_digest" = "$GITLEAKS_ARCHIVE_SHA256" ] || fail 'official archive checksum does not match the approved pin'
}

[ "$#" -eq 0 ] || fail 'this provisioner does not accept arguments'

require_command uname
require_command curl
require_command sha256sum
require_command tar
require_command mktemp
require_command mkdir
require_command chmod
require_command cp
require_command mv
require_command rm

check_platform
resolve_tool_dir

provision_script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || fail 'cannot resolve provisioning script directory'
provision_project_root=$(CDPATH= cd -P "$provision_script_dir/../.." && pwd) || fail 'cannot resolve project root'
case "$provision_tool_dir/" in
    "$provision_project_root"/*) fail 'Gitleaks must be provisioned outside the project tree' ;;
esac

provision_gitleaks=$provision_tool_dir/gitleaks
if is_verified_binary "$provision_gitleaks"; then
    printf 'Verified Gitleaks %s is already provisioned at %s\n' "$GITLEAKS_VERSION" "$provision_gitleaks"
    exit 0
fi

provision_temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/penny-gitleaks-v$GITLEAKS_VERSION.XXXXXX") ||
    fail 'cannot create temporary provisioning directory'
provision_checksums_path=$provision_temp_dir/$GITLEAKS_CHECKSUMS
provision_archive_path=$provision_temp_dir/$GITLEAKS_ARCHIVE

curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 \
    "$GITLEAKS_RELEASE_BASE$GITLEAKS_CHECKSUMS" \
    --output "$provision_checksums_path" || fail 'cannot download the pinned official checksums file'

provision_actual_checksums_sha=$(sha256_file "$provision_checksums_path") || fail 'cannot checksum the downloaded checksums file'
[ "$provision_actual_checksums_sha" = "$GITLEAKS_CHECKSUMS_SHA256" ] || fail 'downloaded checksums-file checksum is invalid'

verify_checksum_entry "$provision_checksums_path"

curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 \
    "$GITLEAKS_RELEASE_BASE$GITLEAKS_ARCHIVE" \
    --output "$provision_archive_path" || fail 'cannot download the pinned official Gitleaks archive'

provision_actual_archive_sha=$(sha256_file "$provision_archive_path") || fail 'cannot checksum the downloaded Gitleaks archive'
[ "$provision_actual_archive_sha" = "$GITLEAKS_ARCHIVE_SHA256" ] || fail 'downloaded Gitleaks archive checksum is invalid'

tar -xzf "$provision_archive_path" -C "$provision_temp_dir" || fail 'cannot extract the verified Gitleaks archive'
provision_extracted=$provision_temp_dir/gitleaks
[ -f "$provision_extracted" ] || fail 'verified archive does not contain the Gitleaks binary'
chmod 700 "$provision_extracted" || fail 'cannot make the extracted Gitleaks binary executable'

provision_extracted_sha=$(sha256_file "$provision_extracted") || fail 'cannot checksum the extracted Gitleaks binary'
[ "$provision_extracted_sha" = "$GITLEAKS_BINARY_SHA256" ] || fail 'extracted Gitleaks binary checksum is invalid'
provision_extracted_version=$("$provision_extracted" version 2>/dev/null) || fail 'cannot execute the verified extracted Gitleaks binary'
[ "$provision_extracted_version" = "$GITLEAKS_VERSION" ] || fail "extracted Gitleaks version is invalid: $provision_extracted_version"

mkdir -p "$provision_tool_dir" || fail "cannot create external tool directory: $provision_tool_dir"
provision_canonical_tool_dir=$(CDPATH= cd -P "$provision_tool_dir" && pwd) || fail 'cannot resolve external tool directory'
case "$provision_canonical_tool_dir/" in
    "$provision_project_root"/*) fail 'resolved Gitleaks tool directory is inside the project tree' ;;
esac

provision_install_temp=$(mktemp "$provision_tool_dir/.gitleaks.XXXXXX") || fail 'cannot create atomic install file'
cp "$provision_extracted" "$provision_install_temp" || fail 'cannot copy verified Gitleaks into the external tool directory'
chmod 700 "$provision_install_temp" || fail 'cannot set Gitleaks executable permissions'
is_verified_binary "$provision_install_temp" || fail 'installed Gitleaks candidate did not pass checksum and version verification'

mv -f "$provision_install_temp" "$provision_gitleaks" || fail 'cannot atomically publish the verified Gitleaks binary'
provision_install_temp=''
is_verified_binary "$provision_gitleaks" || fail 'published Gitleaks did not pass final checksum and version verification'

printf 'Provisioned verified Gitleaks %s at %s\n' "$GITLEAKS_VERSION" "$provision_gitleaks"
