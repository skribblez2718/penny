# Standalone KVM guest launcher

> **Optional legacy tooling, not ordinary SCA setup.** This launcher and its guest qualification are not prerequisites for current ordinary `sca` analysis or its production-readiness assessment. Ordinary application testing supports explicit Docker CONTAINER containment without a VM. All launcher preflights below still apply when it is used; historical guest results remain limited to their stated scope.

`run_guest.py` launches **one real QEMU/KVM guest**, not a container. It does not use Docker, sudo, SCA workflows, or adapters. The caller prepares a standalone, bootable **raw** root disk; this launcher never creates, deletes, retries, or snapshots that disk. Run only as an ordinary user with access to `/dev/kvm` and a working systemd user manager. Do not point it at a backing-chain image or a valuable original disk: QEMU opens the root disk read-write. The launcher does not inspect guest image content.

## Inputs and invocation

Provide absolute, canonical paths with **no `$`** (systemd 249 expands command arguments) for an owner-writable raw disk (at most 16 GiB), an owner-read-only NoCloud seed ISO (at most 512 MiB), and optionally an owner-read-only assets ISO (at most 512 MiB). Declare the raw disk's exact sector-aligned byte length and its SHA-256 at first launch; the disk's length is the fixed virtual size. A qcow header is rejected even if the digest matches. Hash the initial disk before launching; subsequent runs require a new expected hash because the guest may write to the disk. Each file must be a nonempty, singly linked regular file under an owner-only directory; no path component may be a symlink. The output directory must already exist, be owner-only, and be shared by all launches that must exclude each other. Provide lowercase SHA-256 digests for both ISOs (when supplied), QEMU, and bubblewrap. The tools must be at the fixed `/usr/bin/qemu-system-x86_64` and `/usr/bin/bwrap` paths, root-owned, nonwritable by non-root users, executable, non-setuid/non-setgid, canonical regular files under root-owned, nonwritable directories. The fixed `systemd-run` and `systemctl` binaries are checked for ownership, permissions, executable type, and canonical path; their hashes are not caller inputs. The launcher rejects root, absent or inaccessible root-owned `/dev/kvm` (character device major 10, minor 232), untrusted library aliases, changed inputs, unsafe permissions, and an empty allowed CPU affinity.

Set the variables yourself; no private path is built into Penny:

```sh
python3 scripts/sca-vm/run_guest.py \
  --disk "$RAW_DISK" --disk-sha256 "$DISK_SHA256" --disk-size-bytes "$DISK_SIZE_BYTES" \
  --seed-iso "$SEED_ISO" --seed-sha256 "$SEED_SHA256" \
  --qemu "$QEMU" --qemu-sha256 "$QEMU_SHA256" \
  --bwrap "$BWRAP" --bwrap-sha256 "$BWRAP_SHA256" \
  --output-dir "$PRIVATE_OUTPUT_DIR" --timeout 1200 --dry-run
```

Remove `--dry-run` to launch; add `--assets-iso "$ASSETS_ISO" --assets-sha256 "$ASSETS_SHA256"` together if needed. Dry run prints the exact command manifest without creating files, taking the singleton lock, or starting a service. It **does** check files, hashes, tools, and KVM access. Do not add QEMU or bubblewrap flags; there is no passthrough. `--timeout` must be 1–1200 seconds. Host wall watchdog allows a short additional interval for service startup/teardown; the systemd unit itself is capped by `RuntimeMaxSec`.

