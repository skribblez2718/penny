# Controlled-host bootstrap — reviewer handoff, not activation

> **Legacy deployment scope only.** These P02/P03/P07 activation and VM qualification requirements do not apply to current ordinary `sca` analysis or its production-readiness assessment. Ordinary application testing supports explicit Docker CONTAINER containment without a VM. The safeguards below remain required for this separate legacy deployment; this notice records no successful VM qualification.

**Do not run apply or rollback while reviewing this package.** Plan only describes the proposed deployment. Apply installs three **disabled, condition-gated** P02 offline, P02 OSV and P07 templates; it never starts a worker or runs a guest. Static verification cannot qualify any of them. The operator and an **independent external reviewer** must assess the admitted tar, host and policy before root execution. Rootful Docker membership is root-equivalent: a same-host key or reviewer under that control is not independent. Remove and verify Docker access and sessions, or keep approval custody outside that host.

## Preconditions and scope

Use a controlled systemd/cgroup-v2 Linux host. Supply a root-owned, single-link regular release tar and an independently reviewed root-owned script at paths with root-owned, non-writable, symlink-free ancestors. The tar SHA-256 covers tar bytes; source provenance and content review remain separate. The archive extractor rejects unsafe member types, traversal, colliding/duplicate names, sparse metadata, more than 5,000 members, expanded total above 512 MiB, or files above 64 MiB. Admission does not execute the tar during extraction. The tar must contain executable `bin/p02-offline`, `bin/p02-osv` and `bin/p07-supervisor`.

Choose a dedicated egress interface, no more than 16 independently confirmed public OSV IPv4 addresses and a real backing block device. The fixed namespace `penny-sca-osv` uses `pscah0`/`pscan0` and `10.231.94.0/30`. IPv4 forwarding must already be enabled. The script does not change sysctls or unrelated nft tables; other host firewall rules may still deny flows. Host forward allows bind _both_ `pscah0` ingress and the configured egress interface; replies bind the reverse pair and admitted source IP/port. A route through another interface reaches the dedicated drop. This does not prove packet behavior on the real host.

Units unset uppercase/lowercase conventional proxy variables, mask conventional Docker/containerd/Podman sockets and daemon directories, restrict address families, protect `/proc` and home, disable privilege escalation and expose root-owned release code only. `--kvm no` sets `PrivateDevices=yes`, `DevicePolicy=closed` and grants no `/dev/kvm` device rule; `yes` conditionally allows `/dev/kvm` and kvm group membership. **No generic systemd template can prove that arbitrary nonstandard AF_UNIX Docker-compatible endpoints are absent.** A separately authorized live canary must search for and test these endpoints, including injected environment and inherited file descriptors. Application binaries must enforce exact OSV endpoint, TLS hostname/SNI, method, no proxy/DNS/redirect behavior and response limits independently.

The preflight and verify refuse missing effective root cgroup v2 `cpu`, `memory`, `pids`, or `io` controllers (both root `cgroup.controllers` and `cgroup.subtree_control`) and unsupported unit directives. Each unit specifies 50% CPU, 1 GiB memory, 64 tasks, 8 MiB/s read/write **on the selected device**, 300 seconds and 64 MiB per-file; all instances are children of `penny-sca.slice`, with aggregate 100% CPU, 2 GiB memory, 128 tasks and 16 MiB/s read/write on that device. These are ceilings, not additive reservations. `/var/lib/penny-sca` is a **private ephemeral 128 MiB tmpfs** in each unit's mount namespace; `/tmp` and `/var/tmp` each have a private 64 MiB tmpfs, and `/dev/shm` a 32 MiB tmpfs. They are writable inside that service, disappear on stop and are charged against the unit and slice memory cgroups. Host placeholders for `/var/lib/penny-sca`, `evidence` and `quarantine` remain root:root 0700: the `penny-sca` account cannot write persistent evidence directly. `ProtectSystem=strict` denies other ordinary host-file writes; `DevicePolicy=closed` limits device access (KVM is conditional). Worker stdout and stderr are explicitly `null`, not journald or evidence. Each unit also has an unmet `ConditionPathExists=/etc/penny-sca/activation-authorized`; this bootstrap never creates that marker and static verify refuses it, so an ordinary start cannot execute the worker from this installation. A separate reviewed activation design must supersede this fail-closed state. This bootstrap **does not ingest worker results at all**: there is no generic safe result schema, handoff, or bounded persistent worker output path. A separately authorized, size-limited and validated result-ingestion design is required before any worker launch; do not redirect output to the journal or host evidence as a workaround. The device limit does not cover other devices or systemd manager logs; the host must establish which backing devices are used and enforce limits there before activation. Live inspection must identify any additional writable surfaces. Static properties are not proof of runtime cgroup enforcement.

## Approval and commands

