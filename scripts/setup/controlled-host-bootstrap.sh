#!/bin/bash -p
# Reviewed, root-admitted offline bootstrap. NEVER run this copy from a writable checkout as root.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset CDPATH ENV BASH_ENV
# Refuse shell function injection through an inherited root environment.
if (( EUID == 0 )); then
    while IFS= read -r inherited_function; do unset -f "$inherited_function"; done < <(compgen -A function)
    unset inherited_function
fi

BASE=/opt/penny-sca
CONFIG=/etc/penny-sca
STATE=/var/lib/penny-sca-bootstrap
EVIDENCE_DIR=$STATE/evidence
TRUST=/etc/penny-sca/trust
TRUST_KEY=$TRUST/reviewer.pem
TRUST_PIN=$TRUST/reviewer.sha256
TRUST_ID=$TRUST/reviewer.id
DATA=/var/lib/penny-sca
UNITS=/etc/systemd/system
NS=penny-sca-osv
HOST_IF=pscah0
GUEST_IF=pscan0
MANIFEST=$STATE/manifest
AUDIT=$STATE/audit.log
INVENTORY=$CONFIG/inventory
MODE=plan BUNDLE= DIGEST= EGRESS_IF= IO_DEVICE= IPS= KVM=no CONFIRM=
APPROVAL= SIGNATURE= EVIDENCE=
MODE_SET=no KVM_SET=no
SELF=$(realpath -e -- "${BASH_SOURCE[0]}")

usage() { cat <<'EOF'
Usage: controlled-host-bootstrap.sh [--mode plan|apply|verify|rollback|live-checklist]
  [--bundle /root/admitted/release.tar --sha256 64-hex-digest]
  [--egress-if IFACE --osv-ip IPv4[,IPv4...] --io-device /dev/DEVICE]
  [--kvm yes|no] [--confirm APPLY-penny-sca|ROLLBACK-penny-sca]
  [--approval /root/approval.txt --signature /root/approval.sig]
  [--evidence /var/lib/penny-sca-bootstrap/evidence/receipt.json]
Default plan is read-only. Apply requires a pre-established pinned trust anchor.
Root verify/checklist outputs must be fresh entries in the fixed bootstrap evidence directory.
Nonroot live-checklist may write only into its own private scratch directory.
Apply requires a root-owned, symlink-free bootstrap copy and tarball, with non-writable ancestors.
No services are enabled or started. A running service blocks rollback.
EOF
}
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
while (($#)); do
    case $1 in
        --mode|--bundle|--sha256|--egress-if|--osv-ip|--io-device|--kvm|--confirm|--approval|--signature|--evidence)
            (($# >= 2)) || die "missing value for $1"
            case $1 in
                --mode) [[ $MODE_SET == no ]] || die 'duplicate mode'; MODE=$2; MODE_SET=yes ;;
                --bundle) [[ -z $BUNDLE ]] || die 'duplicate bundle'; BUNDLE=$2 ;;
                --sha256) [[ -z $DIGEST ]] || die 'duplicate sha256'; DIGEST=$2 ;;
                --egress-if) [[ -z $EGRESS_IF ]] || die 'duplicate egress-if'; EGRESS_IF=$2 ;;
                --osv-ip) [[ -z $IPS ]] || die 'duplicate osv-ip'; IPS=$2 ;;
                --io-device) [[ -z $IO_DEVICE ]] || die 'duplicate io-device'; IO_DEVICE=$2 ;;
                --kvm) [[ $KVM_SET == no ]] || die 'duplicate kvm'; KVM=$2; KVM_SET=yes ;;
                --confirm) [[ -z $CONFIRM ]] || die 'duplicate confirm'; CONFIRM=$2 ;;
                --approval) [[ -z $APPROVAL ]] || die 'duplicate approval'; APPROVAL=$2 ;;
                --signature) [[ -z $SIGNATURE ]] || die 'duplicate signature'; SIGNATURE=$2 ;;
                --evidence) [[ -z $EVIDENCE ]] || die 'duplicate evidence'; EVIDENCE=$2 ;;
            esac
            shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unexpected option: $1" ;;
    esac
done
[[ $MODE == plan || $MODE == apply || $MODE == verify || $MODE == rollback || $MODE == live-checklist ]] || die 'invalid mode'
[[ $KVM == yes || $KVM == no ]] || die 'invalid kvm setting'
[[ -z $CONFIRM || ( $MODE == apply && $CONFIRM == APPLY-penny-sca ) || ( $MODE == rollback && $CONFIRM == ROLLBACK-penny-sca ) ]] || die 'invalid confirmation token'
if [[ $MODE == apply || $MODE == rollback ]]; then
    (( EUID == 0 )) || die 'apply/rollback require root'
    [[ $CONFIRM == "${MODE^^}-penny-sca" ]] || die 'explicit confirmation required'
