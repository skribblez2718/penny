#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SCRIPT=$ROOT/scripts/setup/controlled-host-bootstrap.sh
D=1234567890123456789012345678901234567890123456789012345678901234
args=(--bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bash -n "$SCRIPT"
python3 "$ROOT/scripts/setup/tests/controlled-host-archive.test.py" "$SCRIPT"
python3 "$ROOT/scripts/setup/tests/controlled-host-output.test.py" "$SCRIPT"
# Execute the copied shebang directly: inherited PATH and BASH_ENV must not
# execute attacker-supplied code before the first line of bootstrap logic.
cp "$SCRIPT" "$tmp/privileged-copy"
chmod 700 "$tmp/privileged-copy"
mkdir "$tmp/attacker"
printf '#!/bin/sh\necho fake-bash > "$ATTACK_MARK"\nexit 99\n' > "$tmp/attacker/bash"
chmod +x "$tmp/attacker/bash"
printf 'echo sourced-bash-env > "$ATTACK_ENV_MARK"\n' > "$tmp/attacker/env"
ATTACK_MARK=$tmp/path-mark ATTACK_ENV_MARK=$tmp/env-mark BASH_ENV=$tmp/attacker/env PATH=$tmp/attacker:/usr/bin:/bin \
    "$tmp/privileged-copy" --mode plan "${args[@]}" > "$tmp/clean-plan"
[[ ! -e $tmp/path-mark && ! -e $tmp/env-mark ]] || { echo 'pre-interpreter injection executed' >&2; exit 1; }
grep -q 'PLAN only' "$tmp/clean-plan"
ATTACK_MARK=$tmp/path-mark ATTACK_ENV_MARK=$tmp/env-mark BASH_ENV=$tmp/attacker/env PATH=$tmp/attacker:/usr/bin:/bin \
    /bin/bash -p -- "$tmp/privileged-copy" --mode plan "${args[@]}" > "$tmp/explicit-plan"
[[ ! -e $tmp/path-mark && ! -e $tmp/env-mark ]] || { echo 'explicit interpreter injection executed' >&2; exit 1; }
grep -q 'PLAN only' "$tmp/explicit-plan"
# No privileged command may be invoked in plan mode.
SCRIPT=$SCRIPT D=$D bash -c '
    nft() { echo unexpected-nft >&2; exit 88; }
    ip() { echo unexpected-ip >&2; exit 88; }
    systemctl() { echo unexpected-systemctl >&2; exit 88; }
    export -f nft ip systemctl
    source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda
    unit offline; unit osv; unit p07; slice_unit; ns_rules; host_rules
' > "$tmp/generated"
grep -Fq 'iifname "pscah0" oifname "eth0" ip saddr' "$tmp/generated"
grep -Fq 'iifname "eth0" oifname "pscah0" ip saddr' "$tmp/generated"
grep -Fq 'oifname "pscan0" ip daddr { 8.8.8.8 } meta l4proto tcp tcp dport 443 accept' "$tmp/generated"
# Model rule order for the admitted tuple on the alternate route. Only the
# exact-interface allow may precede the default drop for either direction.
python3 - "$tmp/generated" <<'PY'
import pathlib, sys
rules = [line for line in pathlib.Path(sys.argv[1]).read_text().splitlines()
         if line.startswith('add rule inet penny_sca_host forward')]
assert len(rules) == 4, rules
outbound = [r for r in rules if 'iifname "pscah0"' in r]
reply = [r for r in rules if 'oifname "pscah0"' in r]
assert len(outbound) == len(reply) == 2
assert 'oifname "eth0"' in outbound[0] and outbound[0].endswith(' accept')
assert outbound[1].endswith(' drop') and 'oifname ' not in outbound[1]
assert 'iifname "eth0"' in reply[0] and reply[0].endswith(' accept')
assert reply[1].endswith(' drop') and 'iifname ' not in reply[1]
# An outbound 443 packet routed to eth1, and its reply arriving from eth1,
# cannot match the allows and must reach the later direction-specific drop.
for allow, deny, mismatch in ((outbound[0], outbound[1], 'eth1'), (reply[0], reply[1], 'eth1')):
    assert mismatch not in allow and deny.endswith(' drop')
PY
if command -v unshare >/dev/null && unshare -Urn true 2>/dev/null; then
    SCRIPT=$SCRIPT D=$D bash -c 'source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null; host_rules' > "$tmp/host.rules"
    SCRIPT=$SCRIPT D=$D bash -c 'source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null; ns_rules' > "$tmp/ns.rules"
    unshare -Urn nft -c -f "$tmp/host.rules"
    unshare -Urn nft -c -f "$tmp/ns.rules"
fi
! grep -Eq 'WantedBy=|ExecStart=.*/home/' "$tmp/generated"
for expected in 'ConditionPathExists=/etc/penny-sca/activation-authorized' 'Slice=penny-sca.slice' 'StandardOutput=null' 'StandardError=null' 'DevicePolicy=closed' 'CPUQuota=100%' 'MemoryMax=2G' 'TasksMax=128' 'IOReadBandwidthMax=/dev/sda 16M' 'IOWriteBandwidthMax=/dev/sda 16M' 'ProtectProc=invisible' 'ProcSubset=pid' 'PrivateIPC=yes' 'ProtectHome=yes' 'NoNewPrivileges=yes' 'TemporaryFileSystem=/var/lib/penny-sca:rw,size=128M,mode=1777' 'TemporaryFileSystem=/tmp:rw,size=64M' 'TemporaryFileSystem=/var/tmp:rw,size=64M' 'TemporaryFileSystem=/dev/shm:rw,size=32M' '/run/containerd' '/run/podman' '/var/lib/docker'; do
    grep -Fq "$expected" "$tmp/generated" || { echo "missing $expected" >&2; exit 1; }
done
proxy_line=$(grep '^UnsetEnvironment=' "$tmp/generated" | head -1)
for proxy in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY FTP_PROXY http_proxy https_proxy all_proxy no_proxy ftp_proxy PROXY proxy; do
    [[ " ${proxy_line#UnsetEnvironment=} " == *" $proxy "* ]] || { echo "proxy environment not cleared: $proxy" >&2; exit 1; }
done
for kind in offline osv p07; do
    SCRIPT=$SCRIPT D=$D KIND=$kind bash -c 'source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null; unit "$KIND"' > "$tmp/penny-sca-$kind@.service"
done
SCRIPT=$SCRIPT D=$D bash -c 'source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null; slice_unit' > "$tmp/penny-sca.slice"
for kind in offline osv p07; do
    grep -q '^Slice=penny-sca.slice$' "$tmp/penny-sca-$kind@.service"
    grep -q '^StandardOutput=null$' "$tmp/penny-sca-$kind@.service"
    grep -q '^StandardError=null$' "$tmp/penny-sca-$kind@.service"
done
! grep -q 'DeviceAllow=/dev/kvm' "$tmp/penny-sca-p07@.service"
grep -q '^PrivateDevices=yes$' "$tmp/penny-sca-p07@.service"
SCRIPT=$SCRIPT D=$D bash -c 'source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda --kvm yes >/dev/null; unit p07' > "$tmp/kvm-yes"
grep -q '^DeviceAllow=/dev/kvm rw$' "$tmp/kvm-yes"
grep -q '^PrivateDevices=no$' "$tmp/kvm-yes"
# Isolate systemd's unit search path: require ONLY the two expected fixture
# diagnostics per unit (no sysinit.target, no staged release executable).
if command -v systemd-analyze >/dev/null; then
    status=0
    SYSTEMD_UNIT_PATH="$tmp" systemd-analyze verify "$tmp"/penny-sca-*@.service "$tmp/penny-sca.slice" > "$tmp/analyze" 2>&1 || status=$?
    [[ $status == 1 && $(wc -l < "$tmp/analyze") == 6 ]] || { cat "$tmp/analyze" >&2; exit 1; }
    while IFS= read -r line; do
        [[ $line =~ ^penny-sca-(offline|osv|p07)@i.service:\ Failed\ to\ create\ penny-sca-(offline|osv|p07)@i.service/start:\ Unit\ sysinit.target\ not\ found\.$ ]] ||
        [[ $line =~ ^penny-sca-(offline|osv|p07)@i.service:\ Command\ /opt/penny-sca/releases/[a-f0-9]{64}/bin/p0[27]-[a-z-]+\ is\ not\ executable:\ No\ such\ file\ or\ directory$ ]] || { echo "unexpected systemd diagnostic: $line" >&2; exit 1; }
    done < "$tmp/analyze"
fi
for ip in 127.0.0.1 192.88.99.10 192.0.2.10 169.254.169.254 10.0.0.1 100.64.0.1 198.19.0.1 203.0.113.8 224.0.0.1 8.8.8.0 008.8.8.8; do
    if bash "$SCRIPT" --mode plan "${args[@]:0:6}" --osv-ip "$ip" "${args[@]:8}" > "$tmp/out" 2>&1; then echo "accepted invalid address $ip" >&2; exit 1; fi
done
if bash "$SCRIPT" --mode plan "${args[@]}" --osv-ip 1.1.1.1 > "$tmp/out" 2>&1; then echo 'duplicate accepted' >&2; exit 1; fi
for list in '8.8.8.8,,9.9.9.9' '8.8.8.8,8.8.8.8'; do
    if bash "$SCRIPT" --mode plan "${args[@]:0:6}" --osv-ip "$list" "${args[@]:8}" > "$tmp/out" 2>&1; then echo "invalid list accepted: $list" >&2; exit 1; fi
done
if bash "$SCRIPT" --mode plan --mode plan "${args[@]}" > "$tmp/out" 2>&1; then echo 'duplicate mode accepted' >&2; exit 1; fi
if bash "$SCRIPT" --mode apply "${args[@]}" --confirm NO > "$tmp/out" 2>&1; then echo 'incorrect token accepted' >&2; exit 1; fi
if (( EUID != 0 )); then
    if bash "$SCRIPT" --mode apply "${args[@]}" --confirm APPLY-penny-sca > "$tmp/out" 2>&1; then echo 'non-root apply accepted' >&2; exit 1; fi
    if bash "$SCRIPT" --mode rollback --confirm ROLLBACK-penny-sca > "$tmp/out" 2>&1; then echo 'non-root rollback accepted' >&2; exit 1; fi
fi
# Successful absence probes must return success even though each underlying
# nft lookup returns nonzero for an unused table. This guards `set -e` callers.
python3 - "$SCRIPT" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
body = text.split("check_unused_network_resources() {", 1)[1].split("\n}", 1)[0]
assert "if nft list table $table" in body
assert "nft list table $table >/dev/null 2>&1 &&" not in body
assert body.rstrip().endswith("return 0")
PY
SCRIPT=$SCRIPT D=$D bash -c '
    source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null
    ip() {
        case "$*" in
            "route show 10.231.94.0/30"|"netns list") return 0 ;;
            "link show dev pscah0") return 1 ;;
            *) return 1 ;;
        esac
    }
    nft() { return 1; }
    export -f ip nft
    check_unused_network_resources
