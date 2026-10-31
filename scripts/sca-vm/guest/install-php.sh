#!/bin/bash
set -euo pipefail
umask 077

if [[ ${EUID} -ne 0 || $# -ne 2 ]]; then
  echo 'usage: install-php.sh ASSET_MOUNT MANIFEST_SHA256' >&2
  exit 2
fi

asset_mount=$1
expected_manifest_sha256=$2
manifest="$asset_mount/packages.sha256"
packages="$asset_mount/packages"
[[ $expected_manifest_sha256 =~ ^[a-f0-9]{64}$ ]]
[[ -d $packages && -f $manifest ]]
[[ $(sha256sum "$manifest" | awk '{print $1}') == "$expected_manifest_sha256" ]]

python3 - "$manifest" "$packages" <<'PY'
import hashlib
import re
import sys
from pathlib import Path

manifest = Path(sys.argv[1])
packages = Path(sys.argv[2])
allowed = {
    "mailcap_3.70+nmu1ubuntu1.22.04.1_all.deb",
    "mime-support_3.66_all.deb",
    "php-common_2%3a92ubuntu1_all.deb",
    "php8.1-cli_8.1.2-1ubuntu2.26_amd64.deb",
    "php8.1-common_8.1.2-1ubuntu2.26_amd64.deb",
    "php8.1-opcache_8.1.2-1ubuntu2.26_amd64.deb",
    "php8.1-readline_8.1.2-1ubuntu2.26_amd64.deb",
}
expected = {}
for line in manifest.read_text(encoding="ascii").splitlines():
    match = re.fullmatch(r"([a-f0-9]{64})  \./([^/]+)", line)
    if match is None or match.group(2) in expected:
        raise SystemExit("invalid PHP package manifest")
    expected[match.group(2)] = match.group(1)
if set(expected) != allowed:
    raise SystemExit("unexpected PHP package set")
actual = {}
for path in packages.iterdir():
    if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
        raise SystemExit("invalid PHP package file")
    actual[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit("PHP package digest mismatch")
PY

export DEBIAN_FRONTEND=noninteractive
/usr/bin/dpkg -i "$packages"/*.deb
/usr/bin/php --version | grep -F 'PHP 8.1.2' >/dev/null
mkdir -p /var/tmp/penny-php-check
printf '<?php function f($x) { return $x; }\n' > /var/tmp/penny-php-check/check.php
JAVA_HOME=/opt/penny-sca/jre \
PATH=/opt/penny-sca/jre/bin:/usr/bin:/bin \
HOME=/var/tmp \
timeout 300 /opt/penny-sca/joern-cli/joern-parse \
  /var/tmp/penny-php-check --language php \
  --output /var/tmp/penny-php-check.cpg.bin >/var/tmp/penny-php-check.log 2>&1
[[ -s /var/tmp/penny-php-check.cpg.bin ]]
rm -rf /var/tmp/penny-php-check /var/tmp/penny-php-check.cpg.bin /var/tmp/penny-php-check.log
sync

echo PENNY_SCA_PHP_INSTALL_OK