fi
# Check each ancestor, not just the leaf. No symlink, non-root owner or writable ancestor.
root_path() {
    local p=$1 part current= owner mode
    [[ $p == /* && $p != *//* ]] || die 'path must be absolute'
    [[ $p != *$'\n'* ]] || die 'newline in path'
    IFS=/ read -r -a parts <<< "${p#/}"
    for part in "${parts[@]}"; do
        [[ -n $part && $part != . && $part != .. ]] || die "unsafe path: $p"
        current+=/$part
        [[ ! -L $current ]] || die "symlink: $current"
        if [[ -e $current ]]; then
            owner=$(stat -c %u -- "$current")
            mode=$(stat -c %a -- "$current")
            [[ $owner == 0 && $((8#$mode & 0022)) == 0 ]] || die "non-root or writable: $current"
        fi
    done
}
if [[ $MODE != plan && ( $MODE != live-checklist || $EUID == 0 ) ]]; then
    root_path "$SELF"
    [[ -f $SELF && ! -L $SELF ]] || die 'root-admitted bootstrap required'
fi
validate_ips() {
    [[ $IPS =~ ^[0-9.,]+$ && ${#IPS} -le 512 && $IPS != ,* && $IPS != *, && $IPS != *,,* ]] || die 'invalid IPv4 list'
    local ip octets a b c d
    local -A seen=()
    IFS=, read -r -a iplist <<< "$IPS"
    ((${#iplist[@]} > 0 && ${#iplist[@]} <= 16)) || die 'IPv4 list count'
    for ip in "${iplist[@]}"; do
        [[ $ip =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || die "invalid IPv4: $ip"
        [[ ! -v seen[$ip] ]] || die "duplicate IPv4: $ip"
        seen[$ip]=1
        IFS=. read -r a b c d <<< "$ip"
        for octets in "$a" "$b" "$c" "$d"; do ((octets <= 255)) || die "invalid IPv4: $ip"; done
        # Public unicast only; reject private, shared, documentation, benchmarking,
        # reserved, multicast, and the deprecated 192.88.99/24 relay range.
        if (( a == 0 || a == 10 || a == 127 || a >= 224 || a == 100 && b >= 64 && b <= 127 ||
              a == 169 && b == 254 || a == 172 && b >= 16 && b <= 31 ||
              a == 192 && (b == 0 || b == 168 || b == 88 && c == 99 || b == 31 && c == 196 || b == 52 && c == 193 || b == 175 && c == 48) ||
              a == 198 && (b == 18 || b == 19 || b == 51 && c == 100) ||
              a == 203 && b == 0 && c == 113 )); then die "non-public IPv4: $ip"; fi
        [[ $d != 0 && $d != 255 ]] || die "conservatively rejected address: $ip"
    done
}
validate_input() {
    [[ $DIGEST =~ ^[a-f0-9]{64}$ ]] || die 'exact sha256 required'
    if [[ ${1:-yes} == yes ]]; then
        [[ $BUNDLE == /* && $BUNDLE == *.tar ]] || die 'absolute tar path required'
    fi
    [[ $EGRESS_IF =~ ^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$ && $EGRESS_IF != "$HOST_IF" && $EGRESS_IF != "$GUEST_IF" ]] || die 'invalid egress interface'
    [[ $IO_DEVICE =~ ^/dev/[a-zA-Z0-9_-]+$ ]] || die 'invalid block device path'
    validate_ips
}
# Reviewer signs the exact bytes of this fixed-order, newline-terminated UTF-8 record.
# No JSON aliases, whitespace variants or unsigned fields are accepted.
approval_record() {
    local issued=$1 expires=$2 reviewer=$3
    printf 'penny-sca-bootstrap-approval-v1\nissued=%s\nexpires=%s\nreviewer_id=%s\nscript_sha256=%s\nbundle_sha256=%s\nbundle_path=%s\nidentity=penny-sca\nbase=%s\nconfig=%s\nstate=%s\ndata=%s\nunits=%s\nnamespace=%s\nhost_if=%s\nguest_if=%s\nips=%s\negress_if=%s\nio_device=%s\nkvm=%s\nkvm_device=%s\ncpu_quota=50%%\nmemory_max=1G\ntasks_max=64\nio_read=8M\nio_write=8M\nslice_cpu_quota=100%%\nslice_memory_max=2G\nslice_tasks_max=128\nslice_io_read=16M\nslice_io_write=16M\nstdout=null\nstderr=null\ntmpfs_max=128M\ntmp_max=64M\nvar_tmp_max=64M\nshm_max=32M\nruntime_max=300\nfile_max=67108864\n' \
        "$issued" "$expires" "$reviewer" "$(sha256sum -- "$SELF" | cut -d' ' -f1)" "$DIGEST" "$BUNDLE" \
        "$BASE" "$CONFIG" "$STATE" "$DATA" "$UNITS" "$NS" "$HOST_IF" "$GUEST_IF" \
        "$IPS" "$EGRESS_IF" "$IO_DEVICE" "$KVM" "$( [[ $KVM == yes ]] && echo /dev/kvm || echo none )"
}
# This script never creates, rotates, removes or selects the trust anchor.
check_trust() {
    local f pin reviewer
    for f in "$CONFIG" "$TRUST"; do
        root_path "$f"
        [[ -d $f && ! -L $f && $(stat -c %u:%g:%a -- "$f") == 0:0:700 ]] || die "trust directory not root-only: $f"
    done
    for f in "$TRUST_KEY" "$TRUST_PIN" "$TRUST_ID"; do
        root_path "$f"
        [[ -f $f && ! -L $f && $(stat -c %u:%g:%a:%h -- "$f") == 0:0:600:1 ]] || die "trust file not root-only: $f"
    done
    [[ $(stat -c %s -- "$TRUST_KEY") -le 4096 && $(stat -c %s -- "$TRUST_PIN") == 65 && $(stat -c %s -- "$TRUST_ID") -le 65 ]] || die 'trust asset size'
    [[ $(openssl pkey -pubin -in "$TRUST_KEY" -text -noout 2>/dev/null | head -n 1) == ED25519\ Public-Key:* ]] || die 'Ed25519 trust key required'
    pin=$(openssl pkey -pubin -in "$TRUST_KEY" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
    cmp -s -- "$TRUST_PIN" <(printf '%s\n' "$pin") || die 'trust key fingerprint mismatch'
    reviewer=$(cat -- "$TRUST_ID")
    [[ $reviewer =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die 'invalid reviewer ID'
    cmp -s -- "$TRUST_ID" <(printf '%s\n' "$reviewer") || die 'noncanonical reviewer ID'
    REVIEWER_ID=$reviewer
}
approval_gate() {
    local f issued expires now i e
    check_trust
    for f in "$APPROVAL" "$SIGNATURE"; do
        [[ -n $f ]] || die 'signed approval and signature required'
        root_path "$f"
        [[ -f $f && ! -L $f && $(stat -c %u:%g:%a:%h -- "$f") == 0:0:600:1 ]] || die 'approval asset must be root-owned regular single-link 0600'
    done
    [[ $(stat -c %s "$APPROVAL") -le 4096 && $(stat -c %s "$SIGNATURE") == 64 ]] || die 'approval asset size'
    issued=$(sed -n '2s/^issued=//p' "$APPROVAL")
    expires=$(sed -n '3s/^expires=//p' "$APPROVAL")
    for f in "$issued" "$expires"; do
        [[ $f =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die 'noncanonical approval time'
        [[ $(date -u -d "$f" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) == "$f" ]] || die 'invalid approval time'
    done
    i=$(date -u -d "$issued" +%s); e=$(date -u -d "$expires" +%s); now=$(date -u +%s)
    (( i <= now && now < e && e - i <= 86400 )) || die 'approval outside issuance/expiry (max 24h)'
    cmp -s -- "$APPROVAL" <(approval_record "$issued" "$expires" "$REVIEWER_ID") || die 'approval fields/encoding mismatch'
    openssl pkeyutl -verify -pubin -inkey "$TRUST_KEY" -rawin -in "$APPROVAL" -sigfile "$SIGNATURE" >/dev/null 2>&1 || die 'invalid bootstrap approval signature'
}
lock_host() {
    root_path /run
    [[ ! -L /run/penny-sca-bootstrap.lock ]] || die 'lock substituted'
    if [[ -e /run/penny-sca-bootstrap.lock ]]; then
        [[ $(stat -c %u:%a /run/penny-sca-bootstrap.lock) == 0:600 ]] || die 'lock not root-owned 0600'
    fi
    exec 9>/run/penny-sca-bootstrap.lock
    chmod 0600 /run/penny-sca-bootstrap.lock
    flock -n 9 || die 'another bootstrap operation is running'
}
audit() {
    printf '%s mode=%s event=%s digest=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" "$1" "$DIGEST" >> "$AUDIT"
    chmod 0600 "$AUDIT"
    sync -f "$AUDIT"
}
# Fixed, non-interpolated units; only a validated sha256 and device path are substituted.
unit() {
    local kind=$1 exec unit_network device_lines=
    case $kind in
        offline) exec=p02-offline; unit_network='PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX' ;;
        osv) exec=p02-osv; unit_network='NetworkNamespacePath=/run/netns/penny-sca-osv
RestrictAddressFamilies=AF_UNIX AF_INET' ;;
        p07) exec=p07-supervisor; unit_network='PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
DevicePolicy=closed' ;;
        *) die 'bad unit' ;;
    esac
    if [[ $kind == p07 && $KVM == yes ]]; then device_lines='SupplementaryGroups=kvm
DeviceAllow=/dev/kvm rw'; fi
    cat <<EOF
[Unit]
Description=Penny controlled $kind worker (inactive until separately qualified)
ConditionPathExists=/etc/penny-sca/activation-authorized
[Service]
Type=exec
Slice=penny-sca.slice
StandardOutput=null
StandardError=null
User=penny-sca
Group=penny-sca
$device_lines
$unit_network
ExecStart=$BASE/releases/$DIGEST/bin/$exec
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
ProcSubset=pid
PrivateIPC=yes
UnsetEnvironment=HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY FTP_PROXY http_proxy https_proxy all_proxy no_proxy ftp_proxy PROXY proxy
InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/run/podman -/run/user -/var/lib/docker -/var/lib/containerd -/var/lib/containers -/etc/docker -/etc/containerd -/etc/containers
PrivateTmp=no
DevicePolicy=closed
PrivateDevices=$( [[ $kind == p07 && $KVM == yes ]] && echo no || echo yes )
TemporaryFileSystem=/tmp:rw,size=64M,mode=1777
TemporaryFileSystem=/var/tmp:rw,size=64M,mode=1777
TemporaryFileSystem=/dev/shm:rw,size=32M,mode=1777
TemporaryFileSystem=$DATA:rw,size=128M,mode=1777
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
LockPersonality=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
SystemCallArchitectures=native
UMask=0077
CPUAccounting=yes
CPUQuota=50%
MemoryAccounting=yes
MemoryMax=1G
TasksAccounting=yes
TasksMax=64
IOAccounting=yes
IOReadBandwidthMax=$IO_DEVICE 8M
IOWriteBandwidthMax=$IO_DEVICE 8M
RuntimeMaxSec=300
TimeoutStopSec=20
LimitFSIZE=67108864
[Install]
# Intentionally no WantedBy: do not enable; explicit qualified launch only.
EOF
}
slice_unit() {
    cat <<EOF
[Unit]
Description=Aggregate bounded Penny SCA worker slice
[Slice]
CPUAccounting=yes
CPUQuota=100%
MemoryAccounting=yes
MemoryMax=2G
TasksAccounting=yes
TasksMax=128
IOAccounting=yes
IOReadBandwidthMax=$IO_DEVICE 16M
IOWriteBandwidthMax=$IO_DEVICE 16M
EOF
}
unit_name() { echo "penny-sca-p02-$1@.service"; }
unit_path() {
    case $1 in offline|osv) echo "$UNITS/$(unit_name "$1")" ;; p07) echo "$UNITS/penny-sca-p07@.service" ;; esac
}
# Namespace and host tables are distinct; never flush another table or change sysctls.
ns_rules() {
    local set_ips=${IPS//,/\, }
    cat <<EOF
add table inet penny_sca_ns
add chain inet penny_sca_ns output { type filter hook output priority 0; policy drop; }
add chain inet penny_sca_ns input { type filter hook input priority 0; policy drop; }
add rule inet penny_sca_ns output oifname "$GUEST_IF" ip daddr { $set_ips } meta l4proto tcp tcp dport 443 accept
add rule inet penny_sca_ns input iifname "$GUEST_IF" ip saddr { $set_ips } ip daddr 10.231.94.2 meta l4proto tcp tcp sport 443 ct state established accept
EOF
}
host_rules() {
    local set_ips=${IPS//,/\, }
    cat <<EOF
add table inet penny_sca_host
add chain inet penny_sca_host input { type filter hook input priority -100; policy accept; }
add chain inet penny_sca_host forward { type filter hook forward priority -100; policy accept; }
add rule inet penny_sca_host input iifname "$HOST_IF" drop
add rule inet penny_sca_host forward iifname "$HOST_IF" oifname "$EGRESS_IF" ip saddr 10.231.94.2 ip daddr { $set_ips } meta l4proto tcp tcp dport 443 accept
add rule inet penny_sca_host forward iifname "$HOST_IF" drop
add rule inet penny_sca_host forward iifname "$EGRESS_IF" oifname "$HOST_IF" ip saddr { $set_ips } ip daddr 10.231.94.2 meta l4proto tcp tcp sport 443 ct state established accept
add rule inet penny_sca_host forward oifname "$HOST_IF" drop
add table ip penny_sca_nat
add chain ip penny_sca_nat postrouting { type nat hook postrouting priority 100; policy accept; }
add rule ip penny_sca_nat postrouting iifname "$HOST_IF" oifname "$EGRESS_IF" ip saddr 10.231.94.2 ip daddr { $set_ips } meta l4proto tcp tcp dport 443 masquerade
EOF
}
# Hash only dedicated nft tables; a changed table cannot be silently removed.
table_digest() {
    local scope=$1 family=$2 name=$3
    if [[ $scope == ns ]]; then ip netns exec "$NS" nft -j list table "$family" "$name" | sha256sum | cut -d' ' -f1
    else nft -j list table "$family" "$name" | sha256sum | cut -d' ' -f1; fi
}
manifest_write() {
    local tmp
    tmp=$(mktemp "$STATE/.manifest.XXXXXXXX")
    {
        printf 'version=2\ndigest=%s\nips=%s\negress_if=%s\nio_device=%s\nkvm=%s\nphase=%s\n' "$DIGEST" "$IPS" "$EGRESS_IF" "$IO_DEVICE" "$KVM" "${PHASE:-applying}"
        printf 'ns_hash=%s\nhost_hash=%s\nnat_hash=%s\n' "${NS_HASH:-pending}" "${HOST_HASH:-pending}" "${NAT_HASH:-pending}"
    } > "$tmp"
    chmod 0600 "$tmp"; sync -f "$tmp"; mv -T -- "$tmp" "$MANIFEST"; sync -f "$STATE"
}
manifest_load() {
    root_path "$MANIFEST"
    [[ -f $MANIFEST && ! -L $MANIFEST && $(stat -c %a "$MANIFEST") == 600 ]] || die 'missing/insecure manifest'
    local key value
    local -a keys=(version digest ips egress_if io_device kvm phase ns_hash host_hash nat_hash)
    local -a values=()
    mapfile -t values < "$MANIFEST"
    ((${#values[@]} == ${#keys[@]})) || die 'manifest shape changed'
    for i in "${!keys[@]}"; do
        key=${keys[$i]}; value=${values[$i]}
        [[ $value == "$key="* ]] || die 'manifest key changed'
        value=${value#*=}
        case $key in
            version) [[ $value == 2 ]] || die 'manifest version' ;;
            digest) DIGEST=$value ;;
            ips) IPS=$value ;;
            egress_if) EGRESS_IF=$value ;;
            io_device) IO_DEVICE=$value ;;
            kvm) KVM=$value ;;
            phase) PHASE=$value ;;
            ns_hash) NS_HASH=$value ;;
            host_hash) HOST_HASH=$value ;;
            nat_hash) NAT_HASH=$value ;;
        esac
    done
    validate_input no
    [[ $PHASE == applying || $PHASE == ready || $PHASE == quiescing || $PHASE == disconnecting || $PHASE == tables || $PHASE == cleanup ]] || die 'invalid phase'
    for value in "$NS_HASH" "$HOST_HASH" "$NAT_HASH"; do [[ $value == pending || $value =~ ^[a-f0-9]{64}$ ]] || die 'manifest hash invalid'; done
}
check_assets() {
    root_path "$SELF"
    [[ -f $SELF && ! -L $SELF ]] || die 'bootstrap script must be root-admitted'
    root_path "$BUNDLE"
    [[ -f $BUNDLE && ! -L $BUNDLE && $(stat -c %h "$BUNDLE") == 1 ]] || die 'release tar must be regular, single-link and root-admitted'
    (( $(stat -c %s "$BUNDLE") > 0 && $(stat -c %s "$BUNDLE") <= 629145600 )) || die 'tar size exceeds 600 MiB'
    [[ $(sha256sum -- "$BUNDLE" | cut -d' ' -f1) == "$DIGEST" ]] || die 'bundle digest mismatch'
}
check_unused_network_resources() {
    [[ -z $(ip route show 10.231.94.0/30) ]] || die 'reserved veth subnet collides'
    if ip link show dev "$HOST_IF" >/dev/null 2>&1; then die 'host veth name occupied'; fi
    if ip netns list | grep -q "^$NS "; then die 'namespace name occupied'; fi
    for table in 'inet penny_sca_host' 'ip penny_sca_nat'; do
        # shellcheck disable=SC2086 # fixed literal family/name pairs
        if nft list table $table >/dev/null 2>&1; then die 'dedicated nft table already exists'; fi
    done
    # The final absence probe returns nonzero by design. Do not leak it as this
    # function's status under `set -e`; successful absence checking is success.
    return 0
}
check_prereqs() {
    local tool
    for tool in python3 nft ip systemctl systemd-analyze openssl getent useradd groupadd usermod userdel flock sync pgrep; do
        command -v "$tool" >/dev/null || die "missing host tool: $tool"
    done
    [[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 ]] || die 'pre-existing IPv4 forwarding required (not changed by bootstrap)'
    check_controllers
    [[ -b $IO_DEVICE && ! -L $IO_DEVICE ]] || die 'block device required'
    check_unit_support
    ip link show dev "$EGRESS_IF" >/dev/null || die 'egress interface absent'
    check_unused_network_resources
}
check_unit_support() {
    local d kind line status=0 expected=3
    d=$(mktemp -d)
    for kind in offline osv p07; do unit "$kind" > "$d/penny-sca-$kind@.service"; done
    slice_unit > "$d/penny-sca.slice"
    SYSTEMD_UNIT_PATH="$d" systemd-analyze verify "$d"/*.service > "$d/diagnostics" 2>&1 || status=$?
    # Isolated unit path intentionally has no sysinit.target or release binaries.
    # Reject every other diagnostic, including unknown directives and parse errors.
    while IFS= read -r line; do
        if [[ $line =~ ^penny-sca-(offline|osv|p07)@i.service:\ Failed\ to\ create\ penny-sca-(offline|osv|p07)@i.service/start:\ Unit\ sysinit.target\ not\ found\.$ ]] ||
           [[ $line =~ ^penny-sca-(offline|osv|p07)@i.service:\ Command\ /opt/penny-sca/releases/[a-f0-9]{64}/bin/p0[27]-[a-z-]+\ is\ not\ executable:\ No\ such\ file\ or\ directory$ ]]; then
            continue
        fi
        rm -rf -- "$d"; die "systemd unit diagnostic: $line"
    done < "$d/diagnostics"
    for kind in p02-offline p02-osv p07-supervisor; do
        [[ -x $BASE/releases/$DIGEST/bin/$kind ]] || ((expected+=1))
    done
    [[ $status == 1 && $(wc -l < "$d/diagnostics") == "$expected" ]] || { rm -rf -- "$d"; die 'unexpected systemd verification result'; }
    rm -rf -- "$d"
}
check_controllers() {
    local c file root=${1:-/sys/fs/cgroup}
    for file in "$root/cgroup.controllers" "$root/cgroup.subtree_control"; do
        [[ -r $file ]] || die "cgroup v2 root controller file missing: $file"
        for c in cpu memory pids io; do
            [[ " $(cat "$file") " == *" $c "* ]] || die "cgroup root effective controller unavailable: $c ($file)"
        done
    done
}
# Each destructive step is re-entrant only after inspecting existing dedicated state.
# A missing resource may be accepted only after disconnection has begun; never
# remove the last host deny table while the veth/namespace still exists.
assert_table_or_absent() {
    local scope=$1 family=$2 name=$3 expected=$4 got
    if [[ $scope == ns ]]; then
        ip netns exec "$NS" nft list tables >/dev/null || die 'cannot inspect namespace nft policy'
        if ! ip netns exec "$NS" nft list table "$family" "$name" >/dev/null 2>&1; then return 1; fi
    else
        nft list tables >/dev/null || die 'cannot inspect host nft policy'
        if ! nft list table "$family" "$name" >/dev/null 2>&1; then return 1; fi
    fi
    got=$(table_digest "$scope" "$family" "$name")
    [[ $got == "$expected" ]] || die "dedicated table drift: $name"
}
disconnect_network() {
    local route
    if ip netns list | grep -q "^$NS "; then
        [[ -z $(ip netns pids "$NS") ]] || die 'namespace still has processes'
        route=$(ip -n "$NS" route show default)
        [[ -z $route || $route == "default via 10.231.94.1 dev $GUEST_IF" ]] || die 'unexpected namespace route'
        [[ -z $route ]] || ip -n "$NS" route del default via 10.231.94.1 dev "$GUEST_IF" || die 'route removal failed'
        assert_table_or_absent ns inet penny_sca_ns "$NS_HASH" || die 'namespace deny table missing'
    fi
    assert_table_or_absent host inet penny_sca_host "$HOST_HASH" || die 'host deny table missing'
    assert_table_or_absent host ip penny_sca_nat "$NAT_HASH" || die 'host nat table missing'
    if ip link show dev "$HOST_IF" >/dev/null 2>&1; then ip link del "$HOST_IF" || die 'veth removal failed'; fi
    if ip netns list | grep -q "^$NS "; then ip netns del "$NS" || die 'namespace removal failed'; fi
}
remove_tables() {
    ! ip link show dev "$HOST_IF" >/dev/null 2>&1 || die 'veth still present'
    ! ip netns list | grep -q "^$NS " || die 'namespace still present'
    assert_table_or_absent host inet penny_sca_host "$HOST_HASH" || :
    assert_table_or_absent host ip penny_sca_nat "$NAT_HASH" || :
    if nft list table inet penny_sca_host >/dev/null 2>&1; then nft delete table inet penny_sca_host || die 'host table removal failed'; fi
    if nft list table ip penny_sca_nat >/dev/null 2>&1; then nft delete table ip penny_sca_nat || die 'nat table removal failed'; fi
}
assert_quiescent() {
    local f pattern active
    for f in "$UNITS/penny-sca-p02-offline@.service" "$UNITS/penny-sca-p02-osv@.service" "$UNITS/penny-sca-p07@.service"; do
        pattern=${f##*/}; pattern=${pattern/@.service/@*.service}
        active=$(systemctl list-units --type=service --state=active --no-legend --plain "$pattern") || die 'could not inspect active units'
        [[ -z $active ]] || die 'unit instance restarted during rollback'
    done
    [[ -z $(pgrep -u penny-sca || :) ]] || die 'identity processes remain'
}
require_rollback_phase() {
    [[ $PHASE != applying && $NS_HASH != pending && $HOST_HASH != pending && $NAT_HASH != pending ]] || die 'incomplete apply; manual recovery required'
}
check_account() {
    local line groups
    line=$(getent passwd penny-sca) || die 'account missing'
    [[ $line == penny-sca:* ]] || die 'account changed'
    [[ ${line##*:} == /usr/sbin/nologin ]] || die 'login shell changed'
    [[ $(id -gn penny-sca) == penny-sca ]] || die 'primary group changed'
    groups=$(id -nG penny-sca)
    if [[ $KVM == yes ]]; then [[ $groups == 'penny-sca kvm' || $groups == 'kvm penny-sca' ]] || die 'unexpected groups'
    else [[ $groups == penny-sca ]] || die 'unexpected groups'; fi
    [[ $(getent passwd penny-sca | cut -d: -f6) == /nonexistent ]] || die 'account home changed'
}
# Exact deployed tree inventory. Includes directories and bytes; a substituted file,
# extra file, changed mode or symlink blocks verify and rollback.
inventory() {
    python3 - "$BASE/releases/$DIGEST" <<'PY'
import grp, hashlib, json, os, pathlib, stat, sys
base = pathlib.Path(sys.argv[1])
gid = grp.getgrnam('penny-sca').gr_gid
items = []
for root, dirs, files in os.walk(base, followlinks=False):
    for name in sorted(dirs + files):
        p = pathlib.Path(root) / name
        s = p.lstat()
        if s.st_uid != 0 or s.st_gid != gid or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
            raise ValueError('substituted release entry')
        rel = p.relative_to(base).as_posix()
        digest = hashlib.sha256(p.read_bytes()).hexdigest() if stat.S_ISREG(s.st_mode) else None
        items.append([rel, stat.S_IMODE(s.st_mode), digest])
        if len(items) > 5000: raise ValueError('release entry limit')
print(json.dumps(sorted(items), separators=(',', ':')))
PY
}
check_files() {
    local f kind expected
    for f in "$BASE" "$BASE/releases" "$BASE/releases/$DIGEST"; do
        root_path "$f"; [[ -d $f && $(stat -c %U:%G:%a "$f") == root:penny-sca:750 ]] || die "directory drift: $f"
    done
    root_path "$CONFIG"; [[ -d $CONFIG && $(stat -c %U:%G:%a "$CONFIG") == root:root:700 ]] || die 'config directory drift'
    for f in "$DATA" "$DATA/evidence" "$DATA/quarantine"; do
        root_path "$f"
        [[ -d $f && ! -L $f && $(stat -c %U:%G:%a "$f") == root:root:700 ]] || die "data directory drift: $f"
    done
    f=$UNITS/penny-sca.slice
    root_path "$f"; [[ -f $f && $(stat -c %U:%G:%a "$f") == root:root:644 ]] || die 'slice drift'
    cmp -s "$f" <(slice_unit) || die 'aggregate slice substituted'
    for kind in offline osv p07; do
        f=$(unit_path "$kind")
        root_path "$f"; [[ -f $f && $(stat -c %U:%G:%a "$f") == root:root:644 ]] || die "unit drift: $f"
        expected=$(unit "$kind" | sha256sum | cut -d' ' -f1)
        [[ $(sha256sum "$f" | cut -d' ' -f1) == "$expected" ]] || die "unit substituted: $f"
        [[ $(systemctl is-enabled "${f##*/}" 2>/dev/null || :) == disabled || $(systemctl is-enabled "${f##*/}" 2>/dev/null || :) == static ]] || die 'unit enabled'
        local pattern=${f##*/}
        pattern=${pattern/@.service/@*.service}
        active=$(systemctl list-units --type=service --state=active --no-legend --plain "$pattern") || die 'could not inspect active units'
        [[ -z $active || $MODE == rollback ]] || die 'unit instance active'
    done
    for kind in p02-offline p02-osv p07-supervisor; do
        f="$BASE/releases/$DIGEST/bin/$kind"
        root_path "$f"; [[ -f $f && -x $f ]] || die "missing admitted executable: $f"
    done
    check_trust
    [[ -d $EVIDENCE_DIR && ! -L $EVIDENCE_DIR && $(stat -c %u:%g:%a "$EVIDENCE_DIR") == 0:0:700 ]] || die 'evidence directory drift'
    [[ -f $CONFIG/release.sha256 && ! -L $CONFIG/release.sha256 && $(stat -c %U:%G:%a "$CONFIG/release.sha256") == root:root:644 && $(cat "$CONFIG/release.sha256") == "$DIGEST" ]] || die 'release digest marker changed'
    root_path "$CONFIG/bundle.tar"; root_path "$INVENTORY"
    [[ -f $CONFIG/bundle.tar && -f $INVENTORY && $(stat -c %U:%G:%a "$CONFIG/bundle.tar") == root:root:600 && $(stat -c %U:%G:%a "$INVENTORY") == root:root:600 ]] || die 'bundle/inventory missing'
    [[ $(sha256sum "$CONFIG/bundle.tar" | cut -d' ' -f1) == "$DIGEST" ]] || die 'installed bundle digest changed'
    [[ -f $AUDIT && ! -L $AUDIT && $(stat -c %u:%a "$AUDIT") == 0:600 ]] || die 'audit substituted'
    cmp -s "$INVENTORY" <(inventory) || die 'deployment files changed or added'
}
verify() {
    (( EUID == 0 )) || die 'verify requires root for nft and unit inspection'
    manifest_load
    [[ $PHASE == ready ]] || die "incomplete bootstrap phase: $PHASE"
    check_controllers; check_unit_support; check_account; check_files
    [[ $KVM == no || ( -c /dev/kvm && ! -L /dev/kvm && $(getent group kvm) ) ]] || die 'KVM device/group unavailable'
    [[ ! -e $CONFIG/activation-authorized && ! -L $CONFIG/activation-authorized ]] || die 'activation outside bootstrap scope'
    [[ $(find "$CONFIG" -mindepth 1 -maxdepth 1 | wc -l) == 4 && $(find "$TRUST" -mindepth 1 -maxdepth 1 | wc -l) == 3 && $(find "$BASE" -mindepth 1 -maxdepth 1 | wc -l) == 1 && $(find "$BASE/releases" -mindepth 1 -maxdepth 1 | wc -l) == 1 && $(find "$DATA" -mindepth 1 -maxdepth 1 | wc -l) == 2 && $(find "$STATE" -mindepth 1 -maxdepth 1 | wc -l) == 3 ]] || die 'unrecognized bootstrap files'
    [[ $NS_HASH != pending && $HOST_HASH != pending && $NAT_HASH != pending ]] || die 'incomplete apply; manual review required'
    [[ $(table_digest ns inet penny_sca_ns) == "$NS_HASH" && $(table_digest host inet penny_sca_host) == "$HOST_HASH" && $(table_digest host ip penny_sca_nat) == "$NAT_HASH" ]] || die 'dedicated nft rules changed'
    [[ $(ip -n "$NS" route show default) == "default via 10.231.94.1 dev $GUEST_IF" ]] || die 'namespace route changed'
    [[ $(ip -n "$NS" route show | wc -l) == 2 ]] || die 'namespace route added'
    [[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 && $(ip -o -4 addr show dev "$HOST_IF" | grep -c '10.231.94.1/30') == 1 && $(ip -o -4 addr show dev "$HOST_IF" | wc -l) == 1 && $(ip route show dev "$HOST_IF" | wc -l) == 1 ]] || die 'host route/veth drift'
    [[ -z $(ip -o -6 addr show dev "$HOST_IF") && -z $(ip -n "$NS" -o -6 addr show dev "$GUEST_IF") && -z $(ip -n "$NS" -6 route show) ]] || die 'unexpected IPv6 configuration'
    [[ $(cat "/sys/class/net/$HOST_IF/iflink") == $(ip netns exec "$NS" cat "/sys/class/net/$GUEST_IF/ifindex") ]] || die 'veth peer changed'
    [[ $(ip -n "$NS" -o -4 addr show dev "$GUEST_IF" | grep -c '10.231.94.2/30') == 1 && $(ip -n "$NS" -o -4 addr show dev "$GUEST_IF" | wc -l) == 1 ]] || die 'namespace address changed'
    for kind in offline osv p07; do
        local f prop
        f=$(unit_path "$kind")
        local instance=${f##*/}
        instance=${instance/@.service/@bootstrap-inspect.service}
        [[ $(systemctl show "$instance" -p FragmentPath --value) == "$f" && -z $(systemctl show "$instance" -p DropInPaths --value) ]] || die "unit fragment/drop-in drift: $kind"
        [[ $(systemctl show "$instance" -p ExecStart --value) == *"$BASE/releases/$DIGEST/bin/"* ]] || die "effective executable drift: $kind"
        for prop in User=penny-sca Group=penny-sca NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes ProtectProc=invisible ProcSubset=pid PrivateIPC=yes CPUQuotaPerSecUSec=500ms MemoryMax=1073741824 TasksMax=64 Slice=penny-sca.slice StandardOutput=null StandardError=null DevicePolicy=closed; do
            [[ $(systemctl show "$instance" -p "${prop%%=*}" --value) == "${prop#*=}" ]] || die "effective unit property drift: $kind $prop"
        done
        [[ $(systemctl show "$instance" -p RuntimeMaxUSec --value) == 5min ]] || die 'effective runtime bound changed'
        local tmpfs
        tmpfs=$(systemctl show "$instance" -p TemporaryFileSystem --value)
        [[ $tmpfs == *"$DATA:rw,size=128M,mode=1777"* && $tmpfs == *'/tmp:rw,size=64M,mode=1777'* && $tmpfs == *'/var/tmp:rw,size=64M,mode=1777'* && $tmpfs == *'/dev/shm:rw,size=32M,mode=1777'* ]] || die 'effective bounded work area missing'
        [[ $(systemctl show "$instance" -p UnsetEnvironment --value) == *HTTP_PROXY* && $(systemctl show "$instance" -p InaccessiblePaths --value) == *'/run/containerd'* ]] || die 'proxy/socket hardening missing'
        if [[ $kind == osv ]]; then
            [[ $(systemctl show "$instance" -p RestrictAddressFamilies --value) == *AF_INET* ]] || die 'OSV address family missing'
        else
            [[ $(systemctl show "$instance" -p RestrictAddressFamilies --value) != *AF_INET* ]] || die 'offline network family exposed'
        fi
        [[ $(systemctl show "$instance" -p IOReadBandwidthMax --value) == *"$IO_DEVICE"* && $(systemctl show "$instance" -p IOWriteBandwidthMax --value) == *"$IO_DEVICE"* ]] || die 'effective IO bound missing'
        if [[ $kind == osv ]]; then
            [[ $(systemctl show "$instance" -p NetworkNamespacePath --value) == "/run/netns/$NS" ]] || die 'OSV namespace binding missing'
        elif [[ $kind == p07 ]]; then
            [[ $(systemctl show "$instance" -p DevicePolicy --value) == closed ]] || die 'KVM device policy missing'
            if [[ $KVM == yes ]]; then
                [[ $(systemctl show "$instance" -p DeviceAllow --value) == *'/dev/kvm'* && $(systemctl show "$instance" -p PrivateDevices --value) == no ]] || die 'KVM allow missing'
            else
                [[ $(systemctl show "$instance" -p DeviceAllow --value) != *'/dev/kvm'* && $(systemctl show "$instance" -p PrivateDevices --value) == yes ]] || die 'KVM no exposed device'
            fi
        else
            [[ $(systemctl show "$instance" -p PrivateNetwork --value) == yes ]] || die 'offline private network missing'
        fi
    done
    [[ $(systemctl show penny-sca.slice -p FragmentPath --value) == "$UNITS/penny-sca.slice" && -z $(systemctl show penny-sca.slice -p DropInPaths --value) ]] || die 'slice fragment/drop-in drift'
    for prop in CPUQuotaPerSecUSec=1s MemoryMax=2147483648 TasksMax=128; do
        [[ $(systemctl show penny-sca.slice -p "${prop%%=*}" --value) == "${prop#*=}" ]] || die "effective slice bound changed: $prop"
    done
    [[ $(systemctl show penny-sca.slice -p IOReadBandwidthMax --value) == *"$IO_DEVICE"* && $(systemctl show penny-sca.slice -p IOWriteBandwidthMax --value) == *"$IO_DEVICE"* ]] || die 'aggregate IO bound missing'
    printf 'PASS: static installation and selected effective unit properties; live qualification NOT_RUN\n'
}
# A single descriptor-relative publisher for both outputs. Root has exactly one
# destination directory; nonroot may use only an owned 0700 scratch directory.
# Link publication is exclusive: even a racing symlink or regular file is refused.
publish_evidence() {
    python3 -I -c '
import os, re, secrets, stat, sys
path, fixed = sys.argv[1:]
root = os.geteuid() == 0
parent, name = os.path.split(path)
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name) or name in (".", ".."):
    raise ValueError("invalid evidence filename")
if root and parent != fixed:
    raise ValueError("root output must be in fixed evidence directory")
if not root and (not parent.startswith("/") or parent == fixed):
    raise ValueError("nonroot output requires a private scratch directory")
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
    for component in parent.split("/")[1:]:
        if not component or component in (".", ".."):
            raise ValueError("noncanonical output parent")
        child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        s = os.fstat(child)
        if root and (s.st_uid != 0 or s.st_mode & 0o022):
            raise ValueError("non-root or writable output ancestor")
        os.close(fd)
        fd = child
    s = os.fstat(fd)
    if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o700 or s.st_uid != os.geteuid():
        raise ValueError("output directory must be owned 0700")
    content = sys.stdin.buffer.read(8193)
    if not content or len(content) > 8192:
        raise ValueError("evidence size must be 1..8192 bytes")
    temp = ".penny-" + secrets.token_hex(16)
    out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(out, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.fsync(fd)
    finally:
        os.unlink(temp, dir_fd=fd)
        os.fsync(fd)
finally:
    os.close(fd)
' "$EVIDENCE" "$EVIDENCE_DIR" || die 'evidence publication rejected'
}
case $MODE in
    plan)
        validate_input
        printf 'PLAN only (no changes): admit %s at SHA-256 %s; root-owned release %s/releases/%s; service account penny-sca (kvm=%s); namespace %s -> %s TCP/443 [%s]; IO device %s; three disabled units; manifest %s. Requires later operator review.\n' "$BUNDLE" "$DIGEST" "$BASE" "$DIGEST" "$KVM" "$NS" "$EGRESS_IF" "$IPS" "$IO_DEVICE" "$MANIFEST"
        ;;
    apply)
        [[ -z $EVIDENCE ]] || die 'apply does not emit verification evidence'
        validate_input
        check_assets; approval_gate; lock_host
        if [[ -f $MANIFEST ]]; then
            requested="$DIGEST:$IPS:$EGRESS_IF:$IO_DEVICE:$KVM"
            verify
            [[ "$requested" == "$DIGEST:$IPS:$EGRESS_IF:$IO_DEVICE:$KVM" ]] || die 'existing installation differs from requested inputs'
            echo 'Already provisioned; no changes'; exit 0
        fi
        [[ ! -e $MANIFEST && ! -L $MANIFEST && ! -e $DATA && ! -L $DATA && ! -e $BASE && ! -L $BASE ]] || die 'existing resource without matching manifest; refusing overwrite'
        [[ $(find "$CONFIG" -mindepth 1 -maxdepth 1 | wc -l) == 1 && -d $TRUST ]] || die 'config must contain only pre-established trust directory'
        check_prereqs
        host_rules | nft -c -f - || die 'host nft rules failed preflight'
        ns_rules | nft -c -f - || die 'namespace nft rules failed syntax preflight'
        getent passwd penny-sca >/dev/null && die 'account already exists without manifest'
        getent group penny-sca >/dev/null && die 'group already exists without manifest'
        for kind in offline osv p07; do [[ ! -e $(unit_path "$kind") && ! -L $(unit_path "$kind") ]] || die 'unit already exists'; done
        [[ ! -e $UNITS/penny-sca.slice && ! -L $UNITS/penny-sca.slice ]] || die 'slice already exists'
        for f in "$BASE" "$CONFIG" "$DATA" "$STATE"; do root_path "$f"; done
        [[ $KVM == no || ( -c /dev/kvm && ! -L /dev/kvm && $(getent group kvm) ) ]] || die 'kvm unavailable'
        if [[ -d $STATE ]]; then
            root_path "$STATE"; [[ $(stat -c %a "$STATE") == 700 && $(find "$STATE" -mindepth 1 -maxdepth 1 ! -name audit.log | wc -l) == 0 ]] || die 'unowned state content'
            [[ ! -e $AUDIT || ( -f $AUDIT && ! -L $AUDIT && $(stat -c %a "$AUDIT") == 600 ) ]] || die 'audit substituted'
        else mkdir -m 0700 "$STATE"; fi
        audit 'begin'; manifest_write
        groupadd --system penny-sca
        useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid penny-sca penny-sca
        if [[ $KVM == yes ]]; then usermod -aG kvm penny-sca; fi
        mkdir -m 0750 "$BASE" "$BASE/releases"
        chgrp penny-sca "$BASE" "$BASE/releases"
        mkdir -m 0700 "$EVIDENCE_DIR"
        mkdir -m 0700 "$DATA" "$DATA/evidence" "$DATA/quarantine"
        # Host data placeholders remain root-only; each unit sees its own tmpfs.
        # Never extract with tar -x: validate all entries and write only ordinary files into
        # a new root-owned directory. No file from the caller-writable tree is executed.
        pending=$(mktemp -d "$BASE/releases/.pending.XXXXXXXX")
        python3 - "$BUNDLE" "$pending" <<'PY'
import grp, os, pathlib, sys, tarfile
src, dest = sys.argv[1:]
root = pathlib.Path(dest)
gid = grp.getgrnam('penny-sca').gr_gid if os.geteuid() == 0 else os.getegid()
owner = os.geteuid()
root.chmod(0o750)
os.chown(root, owner, gid)
seen = {}
total = 0
with tarfile.open(src, 'r:') as tar:
    members = []
    for entry in tar:
        members.append(entry)
        if len(members) > 5000: raise ValueError('too many archive members')
    for m in members:
        parts = m.name.rstrip('/').split('/')
        if not parts or any(x in ('', '.', '..') for x in parts) or m.name.startswith('/') or '\\' in m.name or '\x00' in m.name:
            raise ValueError('unsafe archive name')
        normalized = '/'.join(parts)
        if normalized in seen or m.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
            raise ValueError('duplicate or non-regular archive member')
        if any(seen.get('/'.join(parts[:i]), tarfile.DIRTYPE) != tarfile.DIRTYPE for i in range(1, len(parts))):
            raise ValueError('file/parent collision')
        if m.type != tarfile.DIRTYPE and any(previous.startswith(normalized + '/') for previous in seen):
            raise ValueError('parent/file collision')
        if m.sparse is not None or any(k.lower().startswith(('gnu.sparse', 'schily.realsize')) for k in m.pax_headers):
            raise ValueError('sparse archive member')
        seen[normalized] = m.type
        total += m.size
        if total > 536870912 or m.size > 67108864: raise ValueError('archive too large')
    # Validation above is complete before any archive content is installed.
    for m in members:
        target = root.joinpath(*m.name.rstrip('/').split('/'))
        for parent in reversed(target.parents):
            if parent == root or root in parent.parents:
                if not parent.exists():
                    parent.mkdir(mode=0o750)
                    parent.chmod(0o750)
                    os.chown(parent, owner, gid)
                if not parent.is_dir() or parent.is_symlink(): raise ValueError('path collision')
        if m.isdir():
            if not target.exists():
                target.mkdir(mode=0o750)
                target.chmod(0o750)
                os.chown(target, owner, gid)
            elif not target.is_dir() or target.is_symlink(): raise ValueError('path collision')
        else:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o750 if m.mode & 0o111 else 0o640)
            with os.fdopen(fd, 'wb') as out, tar.extractfile(m) as inp:
                while True:
                    chunk = inp.read(65536)
                    if not chunk: break
                    out.write(chunk)
            target.chmod(0o750 if m.mode & 0o111 else 0o640)
            os.chown(target, owner, gid)
PY
        for kind in p02-offline p02-osv p07-supervisor; do
            [[ -f $pending/bin/$kind && -x $pending/bin/$kind && ! -L $pending/bin/$kind ]] || die "release missing bin/$kind"
        done
        mv -T -- "$pending" "$BASE/releases/$DIGEST"
        tmp=$(mktemp "$CONFIG/.inventory.XXXXXXXX"); inventory > "$tmp"; chmod 0600 "$tmp"; mv -T "$tmp" "$INVENTORY"
        tmp=$(mktemp "$CONFIG/.bundle.XXXXXXXX"); cp -- "$BUNDLE" "$tmp"; chmod 0600 "$tmp"; mv -T "$tmp" "$CONFIG/bundle.tar"
        tmp=$(mktemp "$CONFIG/.digest.XXXXXXXX")
        printf '%s\n' "$DIGEST" > "$tmp"; chmod 0644 "$tmp"; mv -T "$tmp" "$CONFIG/release.sha256"
        tmp=$(mktemp "$UNITS/.penny-sca.XXXXXXXX")
        slice_unit > "$tmp"; chmod 0644 "$tmp"; mv -T -- "$tmp" "$UNITS/penny-sca.slice"
        for kind in offline osv p07; do
            tmp=$(mktemp "$UNITS/.penny-sca.XXXXXXXX")
            unit "$kind" > "$tmp"; chmod 0644 "$tmp"
            mv -T -- "$tmp" "$(unit_path "$kind")"
        done
        systemctl daemon-reload
        # Only create named resources when absent. No network access is attempted.
        ip netns add "$NS"
        ip link add "$HOST_IF" type veth peer name "$GUEST_IF"
        ip link set "$GUEST_IF" netns "$NS"
        # Establish both deny boundaries before enabling either link or route.
        ns_rules | ip netns exec "$NS" nft -f -
        host_rules | nft -f -
        ip addr add 10.231.94.1/30 dev "$HOST_IF"
        ip -n "$NS" addr add 10.231.94.2/30 dev "$GUEST_IF"
        ip -n "$NS" link set dev "$GUEST_IF" addrgenmode none
        ip link set dev "$HOST_IF" addrgenmode none
        ip link set "$HOST_IF" up
        ip -n "$NS" link set "$GUEST_IF" up
        ip -n "$NS" route add default via 10.231.94.1 dev "$GUEST_IF"
        NS_HASH=$(table_digest ns inet penny_sca_ns)
        HOST_HASH=$(table_digest host inet penny_sca_host)
        NAT_HASH=$(table_digest host ip penny_sca_nat)
        PHASE=ready; manifest_write; audit 'complete'
        verify
        ;;
    verify)
        [[ -z $BUNDLE && -z $IPS && -z $DIGEST && -z $EGRESS_IF && -z $IO_DEVICE && $KVM_SET == no && -z $APPROVAL && -z $SIGNATURE ]] || die 'verify accepts no apply arguments'
        [[ -n $EVIDENCE ]] || die 'explicit static evidence path required'
        (( EUID == 0 )) || die 'verify requires root'
        [[ ${EVIDENCE%/*} == "$EVIDENCE_DIR" ]] || die 'static evidence must be in fixed directory'
        verify
        python3 -I - "$DIGEST" "$IPS" "$EGRESS_IF" "$KVM" "$NS_HASH" "$HOST_HASH" "$NAT_HASH" \
            "$(sha256sum "$SELF" | cut -d' ' -f1)" "$IO_DEVICE" \
            "$(sha256sum "$(unit_path offline)" | cut -d' ' -f1)" \
            "$(sha256sum "$(unit_path osv)" | cut -d' ' -f1)" \
            "$(sha256sum "$(unit_path p07)" | cut -d' ' -f1)" \
            "$(sha256sum "$UNITS/penny-sca.slice" | cut -d' ' -f1)" <<'PY' | publish_evidence
import datetime, json, sys
digest, ips, egress, kvm, ns_hash, host_hash, nat_hash, script_hash, io_device, offline_hash, osv_hash, p07_hash, slice_hash = sys.argv[1:]
json.dump({'schema': 'penny-sca-static-v1', 'status': 'STATIC_PASS',
               'live_qualification': 'NOT_RUN', 'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
               'script_sha256': script_hash, 'bundle_sha256': digest, 'osv_ips': ips.split(','),
               'egress_if': egress, 'io_device': io_device, 'kvm': kvm, 'service_identity': 'penny-sca',
               'limits': {'cpu_quota': '50%', 'memory_max': '1G', 'tasks_max': 64, 'io_read': '8M',
                          'io_write': '8M', 'work_tmpfs': '128M', 'tmp': '64M', 'var_tmp': '64M',
                          'shm': '32M', 'runtime_seconds': 300, 'file_bytes': 67108864,
                          'slice_cpu_quota': '100%', 'slice_memory_max': '2G', 'slice_tasks_max': 128,
                          'slice_io_read': '16M', 'slice_io_write': '16M', 'stdout': 'null', 'stderr': 'null'},
               'unit_sha256': {'offline': offline_hash, 'osv': osv_hash, 'p07': p07_hash, 'slice': slice_hash},
               'nft_sha256': {'namespace': ns_hash, 'host': host_hash, 'nat': nat_hash}}, sys.stdout, sort_keys=True, separators=(',', ':'))
sys.stdout.write('\n')
PY
        ;;
    live-checklist)
        [[ -z $BUNDLE && -z $IPS && -z $DIGEST && -z $EGRESS_IF && -z $IO_DEVICE && $KVM_SET == no && -z $APPROVAL && -z $SIGNATURE ]] || die 'checklist accepts only evidence path'
        [[ -n $EVIDENCE ]] || die 'explicit checklist path required'
        if (( EUID == 0 )); then
            [[ ${EVIDENCE%/*} == "$EVIDENCE_DIR" ]] || die 'root checklist must be in fixed directory'
            manifest_load
            [[ $PHASE == ready ]] || die 'root checklist requires completed bootstrap'
        fi
        cat <<'EOF' | publish_evidence

LIVE CANARY — NOT_RUN. This is not a qualification receipt.
Independent authorization and isolated disposable host required before execution.
Observe: alternate-route drop; proxy/DNS/redirect and nonstandard Unix-socket denial;
effective live cpu/memory/pids/io limits and bounded work area; offline zero network;
KVM guest boot, Docker inside guest only, explicit no host-Docker fallback;
crash/reboot cleanup, evidence custody, external reviewer signature and identity.
Record measured observations, negative tests, policy hashes and cleanup separately.
EOF
        ;;
    rollback)
        [[ -z $BUNDLE && -z $IPS && -z $DIGEST && -z $EGRESS_IF && -z $IO_DEVICE && $KVM_SET == no && -z $EVIDENCE && -z $APPROVAL && -z $SIGNATURE ]] || die 'rollback accepts no apply arguments'
        lock_host; manifest_load
        require_rollback_phase
        if [[ $PHASE == ready ]]; then verify; PHASE=quiescing; manifest_write; audit rollback-begin; fi
        if [[ $PHASE == quiescing ]]; then
            check_account; check_files
            [[ -z $(ls -A "$DATA/evidence") && -z $(ls -A "$DATA/quarantine") && -z $(ls -A "$EVIDENCE_DIR") ]] || die 'evidence/quarantine/bootstrap receipts not empty'
            [[ $(table_digest host inet penny_sca_host) == "$HOST_HASH" && $(table_digest host ip penny_sca_nat) == "$NAT_HASH" ]] || die 'host policy drift'
            for kind in offline osv p07; do
                f=$(unit_path "$kind"); pattern=${f##*/}; pattern=${pattern/@.service/@*.service}
                while read -r instance _; do
                    [[ -z $instance ]] && continue
                    [[ $instance == penny-sca-p02-offline@*.service || $instance == penny-sca-p02-osv@*.service || $instance == penny-sca-p07@*.service ]] || die 'unexpected unit'
                    systemctl stop "$instance"
                done < <(systemctl list-units --all --type=service --no-legend --plain "$pattern")
                [[ -z $(systemctl list-units --type=service --state=active --no-legend --plain "$pattern") ]] || die 'unit still active'
            done
            assert_quiescent
            PHASE=disconnecting; manifest_write
        fi
        if [[ $PHASE == disconnecting ]]; then
            assert_quiescent
            disconnect_network
            PHASE=tables; manifest_write
        fi
        if [[ $PHASE == tables ]]; then
            assert_quiescent
            remove_tables
            PHASE=cleanup; manifest_write
        fi
        if [[ $PHASE == cleanup ]]; then
            assert_quiescent
            # Files are retained on interruption: no blind continuation after partial
            # file removal. Review and recover manually rather than deleting drift.
            check_account; check_files
            [[ -z $(ls -A "$DATA/evidence") && -z $(ls -A "$DATA/quarantine") && -z $(ls -A "$EVIDENCE_DIR") ]] || die 'evidence/quarantine/bootstrap receipts not empty'
            for kind in offline osv p07; do rm -- "$(unit_path "$kind")"; done
            rm -- "$UNITS/penny-sca.slice"
            systemctl daemon-reload
            rm -- "$CONFIG/release.sha256" "$CONFIG/bundle.tar" "$INVENTORY"
            python3 - "$BASE/releases/$DIGEST" <<'PY'
import os, pathlib, sys
p = pathlib.Path(sys.argv[1])
for root, dirs, files in os.walk(p, topdown=False, followlinks=False):
    for name in files + dirs:
        f = pathlib.Path(root) / name
        if f.is_symlink() or f.stat().st_uid != 0: raise ValueError('substituted release entry')
        if f.is_file(): f.unlink()
        else: f.rmdir()
p.rmdir()
PY
            rmdir "$BASE/releases" "$BASE"
            rmdir "$DATA/evidence" "$DATA/quarantine" "$DATA" "$EVIDENCE_DIR"
            userdel penny-sca; groupdel penny-sca
            audit rollback-complete
            rm -- "$MANIFEST"; printf 'Rolled back; retained audit at %s\n' "$AUDIT"
        fi
        ;;
esac