'
# Missing effective controller fails even when cgroup.controllers advertises it.
SCRIPT=$SCRIPT D=$D T=$tmp bash -c '
    source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null
    printf "cpu memory pids io\n" > "$T/cgroup.controllers"
    printf "cpu memory pids\n" > "$T/cgroup.subtree_control"
    if ( check_controllers "$T" ) >/dev/null 2>&1; then echo "missing io accepted" >&2; exit 1; fi
    printf "cpu memory pids io\n" > "$T/cgroup.subtree_control"
    check_controllers "$T"
'
# Preseed a mock /etc/penny-sca/trust tree; no apply path is entered.
SCRIPT=$SCRIPT D=$D T=$tmp bash -c '
    source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null
    root_path() { :; } # Only ownership simulation, not a test of root_path.
    TRUST=$T/mockroot/etc/penny-sca/trust; CONFIG=$T/mockroot/etc/penny-sca
    TRUST_KEY=$TRUST/reviewer.pem; TRUST_PIN=$TRUST/reviewer.sha256; TRUST_ID=$TRUST/reviewer.id
    mkdir -p "$TRUST"
    chmod 700 "$CONFIG" "$TRUST"
    APPROVAL=$T/approval; SIGNATURE=$T/signature
    openssl genpkey -algorithm ED25519 -out "$T/private.pem" >/dev/null 2>&1
    openssl pkey -in "$T/private.pem" -pubout -out "$TRUST_KEY" >/dev/null 2>&1
    openssl pkey -pubin -in "$TRUST_KEY" -outform DER | sha256sum | cut -d" " -f1 > "$TRUST_PIN"
    printf "reviewer-one\n" > "$TRUST_ID"
    chmod 600 "$TRUST_KEY" "$TRUST_PIN" "$TRUST_ID"
    issued=$(date -u -d "1 minute ago" +%Y-%m-%dT%H:%M:%SZ)
    expires=$(date -u -d "1 hour" +%Y-%m-%dT%H:%M:%SZ)
    approval_record "$issued" "$expires" reviewer-one > "$APPROVAL"
    openssl pkeyutl -sign -inkey "$T/private.pem" -rawin -in "$APPROVAL" -out "$SIGNATURE"
    # Emulate root ownership only for the mock root tree and signed fixtures.
    stat() {
        if [[ $1 == -c && $* == *"$T/"* ]]; then
            case $2 in
                %u:%g:%a:%h) printf "0:0:%s:%s\n" "$(command stat -c %a -- "${@: -1}")" "$(command stat -c %h -- "${@: -1}")"; return ;;
                %u:%g:%a) printf "0:0:%s\n" "$(command stat -c %a -- "${@: -1}")"; return ;;
            esac
        fi
        command stat "$@"
    }
    approval_gate
    chmod 644 "$TRUST_KEY"
    if ( approval_gate ) >/dev/null 2>&1; then echo "public trust key mode accepted" >&2; exit 1; fi
    chmod 600 "$TRUST_KEY"
    chmod 777 "$TRUST"
    if ( approval_gate ) >/dev/null 2>&1; then echo "writable trust directory accepted" >&2; exit 1; fi
    chmod 700 "$TRUST"
    openssl genpkey -algorithm ED25519 -out "$T/other-private" >/dev/null 2>&1
    openssl pkey -in "$T/other-private" -pubout -out "$T/other-public" >/dev/null 2>&1
    openssl pkeyutl -sign -inkey "$T/other-private" -rawin -in "$APPROVAL" -out "$SIGNATURE"
    if ( approval_gate ) >/dev/null 2>&1; then echo "other signer accepted" >&2; exit 1; fi
    openssl pkeyutl -sign -inkey "$T/private.pem" -rawin -in "$APPROVAL" -out "$SIGNATURE"
    cp "$TRUST_PIN" "$T/valid-pin"
    printf "%064d\n" 0 > "$TRUST_PIN"
    if ( approval_gate ) >/dev/null 2>&1; then echo "wrong fingerprint accepted" >&2; exit 1; fi
    cp "$T/valid-pin" "$TRUST_PIN"
    printf "reviewer-two\n" > "$TRUST_ID"
    if ( approval_gate ) >/dev/null 2>&1; then echo "wrong reviewer accepted" >&2; exit 1; fi
    printf "reviewer-one\n" > "$TRUST_ID"
    KVM=yes
    if ( approval_gate ) >/dev/null 2>&1; then echo "KVM substitution accepted" >&2; exit 1; fi
    KVM=no
    DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    if ( approval_gate ) >/dev/null 2>&1; then echo "bundle substitution accepted" >&2; exit 1; fi
    DIGEST=$D
    cp "$SIGNATURE" "$T/valid-signature"
    printf x | dd of="$SIGNATURE" bs=1 seek=0 count=1 conv=notrunc status=none
    if ( approval_gate ) >/dev/null 2>&1; then echo "bad signature accepted" >&2; exit 1; fi
    cp "$T/valid-signature" "$SIGNATURE"
    sed -i "s/egress_if=eth0/egress_if=eth1/" "$APPROVAL"
    if ( approval_gate ) >/dev/null 2>&1; then echo "tampered approval accepted" >&2; exit 1; fi
    approval_record "$issued" "$expires" reviewer-one > "$APPROVAL"
    printf "extra\n" >> "$APPROVAL"
    if ( approval_gate ) >/dev/null 2>&1; then echo "noncanonical approval accepted" >&2; exit 1; fi
    approval_record 2000-01-01T00:00:00Z 2000-01-01T01:00:00Z reviewer-one > "$APPROVAL"
    if ( approval_gate ) >/dev/null 2>&1; then echo "expired approval accepted" >&2; exit 1; fi