A real run takes a nonblocking `flock` on `.guest.lock` in the output directory, rechecks the input identities and initial disk/ISO hashes, then writes an exclusive, private `<unit>.command.json` before launch. This check is not an atomic bind: the same user can still substitute a pathname between verification and mount. The manifest includes private paths: keep the output directory private. The resulting `<unit>.serial.log` (raw, **untrusted** bytes from combined service stdout/stderr) is capped at 8 MiB, and `<unit>.result.json` reports return code, log truncation, preserved ISO hashes, and whether the unit was confirmed inactive. Only sanitized JSON/outcome text reaches the terminal; never render the log without treating it as hostile content. Result JSON has no private paths or guest output. Exit code 0 and `success: true` mean only that the launcher client/service completed with return code 0, without truncation/cancellation/timeout, with unchanged ISO hashes and confirmed inactive state. They **do not establish that the guest script succeeded**. `success_scope` is `launcher_process_and_supervisor_only`, and `guest_marker_verified` is always `false`; verify the expected guest marker independently before claiming guest-script success. A nonzero service/client return code yields `service_failed`, not a claim about the guest script. The writable disk is not expected to preserve its launch digest. If the unit cannot be confirmed inactive, the result is `containment_uncertain` regardless of other failures: the launcher does not claim termination or cleanup. The systemd unit's independently enforced `RuntimeMaxSec` is a fallback, not proof of a successful stop or a substitute for checking the unit. Failed runs keep the raw disk and all published evidence; no automatic retry. If a hard crash prevents a result, inspect the unit and disk manually before deciding whether to rerun.

The launcher asks `systemd-run --user --wait --pipe --collect` for an individual unique service with memory, swap, task, file-size, core, wall-clock, and control-group shutdown limits. It selects the highest two logical CPU IDs (or the sole ID) from the invoking process's `os.sched_getaffinity(0)`, saves them as `cpu_ids` in the command manifest, and sets `CPUAffinity=<space-separated IDs>` on the service. This limits QEMU and threads it creates to **at most two allowed CPUs**; the CPUs are not reserved or exclusive. Prefer the last IDs to avoid the usual first IRQ CPUs. `CPUQuota=200%` is requested but is **best effort, not proof of enforcement** when the user manager does not delegate CPU control (`cpu.max` may be absent). `LimitCPU=1800` is an RLIMIT_CPU CPU-time ceiling, not a substitute for CPU affinity or a CPU cgroup quota. Confirm effective CPU placement on the intended host; the launcher does not assert that `cpu.max` exists. Each virtual drive (including ISOs) requests a 16,777,216 bytes/s total and 512 IOPS total throttle: QEMU 6.2's `-drive` interface names these `bps=16777216,iops=512` (equivalent to the `throttling.bps-total` and `throttling.iops-total` policy). These are **per-drive**, not an aggregate host-wide limit. Bubblewrap clears QEMU's host-process environment (including inherited `PWD`) and explicitly requires a new user namespace and `--new-session`; the outer process supplies null stdin. The host-side QEMU process sees only the exact read-only QEMU binary, root-controlled read-only `/usr/lib/x86_64-linux-gnu` (including dlopen modules), `/usr/lib64` (loader), `/usr/share/qemu` and `/usr/share/seabios` firmware, validated `/lib*` aliases, a new `/proc`, and fixed guest file names: one RW raw disk and up to two RO ISO disks. These bounded library directories are broader than an individually enumerated `ldd` closure; there is no general `/usr`, general `/usr/share`, or writable `/tmp` mount. A deliberately created `/dev` contains **only** `/dev/kvm` and the standard host-backed pseudo-devices `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`. These ordinary pseudodevices are runtime support, **not host display devices**; `/dev/tty` and host physical devices other than KVM are not mounted. QEMU uses KVM, two vCPUs, 2048 MiB RAM, raw disk formats, and no NIC, graphical output, monitor, or implicit devices. `-cpu host,vmx=off,svm=off` disables nested virtualization in the guest. No `/sys`, host `/home`, `/run`, or Docker socket is mounted. On timeout, cancellation, overflow, or abnormal client behavior, the launcher stops **only its named unit**, waits, and checks inactivity. If that cannot be confirmed, the run is a failure; an operator must investigate. A systemd resource policy unavailable on a given host must fail closed rather than run without limits.

