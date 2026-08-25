#!/bin/sh
# End-to-end tests for the pinned Gitleaks provisioner and scan wrapper.
# All Git fixtures and provisioned test tools live under one fresh external temp tree.

set -eu

EXPECTED_GITLEAKS_VERSION='8.30.1'
EXPECTED_GITLEAKS_BINARY_SHA256='88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509'
TESTS_RUN=0
TEST_ROOT=''

pass() {
    TESTS_RUN=$((TESTS_RUN + 1))
    printf 'ok %s - %s\n' "$TESTS_RUN" "$1"
}

fail() {
    printf 'not ok - %s\n' "$1" >&2
    exit 1
}

cleanup() {
    cleanup_status=$?
    trap - 0 1 2 3 15
    if [ -n "$TEST_ROOT" ]; then
        rm -rf "$TEST_ROOT"
        if [ -e "$TEST_ROOT" ]; then
            printf 'not ok - temporary test tree cleanup failed: %s\n' "$TEST_ROOT" >&2
            exit 1
        fi
        printf 'ok %s - temporary Git repo and provisioned test tool were removed\n' "$((TESTS_RUN + 1))"
    fi
    exit "$cleanup_status"
}

trap cleanup 0
trap 'exit 1' 1 2 3 15

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || fail 'cannot resolve test script directory'
PROJECT_ROOT=$(CDPATH= cd -P "$SCRIPT_DIR/../../.." && pwd) || fail 'cannot resolve project root'
PROVISION=$PROJECT_ROOT/scripts/security/provision-gitleaks.sh
SCANNER=$PROJECT_ROOT/scripts/security/scan-secrets.sh
CONFIG=$PROJECT_ROOT/.gitleaks.toml

for test_command in git curl sha256sum grep mktemp rm cp chmod sh; do
    command -v "$test_command" >/dev/null 2>&1 || fail "required test command is unavailable: $test_command"