'
# Transition helper failure injection: a route-delete failure must not delete
# the veth or table; a re-entry can finish after the route was removed.
SCRIPT=$SCRIPT D=$D T=$tmp bash -c '
    source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null
    NS_HASH=pending; HOST_HASH=pending; NAT_HASH=pending; PHASE=applying
    if ( require_rollback_phase ) >/dev/null 2>&1; then echo "interrupted apply rolled back" >&2; exit 1; fi
    NS_HASH=hash; HOST_HASH=hash; NAT_HASH=hash; PHASE=disconnecting
    require_rollback_phase
    table_digest() { [[ -e $T/drift ]] && echo substituted || echo hash; }
    nft() { echo "$*" >> "$T/rollback-calls"; }
    ip() {
        echo "ip $*" >> "$T/rollback-calls"
        case "$*" in
            "netns list") [[ -e $T/ns-removed ]] || echo "penny-sca-osv (id: 1)" ;;
            "netns pids "*) : ;;
            "-n penny-sca-osv route show default") [[ -e $T/route-removed ]] || echo "default via 10.231.94.1 dev pscan0" ;;
            "-n penny-sca-osv route del "*) [[ -e $T/fail-once ]] && { rm "$T/fail-once"; return 1; }; touch "$T/route-removed" ;;
            "link show dev pscah0") [[ ! -e $T/link-removed ]] ;;
            "link del pscah0") touch "$T/link-removed" ;;
            "netns del penny-sca-osv") touch "$T/ns-removed" ;;
        esac
    }
    export -f ip nft
    touch "$T/fail-once"
    if ( disconnect_network ) >/dev/null 2>&1; then exit 1; fi
    [[ ! -e $T/link-removed ]] || exit 1
    touch "$T/drift"
    if ( disconnect_network ) >/dev/null 2>&1; then echo "drift accepted" >&2; exit 1; fi
    [[ ! -e $T/link-removed ]] || exit 1
    rm "$T/drift"
    disconnect_network
    [[ -e $T/link-removed && -e $T/ns-removed ]] || exit 1
    remove_tables
    [[ $(grep -n "delete table inet penny_sca_host" "$T/rollback-calls" | cut -d: -f1) -gt $(grep -n "ip link del pscah0" "$T/rollback-calls" | cut -d: -f1) ]] || exit 1