Apply requires the exact `--confirm` token, a pre-established pinned Ed25519 trust anchor under `/etc/penny-sca/trust/`, a root-owned canonical UTF-8 approval file and its root-owned 64-byte raw signature. **Apply accepts no key option.** The fixed files `reviewer.pem` (PEM public key), `reviewer.sha256` (lowercase SHA-256 of its DER public encoding plus LF), and `reviewer.id` (canonical reviewer ID plus LF) must be root:root 0600, single-link regular files; both `/etc/penny-sca` and its `trust` child must be root:root 0700 with root-owned non-writable symlink-free ancestors. Missing/mismatched files refuse apply. The bootstrap never creates, modifies, rotates or removes this anchor. Custody of the private key must remain outside the controlled host. Approval gates bootstrap only, not P03 attestation, qualification or activation. Approval expires within 24 hours of issue and must be currently valid. Reissue on any script, tar, interface/IP, service path/identity, KVM or limit change.

**Separate trust-anchor ceremony (outside this script).** An independent reviewer establishes identity and public-key fingerprint through a channel independent of the host and checkout, retains the signing private key off-host, and records the expected 64-hex DER SHA-256 and reviewer ID out of band. An authorized host administrator, after verifying those values against that independent record, creates `/etc/penny-sca` and `/etc/penny-sca/trust` root:root 0700 and atomically admits the three root:root 0600 files. The fingerprint file must contain the independently approved value, not merely an unchecked hash of whatever PEM arrived. Protect backups and restrict host root/Docker-equivalent access before and after admission. To rotate or revoke: stop dependent operations, quarantine old approvals, separately review and atomically replace/restore the three files and independent record under the same ceremony; if interrupted, leave apply blocked. Script rollback deliberately **does not** roll back or delete the trust anchor. Local root (including root-equivalent Docker access) can always bypass a local-only policy; this is not a cryptographic guarantee against a compromised host.

The reviewer signs the **exact bytes**, including final LF, of this fixed-order record (no extra fields, whitespace or alternate encodings). `script_sha256` is the hash of the staged script; `bundle_sha256` the hash of tar bytes. `issued` and `expires` are UTC `YYYY-MM-DDTHH:MM:SSZ`. Values for the fixed paths and constants are shown literally; substitute only the indicated values:

```text
penny-sca-bootstrap-approval-v1
issued=<UTC_ISSUED>
expires=<UTC_EXPIRES>
reviewer_id=<PINNED_REVIEWER_ID>
script_sha256=<STAGED_SCRIPT_SHA256>
bundle_sha256=<TAR_SHA256>
bundle_path=<ROOT_ADMITTED_TAR_ABSOLUTE_PATH>
identity=penny-sca
base=/opt/penny-sca
config=/etc/penny-sca
state=/var/lib/penny-sca-bootstrap
data=/var/lib/penny-sca
units=/etc/systemd/system
namespace=penny-sca-osv
host_if=pscah0
guest_if=pscan0
ips=<EXACT_COMMA_SEPARATED_IP_LIST>
egress_if=<EXACT_INTERFACE>
io_device=<EXACT_BLOCK_DEVICE>
kvm=<yes_OR_no>
kvm_device=<slash_dev_slash_kvm_IF_yes_ELSE_none>
cpu_quota=50%
memory_max=1G
tasks_max=64
io_read=8M
io_write=8M
slice_cpu_quota=100%
slice_memory_max=2G
slice_tasks_max=128
slice_io_read=16M
slice_io_write=16M
stdout=null
stderr=null
tmpfs_max=128M
tmp_max=64M
var_tmp_max=64M
shm_max=32M
runtime_max=300
file_max=67108864
```

The independent reviewer can sign the approved file with `openssl pkeyutl -sign -inkey <PRIVATE_KEY> -rawin -in <APPROVAL_FILE> -out <SIGNATURE_FILE>`. Distribute the approval and signature through a reviewed root-owned channel. The bootstrap checks the exact canonical bytes, reviewer ID and pinned DER fingerprint before `openssl pkeyutl -verify -pubin -inkey /etc/penny-sca/trust/reviewer.pem -rawin -in <APPROVAL_FILE> -sigfile <SIGNATURE_FILE>`. Signed inputs must be regular, single-link, root:root 0600 under non-writable symlink-free root-owned ancestors. Root compromise still bypasses local checks.

Stage the reviewed script away from writable home and checkout paths; compare its independently recorded SHA-256. Replace all placeholders before using the commands. **Commands are a handoff, not an instruction to run them during review.**