**Security boundary:** the invoking user owns the disk, output, and effective policies; if this user also has Docker root authority, this is **not** a same-user-adversary production boundary. Digest/size verification and prelaunch rechecks do not prevent same-UID pathname substitution or concurrent writes at the final Bubblewrap bind, and the writable disk changes by design. Same-UID substitution remains a production qualification blocker, not a complete guarantee. KVM/QEMU/kernel vulnerabilities also remain. The caller must prevent concurrent modification of inputs, keep the disk backup separately, and inspect actual user-manager cgroup enforcement, per-drive throttling, and guest confinement on the intended host before trusting production use. Tests exercise a mock transport; a non-VM `QEMU --version` sandbox probe tests the runtime mount set but neither proves a guest boot nor device/cgroup enforcement.

## Tests

```sh
.venv/bin/pytest -q scripts/sca-vm/tests
bun run py:lint
bun run py:format:check
bun run py:typecheck
```

Tests use only temporary files and fake `systemd-run`/`systemctl` executables; they never start a VM or invoke sudo. They cover generated `CPUAffinity` argv, selected IDs, empty affinity refusal, KVM device identity, result scope, and redacted diagnostics. A separate, bounded user-service `/usr/bin/sleep` probe can verify that the intended host applies `CPUAffinity` via `/proc/<pid>/status` (`Cpus_allowed_list`); it does not start QEMU or verify a guest or CPU quota. The mock transport and sleep probe cannot substitute for a controlled, explicitly authorized guest validation.

## Offline guest install and check (guest scripts never run on the host)

`guest/install-docker.sh` and `guest/check-docker.sh` execute **inside** a dedicated, caller-seeded Ubuntu x86-64 KVM guest as root. Both refuse to proceed unless `systemd-detect-virt --vm` is `kvm` and `/run/sca-vm/guest.seed` is a root-owned, non-symlink, single-link mode-0400 file containing exactly `penny-sca-vm-guest-v1` and a newline. The gate runs before logging, Docker, mount, or poweroff. This is a guard against accidental host execution, **not** authentication against a malicious guest root. Do not invoke these scripts on the host, even for a test. The guest image must already have systemd, cloud-init, Python 3, `findmnt`, `dpkg`, `apt-get`, `tar`, `mount`, and a serial console; package inputs must provide Docker, containerd, `ip`, `busybox`, **`curl`**, and their offline dependency closure. The Docker fixture is x86-64 libc/NSS-specific. No network service or host Docker is required by these scripts.

Prepare a **disposable** bootable raw Ubuntu disk from a separately verified, trusted base image using the caller's own private paths. For a trusted qcow2 base, run `umask 077; qemu-img convert -f qcow2 -O raw "$BASE_IMAGE" "$RAW_DISK"; chmod 0600 "$RAW_DISK"` into a fresh private path; this writes a standalone raw copy. Never point the launcher at the original. Check `DISK_SIZE_BYTES=$(stat -c %s "$RAW_DISK")`, confirm it is positive, divisible by 512 and at most 17179869184, and compute `DISK_SHA256=$(sha256sum "$RAW_DISK" | cut -d ' ' -f 1)` before _each_ launch (guest writes change the hash). Use owner-only directories and a singly linked regular disk. The launcher itself checks those conditions; it does not install an OS, create a disk, or validate that the base is trustworthy. Keep a separate offline backup and do not reuse a failed or partially provisioned disk without inspecting it. No host mount of the disk is needed for this recipe.

The caller collects signed/reviewed Ubuntu `.deb` packages **and all dependencies** into its private `$PKG_DIR`. No fetch occurs in the guest. Build an ISO with an exact manifest, then pin the whole ISO's SHA-256 in the launcher call; the embedded checksums alone do not authenticate a malicious ISO. All paths here are caller-supplied, not Penny defaults:

```sh
umask 077
# Set WORK, PKG_DIR, ASSETS_ISO, SEED_ISO, BASE_IMAGE, RAW_DISK,
# PRIVATE_OUTPUT_DIR to absolute paths in owner-only private directories.
# WORK is a fresh child of an existing owner-only private directory.
mkdir -m 0700 -- "$WORK"
python3 - "$PKG_DIR" "$WORK/packages.json" <<'PY'
import hashlib, json, pathlib, sys
folder = pathlib.Path(sys.argv[1])
files = sorted(folder.glob('*.deb'))
assert files and all(p.is_file() and not p.is_symlink() for p in files)
entries = [{'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
pathlib.Path(sys.argv[2]).write_text(json.dumps(entries, sort_keys=True) + '\n')
PY
xorriso -as mkisofs -r -J -V SCAASSETS -o "$ASSETS_ISO" -graft-points \
  "packages.json=$WORK/packages.json" "packages=$PKG_DIR"
chmod 0400 "$ASSETS_ISO"
```

At boot, `install-docker.sh` mounts only the ISO by `/dev/disk/by-label/SCAASSETS` read-only, checks a bounded `packages.json` array of `{file,sha256}` entries against every `.deb` (no extra fields or files, duplicate names, links, traversal or digest mismatch), installs via `dpkg -i`, then requires both `dpkg --audit` to be empty and an offline `apt-get check` to pass. Safe filename characters include a tilde, literal colon or percent (for example, Ubuntu revision `~22.04` or an epoch filename containing `%3a`); the verifier does not URL-decode names. No `apt-get install` or guest download occurs. It requires executable `/usr/bin/curl`, configures Docker's bounded local logs, and imports a local image with BusyBox shell/httpd, `getent`, guest NSS modules, and the distro curl plus the explicit library/interpreter closure reported by `/usr/bin/ldd /usr/bin/curl`. Only the fixed trusted guest curl is inspected; every reported file path must stay under `/lib` or `/usr/lib` (with the fixed `/lib64/ld-linux-x86-64.so.2` interpreter exception), including after resolving links, before `cp -L` places it at the same path in the image. An unknown or unresolved `ldd` line fails the build. The observed static Ubuntu BusyBox `wget` exited 139 even with libc/NSS files and a literal IP; its cause remains unresolved, not proved to be DNS. The curl-based fixture passed a live guest run and a fresh-copy check-only boot on 2026-09-24. A rejected package/closure stops the guest before any success marker; the caller must fix the ISO and use a fresh disposable disk rather than assume partial dpkg changes are rolled back.

Create a new NoCloud seed ISO for each run. Set `MODE=install` for the first boot or `MODE=check` for a later check-only boot of the installed disk. For `check`, the script **does not reinstall packages or rebuild the image**; it requires the existing `penny-sca-fixture:local` image. The following recipe embeds only the two caller-selected repository scripts, a dedicated sentinel, and a one-command `runcmd`. `GUEST_INSTALL` and `GUEST_CHECK` should point to `$PROJECT_ROOT/scripts/sca-vm/guest/install-docker.sh` and `$PROJECT_ROOT/scripts/sca-vm/guest/check-docker.sh` respectively. Use a fresh `instance-id` even when reusing the same disk; the check cleans cloud-init state after completion.

```sh
python3 - "$MODE" "$GUEST_INSTALL" "$GUEST_CHECK" "$WORK" <<'PY'
import base64, json, pathlib, sys, uuid
mode, install, check, work = sys.argv[1:]
if mode not in ('install', 'check'):
    raise SystemExit('MODE must be install or check')
work = pathlib.Path(work)
files = []
for source, target in ((install, '/usr/local/lib/sca-vm/install-docker.sh'),
                       (check, '/usr/local/lib/sca-vm/check-docker.sh')):
    files.append({'path': target, 'owner': 'root:root', 'permissions': '0700',
                  'encoding': 'b64', 'content': base64.b64encode(pathlib.Path(source).read_bytes()).decode('ascii')})
files.append({'path': '/run/sca-vm/guest.seed', 'owner': 'root:root',
              'permissions': '0400', 'content': 'penny-sca-vm-guest-v1\n'})
command = '/usr/local/lib/sca-vm/' + ('install-docker.sh' if mode == 'install' else 'check-docker.sh')
(work / 'user-data').write_text('#cloud-config\n' + json.dumps({'write_files': files, 'runcmd': [[command]]}) + '\n')
(work / 'meta-data').write_text('instance-id: iid-' + uuid.uuid4().hex + '\nlocal-hostname: sca-guest\n')
PY
cloud-localds "$SEED_ISO" "$WORK/user-data" "$WORK/meta-data"
chmod 0400 "$SEED_ISO"
sha256sum "$RAW_DISK" "$SEED_ISO" "$ASSETS_ISO"
```