done

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/penny-gitleaks-test.XXXXXX") || fail 'cannot create temporary test tree'
case "$TEST_ROOT/" in
    "$PROJECT_ROOT"/*) fail 'temporary test tree was created inside Penny' ;;
esac
REPO=$TEST_ROOT/repo
TOOL_DIR=$TEST_ROOT/tool
OUTPUT=$TEST_ROOT/output.txt
GITLEAKS=$TOOL_DIR/gitleaks

run_capture() {
    capture_output=$1
    shift
    set +e
    "$@" > "$capture_output" 2>&1
    RUN_STATUS=$?
    set -e
}

assert_status() {
    status_label=$1
    status_expected=$2
    if [ "$RUN_STATUS" -ne "$status_expected" ]; then
        cat "$OUTPUT" >&2
        fail "$status_label: expected exit $status_expected, received $RUN_STATUS"
    fi
    pass "$status_label exits $status_expected"
}

assert_output_contains() {
    output_label=$1
    output_text=$2
    if ! grep -F "$output_text" "$OUTPUT" >/dev/null 2>&1; then
        cat "$OUTPUT" >&2
        fail "$output_label: output did not contain '$output_text'"
    fi
    pass "$output_label reports a finding"
}

run_wrapper() {
    (
        cd "$REPO" || exit 2
        PENNY_GITLEAKS_DIR=$TOOL_DIR sh "$SCANNER" "$@"
    )
}

write_fake_token() {
    fake_prefix='glpat-'
    fake_suffix='0123456789abcdefghij'
    printf 'gitlab_token = "%s%s"\n' "$fake_prefix" "$fake_suffix"
}

PENNY_GITLEAKS_DIR=$TOOL_DIR sh "$PROVISION" > "$OUTPUT" 2>&1 || {
    cat "$OUTPUT" >&2
    fail 'pinned Gitleaks provisioning failed'
}
[ -x "$GITLEAKS" ] || fail 'provisioner did not create the expected executable'
[ "$("$GITLEAKS" version)" = "$EXPECTED_GITLEAKS_VERSION" ] ||
    fail "provisioned Gitleaks version is not $EXPECTED_GITLEAKS_VERSION"
test_binary_sha_output=$(sha256sum "$GITLEAKS") || fail 'cannot checksum provisioned Gitleaks in test'
test_binary_sha=${test_binary_sha_output%% *}
[ "$test_binary_sha" = "$EXPECTED_GITLEAKS_BINARY_SHA256" ] ||
    fail 'provisioned Gitleaks binary checksum is not the approved derived pin'
pass 'provisioner installs the checksum- and version-verified pinned binary outside Penny'

git init -q "$REPO"
git -C "$REPO" config user.name 'TS-145 Test'
git -C "$REPO" config user.email 'ts-145@example.invalid'
cp "$CONFIG" "$REPO/.gitleaks.toml"
printf '%s\n' 'clean baseline' > "$REPO/README.md"
git -C "$REPO" add .gitleaks.toml README.md
git -C "$REPO" commit -q -m 'clean baseline'
BASE_COMMIT=$(git -C "$REPO" rev-parse HEAD)
case "$REPO/" in
    "$PROJECT_ROOT"/*) fail 'Git fixture was created inside Penny' ;;
esac
pass 'fresh Git fixture is outside Penny'

write_fake_token > "$REPO/staged.txt"
git -C "$REPO" add staged.txt
printf '%s\n' 'clean working tree replacement' > "$REPO/staged.txt"

run_capture "$OUTPUT" "$GITLEAKS" git \
    --staged \
    --config "$REPO/.gitleaks.toml" \
    --exit-code 1 \
    --ignore-gitleaks-allow \
    --no-banner \
    --no-color \
    --redact=100 \
    --verbose \
    "$REPO"
assert_status 'raw staged scan of index-only fake token' 1
assert_output_contains 'raw staged scan' 'gitlab-pat'

run_capture "$OUTPUT" run_wrapper staged
assert_status 'wrapper staged scan of index-only fake token' 1
assert_output_contains 'wrapper staged scan' 'gitlab-pat'

git -C "$REPO" reset -q HEAD -- staged.txt
write_fake_token > "$REPO/staged.txt"
run_capture "$OUTPUT" run_wrapper staged
assert_status 'wrapper staged scan ignores an untracked working-tree-only fake token' 0
rm -f "$REPO/staged.txt"

write_fake_token > "$REPO/range.txt"
git -C "$REPO" add range.txt
git -C "$REPO" commit -q -m 'introduce fake token'
SECRET_COMMIT=$(git -C "$REPO" rev-parse HEAD)

run_capture "$OUTPUT" "$GITLEAKS" git \
    --log-opts="$BASE_COMMIT..$SECRET_COMMIT" \
    --config "$REPO/.gitleaks.toml" \
    --exit-code 1 \
    --ignore-gitleaks-allow \
    --no-banner \
    --no-color \
    --redact=100 \
    --verbose \
    "$REPO"
assert_status 'raw exact-range scan of committed fake token' 1
assert_output_contains 'raw exact-range scan' 'gitlab-pat'

run_capture "$OUTPUT" run_wrapper range "$BASE_COMMIT..$SECRET_COMMIT"
assert_status 'wrapper exact-range scan of committed fake token' 1
assert_output_contains 'wrapper exact-range scan' 'gitlab-pat'

printf '%s\n' 'clean range content' > "$REPO/range.txt"
git -C "$REPO" add range.txt
git -C "$REPO" commit -q -m 'remove fake token'
CLEAN_COMMIT=$(git -C "$REPO" rev-parse HEAD)
run_capture "$OUTPUT" run_wrapper range "$SECRET_COMMIT..$CLEAN_COMMIT"
assert_status 'wrapper clean exact range excludes the earlier fake-token introduction' 0

run_capture "$OUTPUT" run_wrapper range
assert_status 'wrapper rejects a missing range' 2
run_capture "$OUTPUT" run_wrapper range HEAD
assert_status 'wrapper rejects a supplied value that is not a range' 2
run_capture "$OUTPUT" run_wrapper range 'missing-ref..HEAD'
assert_status 'wrapper rejects a range with an invalid endpoint' 2

MISSING_TOOL_DIR=$TEST_ROOT/missing-tool
run_capture "$OUTPUT" sh -c 'cd "$1" && PENNY_GITLEAKS_DIR=$2 sh "$3" staged' sh "$REPO" "$MISSING_TOOL_DIR" "$SCANNER"
assert_status 'wrapper fails closed when the verified tool is unavailable' 2

TAMPERED_TOOL_DIR=$TEST_ROOT/tampered-tool
mkdir -p "$TAMPERED_TOOL_DIR"
cp "$GITLEAKS" "$TAMPERED_TOOL_DIR/gitleaks"
printf '%s\n' 'tampered' >> "$TAMPERED_TOOL_DIR/gitleaks"
chmod 700 "$TAMPERED_TOOL_DIR/gitleaks"
run_capture "$OUTPUT" sh -c 'cd "$1" && PENNY_GITLEAKS_DIR=$2 sh "$3" staged' sh "$REPO" "$TAMPERED_TOOL_DIR" "$SCANNER"
assert_status 'wrapper fails closed on a wrong binary checksum' 2
if ! grep -F 'checksum is invalid' "$OUTPUT" >/dev/null 2>&1; then
    cat "$OUTPUT" >&2
    fail 'wrong-checksum failure was not reported clearly'
fi
pass 'wrong binary checksum is reported before scan execution'

printf '1..%s\n' "$((TESTS_RUN + 1))"