```sh
BOOTSTRAP='<ROOT_ADMITTED_BOOTSTRAP_ABSOLUTE_PATH>'
RELEASE='<ROOT_ADMITTED_RELEASE_TAR_ABSOLUTE_PATH>'
SHA='<EXACT_RELEASE_TAR_SHA256_LOWERCASE_HEX>'
WAN='<EGRESS_INTERFACE>'
DEST='<PUBLIC_OSV_IPV4[,PUBLIC_OSV_IPV4...]>'
DEVICE='/dev/<BLOCK_DEVICE>'
KVM='no'
APPROVAL='<ROOT_ADMITTED_APPROVAL_ABSOLUTE_PATH>'
SIGNATURE='<ROOT_ADMITTED_RAW_SIGNATURE_ABSOLUTE_PATH>'
# Explicit fixed interpreter; do not execute via env bash, sh, or a PATH-selected bash.
/bin/bash -p -- "$BOOTSTRAP" --mode plan --bundle "$RELEASE" --sha256 "$SHA" --egress-if "$WAN" --osv-ip "$DEST" --io-device "$DEVICE" --kvm "$KVM"
# Only after independent approval and controlled-host review:
sudo -H /bin/bash -p -- "$BOOTSTRAP" --mode apply --bundle "$RELEASE" --sha256 "$SHA" --egress-if "$WAN" --osv-ip "$DEST" --io-device "$DEVICE" --kvm "$KVM" --approval "$APPROVAL" --signature "$SIGNATURE" --confirm APPLY-penny-sca
sudo -H /bin/bash -p -- "$BOOTSTRAP" --mode verify --evidence '/var/lib/penny-sca-bootstrap/evidence/static-evidence.json'
sudo -H /bin/bash -p -- "$BOOTSTRAP" --mode live-checklist --evidence '/var/lib/penny-sca-bootstrap/evidence/live-checklist.txt'
# Nonroot checklist is separate scratch behavior, not a root receipt:
/bin/bash -p -- "$BOOTSTRAP" --mode live-checklist --evidence '<ABSOLUTE_PRIVATE_0700_SCRATCH_DIR>/live-checklist.txt'
# Only after a separate rollback decision and retention of all root receipts:
sudo -H /bin/bash -p -- "$BOOTSTRAP" --mode rollback --confirm ROLLBACK-penny-sca
```

Apply creates a fixed root:root 0700 `/var/lib/penny-sca-bootstrap/evidence` directory. Root verify and root checklist accept only fresh basenames directly in that directory; the root checklist also requires a completed bootstrap manifest. They open each parent component with `O_DIRECTORY|O_NOFOLLOW`, check ownership and modes, then publish a 1–8192-byte 0600 file via exclusive `O_CREAT|O_EXCL|O_NOFOLLOW` and no-clobber hard-link publication through the held directory descriptor. Symlink, substituted parent and destination-race attempts fail closed. A nonroot checklist can use a separate private owned 0700 scratch directory; it cannot publish a root receipt. Preserve or remove receipts under an independently reviewed retention decision before rollback, which refuses nonempty evidence directories. Verify writes a new 0600 canonical, sorted-key JSON **static** receipt (`STATIC_PASS`, `live_qualification: NOT_RUN`), with script/bundle/unit hashes, interface, IPs, KVM choice, device, configured limits and nft table hashes; it refuses an existing output path. `live-checklist` writes only **NOT_RUN**, does not run tests and is not a qualification receipt. An independent, separately generated live KVM/guest/no-host-Docker-fallback receipt with measured observations and cleanup must be reviewed **before any later activation**; this package does not fabricate or accept one as proof. Do not convert static evidence into a qualification grant.

## Failure and recovery

The root-only manifest records atomic phases: `applying`, `ready`, `quiescing`, `disconnecting`, `tables`, `cleanup`. Rollback stops discovered service instances and checks the identity has no remaining processes, removes the namespace default route, veth and namespace **while host deny policy remains**, and only then removes the dedicated host nft tables. Re-entry checks existing resources and hashes and resumes network teardown; it never silently treats a changed table as its own. If apply is interrupted, it stays `applying` with pending hashes: **do not retry apply or automatically rollback**. If file cleanup is interrupted, `cleanup` re-entry refuses missing or changed files; preserve the audit/manifest and request separately reviewed manual recovery. No unknown resources, evidence or quarantined files should be deleted merely to make rollback succeed. A preexisting active worker prevents static verify; rollback quiesces it first.

Netns, veth and nft policy are runtime state and are **not persisted across reboot**. Disabled units fail closed after reboot until a reviewed re-apply/re-establishment procedure confirms ownership, routes, rules and approvals; this script does not automatically re-establish or activate anything. Normal rollback removes the manifest but retains the root-only audit; interrupted rollback retains both until reviewed recovery. Compromised root, resource exhaustion and host policy interactions are outside this static proof.

## Required live qualification (separate authorization)

Before activation, the external reviewer must inspect live unit and cgroup state, no host Docker fallback, guest KVM boot with Docker **only inside the guest**, denial of alternate-route traffic, metadata, DNS, IPv6 and arbitrary ports, proxy/redirect/TLS behavior, nonstandard Unix sockets, source provenance, failure/restart cleanup and bounded output. Measure the real worker's CPU/memory/pids/IO devices and tmpfs bounds, compare negative tests and record evidence custody. P02 offline network silence and P03 identity/attestation require their own independent proofs. Until these run and pass, P02/P03/P07 qualification is **NOT_RUN/BLOCKED**.