Pass these exact hashes, actual byte size, owner-read-only ISOs, fixed tool paths and hashes to `run_guest.py` as shown above. Supply `--assets-iso` and `--assets-sha256` for install. The check-only boot needs only a _new_ seed ISO and the disk containing the installed fixture; omit assets ISO. If extra time is needed to inspect the guest process externally, supply `--observation-delay N` (`N` is decimal 0–60 seconds) as an argument to the selected guest script in `runcmd`; the default is zero. This is a bounded observation window, **not** a health wait. Check time spent waiting still fits the launcher's 1200-second maximum. The check script polls Docker readiness (up to 30 seconds) and HTTP readiness (up to ten five-second attempts) instead of sleeping an arbitrary fixed 45 seconds.

The check asserts an effective read-only container root, no-new-privileges, zero effective capabilities, denied mount, missing host socket/devices, no network/default route in the isolated container, and actual guest cgroup v2 values of 64 MiB memory, 32 PIDs and `50000 100000` CPU quota (0.5 CPU). Live testing passed these hardened-container and cgroup checks. The check uses `curl --fail --silent --show-error --max-time 5 --noproxy '*'` for HTTP on an internal two-container network **both by literal IP and by DNS**, then removes its containers and network; both HTTP assertions passed. It checks the guest has no physical NIC, default route, usable nested KVM, VMX/SVM CPU flags, `/dev/dri`, 9p/virtiofs mounts or leftover fixture containers. A distribution-created inert `/dev/kvm` node is not host-device passthrough: the check requires opening it to fail with ENOENT, ENODEV or ENXIO. The guest's own Docker socket is expected but is not passed into containers. The `setup.json` file under `/var/lib/sca-fixture` and serial line `PENNY_GUEST_SETUP_RESULT=<strict JSON>` are produced only after those checks. A failure trap reports exit code, actual failing Bash command and line, removes a stale result in the checker, requests poweroff, and cleans owned containers/network. Do not treat a launcher success result as proof that this guest marker exists or passed; parse and validate the marker independently, and reject any run with a failure line, missing completion line, truncated log or unconfirmed unit inactivity. The checker requests safe nonblocking poweroff on success too.

Live host-process inspection found **no effective CPU quota** (`cpu.max` absent), but every observed QEMU thread was restricted to two logical CPUs. It also confirmed separate namespaces, zero effective capabilities, no-new-privileges, seccomp, memory capped at 4 GiB, swap disabled and at most 128 processes/threads. Guest Docker's measured 0.5-CPU cgroup is a different boundary.

On 2026-09-24, the installed Docker 29.1.3 fixture passed a second boot from a disposable copy without package media. Separate timeout and cancellation canaries confirmed teardown; the read-only template's SHA-256 was unchanged after each run. No guest processes or matching services remained. An independent review accepted the bounded fixture evidence. These results do **not** establish production SCA readiness or zero host impact: SCA broker routing/activation, workload-image staging, same-user pathname substitution and operator Docker-group authority remain outside this launcher qualification, and KVM/QEMU/kernel vulnerabilities remain possible. The detailed command manifests, live observations and receipts belong in the caller's private evidence directory, not this public repository.

Static tests (`python3 -m unittest discover -s scripts/sca-vm/tests -p 'test_guest_scripts.py'`) syntax-check the two shell files, exercise the extracted manifest verifier with temporary packages (including a percent-encoded epoch filename), and check the curl `ldd` line parser and symlink confinement without invoking `ldd`. They never run a guest script, VM, host Docker or sudo.