'
# Interrupted table teardown re-enters only after link and namespace are gone;
# already-removed dedicated tables remain absent, remaining table is checked.
SCRIPT=$SCRIPT D=$D T=$tmp bash -c '
    source "$SCRIPT" --mode plan --bundle /root/admitted/release.tar --sha256 "$D" --egress-if eth0 --osv-ip 8.8.8.8 --io-device /dev/sda >/dev/null
    HOST_HASH=hash; NAT_HASH=hash
    table_digest() { echo hash; }
    ip() { case "$*" in "link show dev pscah0") return 1 ;; "netns list") : ;; *) return 1 ;; esac; }
    nft() {
        case "$*" in
            "list tables") : ;;
            "list table inet penny_sca_host") [[ ! -e $T/host-gone ]] ;;
            "list table ip penny_sca_nat") [[ ! -e $T/nat-gone ]] ;;
            "delete table inet penny_sca_host") touch "$T/host-gone" ;;
            "delete table ip penny_sca_nat")
                [[ ! -e $T/fail-nat ]] || { rm "$T/fail-nat"; return 1; }
                touch "$T/nat-gone" ;;
            *) return 1 ;;
        esac
    }
    touch "$T/fail-nat"
    if ( remove_tables ) >/dev/null 2>&1; then echo "partial table teardown succeeded" >&2; exit 1; fi
    [[ -e $T/host-gone && ! -e $T/nat-gone ]] || exit 1
    remove_tables
    [[ -e $T/nat-gone ]] || exit 1
'
# A checklist is NOT_RUN; static verify requires a separate output path.
bash "$SCRIPT" --mode live-checklist --evidence "$tmp/checklist" >/dev/null
grep -q NOT_RUN "$tmp/checklist"
if bash "$SCRIPT" --mode verify > "$tmp/out" 2>&1; then echo 'verify without output accepted' >&2; exit 1; fi
if bash "$SCRIPT" --mode plan "${args[@]}" --approval-key "$tmp/other-public" > "$tmp/out" 2>&1; then echo 'caller key option accepted' >&2; exit 1; fi
printf 'controlled-host nonroot/negative/static tests passed\n'
