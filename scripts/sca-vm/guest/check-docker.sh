#!/bin/bash
# Guest-only verification. Without --build-fixture, reuse the installed image.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# This must remain before argument effects, logging, Docker calls or poweroff.
require_guest() {
  [[ $EUID -eq 0 ]] || return 1
  [[ $(systemd-detect-virt --vm 2>/dev/null) == kvm ]] || return 1
  local seed=/run/sca-vm/guest.seed
  [[ -f $seed && ! -L $seed ]] || return 1
  [[ $(stat -c '%u:%g:%a:%h' -- "$seed") == 0:0:400:1 ]] || return 1
  cmp -s -- "$seed" <(printf 'penny-sca-vm-guest-v1\n') || return 1
}
if ! require_guest; then
  printf 'Refused: dedicated seeded KVM guest required\n' >&2
  exit 1
fi

web_owned=false
network_owned=false
stage=
cleanup() {
  if [[ $web_owned == true ]]; then docker rm -f sca-fixture-web >/dev/null 2>&1 || true; fi
  if [[ $network_owned == true ]]; then docker network rm sca-fixture-net >/dev/null 2>&1 || true; fi
  if [[ -n $stage ]]; then rm -rf -- "$stage" || true; fi
}
on_error() {
  local rc=$1 line=$2 command=$3
  trap - ERR
  rm -f -- /var/lib/sca-fixture/setup.json || true
  printf 'PENNY_GUEST_CHECK_FAILED rc=%s line=%s command=%q\n' "$rc" "$line" "$command" >&2
  cleanup
  sync
  systemctl poweroff --no-block || true
  exit "$rc"
}
trap cleanup EXIT
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
exec > >(tee -a /var/log/sca-guest-check.log /dev/ttyS0) 2>&1
printf 'PENNY_GUEST_CHECK_STARTED\n'
mkdir -p /var/lib/sca-fixture
# Never leave an old success marker in place when a subsequent check fails.
rm -f -- /var/lib/sca-fixture/setup.json
invalid_args() { printf 'Usage: %s [--build-fixture] [--observation-delay 0..60]\n' "$0" >&2; return 2; }
build_fixture=false
observation_delay=0
while (($#)); do
  case $1 in
    --build-fixture) [[ $build_fixture == false ]] || invalid_args; build_fixture=true; shift ;;
    --observation-delay)
      [[ $# -ge 2 && $2 =~ ^(0|[1-9][0-9]?)$ ]] || invalid_args
      (( 10#$2 <= 60 )) || invalid_args
      observation_delay=$2; shift 2 ;;
    *) invalid_args ;;
  esac
done
sleep "$observation_delay" # optional, bounded 0..60s; for external process observation only

# Docker may add docker0; the guest has no physical NIC and no default route.
python3 - <<'PY'
import errno
import os
import pathlib
import subprocess

# Some distributions create an inert static /dev/kvm node via udev. A node is
# not device passthrough. Reject exposed virtualization features or a usable KVM.
flags = pathlib.Path('/proc/cpuinfo').read_text().split()
if 'vmx' in flags or 'svm' in flags:
    raise RuntimeError('nested virtualization feature exposed')
try:
    fd = os.open('/dev/kvm', os.O_RDWR | os.O_NONBLOCK)
except OSError as exc:
    if exc.errno not in (errno.ENOENT, errno.ENODEV, errno.ENXIO):
        raise
else:
    os.close(fd)
    raise RuntimeError('usable nested KVM device exposed')
links = {p.name for p in pathlib.Path('/sys/class/net').iterdir()}
if not links or not all(n == 'lo' or n == 'docker0' or n.startswith(('br-', 'veth')) for n in links):
    raise RuntimeError('unexpected guest interface')
if subprocess.check_output(['ip', 'route', 'show', 'default']).strip():
    raise RuntimeError('guest default route')
for name in ('/dev/dri', '/host'):
    if pathlib.Path(name).exists():
        raise RuntimeError('unexpected host device or share')
# Docker's socket is expected in the guest, but never mounted into test containers.
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
    if ' - 9p ' in line or ' - virtiofs ' in line:
        raise RuntimeError('host share filesystem')
PY
systemctl start docker
ready=false
for ((i=0; i<30; i++)); do
  if docker info >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]]
# Fail closed if the fixture would collide with a previous or unrelated run.
[[ -z $(docker ps -aq) ]]
if docker network inspect sca-fixture-net >/dev/null 2>&1; then
  printf 'Fixture network already exists\n' >&2
  false
fi

if [[ $build_fixture == true ]]; then
  # No host libraries: all copied objects come from the guest's offline packages.
  stage=$(mktemp -d /var/lib/sca-fixture/rootfs.XXXXXXXX)
  root=$stage
  mkdir -p "$root/bin" "$root/etc" "$root/lib/x86_64-linux-gnu" "$root/lib64" "$root/usr/bin"
  cp /bin/busybox "$root/bin/busybox"
  for name in sh httpd; do ln -s busybox "$root/bin/$name"; done
  # getent still needs guest NSS modules for the independent DNS assertion.
  for name in libc.so.6 libresolv.so.2 libnss_dns.so.2 libnss_files.so.2; do
    cp -L "/lib/x86_64-linux-gnu/$name" "$root/lib/x86_64-linux-gnu/$name"
  done
  cp -L /lib64/ld-linux-x86-64.so.2 "$root/lib64/ld-linux-x86-64.so.2"
  cp /usr/bin/getent "$root/usr/bin/getent"
  cp -L /usr/bin/curl "$root/usr/bin/curl"
  # ldd is invoked only on the fixed, trusted distro curl, never on an input binary.
  # Reject every unknown line or path before copying anything from its output.
  python3 - "$root" <<'PY'
import pathlib
import re
import subprocess
import sys


def linked_files(output: str) -> list[str]:
    if len(output) > 65536 or not 1 <= len(output.splitlines()) <= 128:
        raise ValueError('invalid curl ldd output size')
    files = []
    interpreter = False
    for line in output.splitlines():
        if re.fullmatch(r'\s*linux-vdso\.so\.1 \(0x[0-9a-fA-F]+\)', line):
            continue  # kernel-provided, not a file
        library = re.fullmatch(r'\s*[A-Za-z0-9][A-Za-z0-9+._-]* => (/\S+) \(0x[0-9a-fA-F]+\)', line)
        loader = re.fullmatch(r'\s*(/\S+) \(0x[0-9a-fA-F]+\)', line)
        if library:
            raw = library.group(1)
        elif loader:
            raw = loader.group(1)
            if pathlib.PurePosixPath(raw).name != 'ld-linux-x86-64.so.2' or interpreter:
                raise ValueError('unexpected curl interpreter')
            interpreter = True
        else:
            raise ValueError('unresolved or unexpected curl ldd line')
        path = pathlib.PurePosixPath(raw)
        if str(path) != raw or '..' in path.parts or not path.is_absolute():
            raise ValueError('noncanonical curl library path')
        allowed = any(parent in path.parents for parent in
                      (pathlib.PurePosixPath('/lib'), pathlib.PurePosixPath('/usr/lib')))
        if not allowed and not (loader and raw == '/lib64/ld-linux-x86-64.so.2'):
            raise ValueError('curl library outside library roots')
        files.append(raw)
    if not interpreter or len(files) < 2 or len(files) != len(set(files)):
        raise ValueError('incomplete or duplicate curl ldd closure')
    return files


def validate_sources(files: list[str]) -> None:
    # Resolve symlinks before copying: lexical confinement alone does not prevent
    # a guest library alias from pointing outside the two permitted trees.
    for name in files:
        source = pathlib.Path(name)
        resolved = source.resolve(strict=True)
        loader = source.name == 'ld-linux-x86-64.so.2'
        if not resolved.is_file() or not (
            any(parent in resolved.parents for parent in
                (pathlib.Path('/lib'), pathlib.Path('/usr/lib')))
            or (loader and name == '/lib64/ld-linux-x86-64.so.2'
                and resolved == pathlib.Path('/usr/lib64/ld-linux-x86-64.so.2'))
        ):
            raise ValueError('curl library link leaves library roots')


result = subprocess.run(
    ['/usr/bin/ldd', '/usr/bin/curl'], capture_output=True, text=True,
    timeout=10, check=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
)
if result.stderr:
    raise ValueError('curl ldd emitted diagnostics')
files = linked_files(result.stdout)
validate_sources(files)
root = pathlib.Path(sys.argv[1])
for name in files:
    source = pathlib.Path(name)
    target = root / source.relative_to('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['/bin/cp', '-L', '--', name, str(target)], check=True)
PY
  printf 'hosts: files dns\npasswd: files\ngroup: files\n' > "$root/etc/nsswitch.conf"
  printf 'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/:/bin/sh\n' > "$root/etc/passwd"
  printf 'root:x:0:\nnogroup:x:65534:\n' > "$root/etc/group"
  tar --numeric-owner --owner=0 --group=0 -C "$root" -cf - . | docker import - penny-sca-fixture:local
  rm -rf -- "$stage"
  stage=
fi
docker image inspect penny-sca-fixture:local >/dev/null
opts=(--read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 64m --cpus 0.5)
image=penny-sca-fixture:local
# This container has no network, host mounts or host devices. Check real cgroup
# values inside it rather than treating Docker CLI options as evidence.
docker run --rm --network none "${opts[@]}" --tmpfs /tmp:rw,noexec,nosuid,size=8m "$image" /bin/sh -eu -c '
  test ! -e /var/run/docker.sock
  test ! -e /dev/kvm
  test ! -e /dev/dri
  test ! -e /host
  ! /bin/busybox touch /forbidden-write
  /bin/busybox grep -q "^NoNewPrivs:.*1" /proc/self/status
  /bin/busybox grep -q "^CapEff:.*0000000000000000" /proc/self/status
  test "$(/bin/busybox cat /sys/fs/cgroup/memory.max)" = 67108864
  test "$(/bin/busybox cat /sys/fs/cgroup/pids.max)" = 32
  test "$(/bin/busybox cat /sys/fs/cgroup/cpu.max)" = "50000 100000"
  ! /bin/busybox mount -t tmpfs none /tmp
  ! /bin/busybox grep -q "^[^[:space:]]*[[:space:]]*00000000[[:space:]]" /proc/net/route
  /bin/busybox echo container-confinement-ok
'
# One isolated, internal Docker bridge; neither container gets an external NIC.
docker network create --internal sca-fixture-net
network_owned=true
[[ $(docker network inspect --format '{{.Internal}}' sca-fixture-net) == true ]]
web_owned=true
docker run -d --name sca-fixture-web --network sca-fixture-net "${opts[@]}" --tmpfs /www:rw,noexec,nosuid,size=8m "$image" /bin/sh -eu -c 'echo sca-http-ok > /www/index.html; exec /bin/httpd -f -p 8080 -h /www'
web_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' sca-fixture-web)
python3 - "$web_ip" <<'PY'
import ipaddress
import sys
if not isinstance(ipaddress.ip_address(sys.argv[1]), ipaddress.IPv4Address):
    raise ValueError('expected internal IPv4 address')
PY
# Bounded readiness poll: no unexplained fixed wait and no unbounded retry.
ready=false
for ((i=0; i<10; i++)); do
  if reply=$(docker run --rm --network sca-fixture-net "${opts[@]}" "$image" /usr/bin/curl --fail --silent --show-error --max-time 5 --noproxy '*' "http://$web_ip:8080/") && [[ $reply == sca-http-ok ]]; then
    ready=true; break
  fi
  sleep 1
done
[[ $ready == true ]]
printf 'PENNY_CONTAINER_LITERAL_IP_HTTP=passed\n'
docker run --rm --network sca-fixture-net "${opts[@]}" "$image" /usr/bin/getent hosts sca-fixture-web
reply=$(docker run --rm --network sca-fixture-net "${opts[@]}" "$image" /usr/bin/curl --fail --silent --show-error --max-time 5 --noproxy '*' http://sca-fixture-web:8080/)
[[ $reply == sca-http-ok ]]
printf 'PENNY_CONTAINER_DNS_HTTP=passed\n'
cleanup
web_owned=false
network_owned=false
[[ -z $(docker ps -aq) ]]
if docker network inspect sca-fixture-net >/dev/null 2>&1; then false; fi

# Check actual daemon security features and the final guest state. Publish only
# strict JSON; the launcher's success flag does not verify this marker.
result=$(python3 - <<'PY'
import json
import pathlib
import subprocess

run = lambda *args: subprocess.check_output(args, text=True).strip()
links = json.loads(run('ip', '-j', 'link', 'show'))
if not links or not all(x['ifname'] == 'lo' or x['ifname'] == 'docker0' or x['ifname'].startswith(('br-', 'veth')) for x in links):
    raise RuntimeError('unexpected interface')
if run('ip', 'route', 'show', 'default') or run('docker', 'ps', '-aq'):
    raise RuntimeError('default route or leftover container')
if pathlib.Path('/dev/dri').exists():
    raise RuntimeError('display device visible')
if any(flag in pathlib.Path('/proc/cpuinfo').read_text().split() for flag in ('vmx', 'svm')):
    raise RuntimeError('nested virtualization feature exposed')
info = json.loads(run('docker', 'info', '--format', '{{json .}}'))
if 'name=seccomp,profile=builtin' not in info['SecurityOptions']:
    raise RuntimeError('builtin seccomp missing')
result = {
    'schema': 'penny.sca-guest-setup.v1', 'status': 'passed',
    'hypervisor': run('systemd-detect-virt', '--vm'),
    'kernel': run('uname', '-r'),
    'docker': run('docker', 'version', '--format', '{{.Server.Version}}'),
    'guest_interfaces': [x['ifname'] for x in links], 'default_route': False,
    'hardened_container': 'passed', 'guest_container_resource_limits': 'passed',
    'internal_two_container_http': 'passed', 'internal_dns': 'passed',
    'host_shares': False, 'nested_virtualization': False,
    'docker_security_options': info['SecurityOptions'],
    'fixture_image': run('docker', 'image', 'inspect', '--format', '{{.Id}}', 'penny-sca-fixture:local'),
}
payload = json.dumps(result, sort_keys=True, separators=(',', ':')) + '\n'
path = pathlib.Path('/var/lib/sca-fixture/setup.json')
temp = path.with_suffix('.json.tmp')
temp.write_text(payload, encoding='utf-8')
temp.chmod(0o600)
temp.replace(path)
print(payload, end='')
PY
)
# Prepare this disk for a fresh caller-supplied NoCloud instance-id on next boot.
cloud-init clean --logs
sync
systemctl poweroff --no-block
printf 'PENNY_GUEST_SETUP_RESULT=%s\nPENNY_GUEST_CHECK_COMPLETE\n' "$result"
sync
