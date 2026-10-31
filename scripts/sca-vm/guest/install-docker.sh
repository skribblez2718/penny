#!/bin/bash
# Run only in the dedicated, caller-seeded offline x86-64 KVM guest.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive

# No logging, mounting, package installation or poweroff before this gate.
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

on_error() {
  local rc=$1 line=$2 command=$3
  trap - ERR
  rm -f -- /var/lib/sca-fixture/setup.json || true
  printf 'PENNY_GUEST_INSTALL_FAILED rc=%s line=%s command=%q\n' "$rc" "$line" "$command" >&2
  sync
  systemctl poweroff --no-block || true
  exit "$rc"
}
trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
exec > >(tee -a /var/log/sca-guest-install.log /dev/ttyS0) 2>&1
printf 'PENNY_GUEST_INSTALL_STARTED\n'
mkdir -p /var/lib/sca-fixture
rm -f -- /var/lib/sca-fixture/setup.json
# Reject mistakes before mounting or installing; only a bounded observation delay
# is forwarded to the independent checker.
invalid_args() { printf 'Usage: %s [--observation-delay 0..60]\n' "$0" >&2; return 2; }
if (($#)); then
  [[ $# -eq 2 && $1 == --observation-delay && $2 =~ ^(0|[1-9][0-9]?)$ ]] || invalid_args
  (( 10#$2 <= 60 )) || invalid_args
fi

# The caller supplies a read-only ISO labelled SCAASSETS. Its own SHA256 must be
# pinned by the caller; checksums inside that ISO detect corruption, not forgery.
assets=/mnt/sca-assets
mkdir -p -- "$assets"
mount -o ro -- /dev/disk/by-label/SCAASSETS "$assets"
[[ ,$(findmnt -n -o OPTIONS --target "$assets"), == *,ro,* ]] # exact mount flag

# Manifest is a JSON array of {"file":"...deb","sha256":"lowercase hex"}.
# Reject absent/extra files, links, duplicates, unsafe names and changed bytes
# before dpkg gets any package. Python exits nonzero on all validation failures.
python3 - "$assets" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
manifest = root / 'packages.json'
packages = root / 'packages'
if not manifest.is_file() or manifest.is_symlink() or manifest.stat().st_size > 131072:
    raise ValueError('missing or oversized manifest')
entries = json.loads(manifest.read_text(encoding='utf-8'))
if not isinstance(entries, list) or not 1 <= len(entries) <= 256:
    raise ValueError('invalid package count')
if not packages.is_dir() or packages.is_symlink():
    raise ValueError('missing package directory')
names = set()
for entry in entries:
    if not isinstance(entry, dict) or set(entry) != {'file', 'sha256'}:
        raise ValueError('invalid manifest entry')
    name, expected = entry['file'], entry['sha256']
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9+._%:~-]{0,199}\.deb', name):
        raise ValueError('unsafe package name')
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError('invalid package digest')
    if name in names:
        raise ValueError('duplicate package')
    names.add(name)
    path = packages / name
    if not path.is_file() or path.is_symlink() or not 0 < path.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError('missing or unsafe package')
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(chunk)
    if sha.hexdigest() != expected:
        raise ValueError('package checksum mismatch')
if {p.name for p in packages.iterdir()} != names:
    raise ValueError('unmanifested package file')
PY
# Glob is safe after exact directory equality above; the ISO is mounted read-only.
dpkg --force-confold -i "$assets"/packages/*.deb
[[ -z $(dpkg --audit) ]]
# apt-get check resolves the installed dependency closure without fetching anything.
apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=- check
for executable in docker containerd ip getent busybox curl; do command -v "$executable" >/dev/null; done
[[ -x /usr/bin/curl ]]

mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{"log-driver":"local","log-opts":{"max-size":"2m","max-file":"2"},"live-restore":false,"ip6tables":false,"default-address-pools":[{"base":"172.30.0.0/16","size":24}]}
JSON
systemctl enable containerd docker
systemctl restart docker
# No fixture import here: the independent check creates a fresh curl/NSS image.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec "$script_dir/check-docker.sh" --build-fixture "$@"
