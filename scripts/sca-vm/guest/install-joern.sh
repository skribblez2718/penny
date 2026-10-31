#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 || $# -ne 3 ]]; then
  echo 'usage: install-joern.sh ASSET_MOUNT JOERN_SHA256 JRE_SHA256' >&2
  exit 2
fi

asset_mount=$1
expected_joern_sha256=$2
expected_jre_sha256=$3
archive="$asset_mount/joern-cli-linux-x86_64.zip"
jre_archive="$asset_mount/OpenJDK21U-jre_x64_linux_hotspot.tar.gz"
worker="$asset_mount/worker.py"
protocol="$asset_mount/output_protocol.py"
install_parent=/opt/penny-sca
install_root="$install_parent/joern-cli"
jre_root="$install_parent/jre"
lib_root=/usr/local/lib/penny-sca

[[ $expected_joern_sha256 =~ ^[a-f0-9]{64}$ ]]
[[ $expected_jre_sha256 =~ ^[a-f0-9]{64}$ ]]
[[ -d $asset_mount && -f $archive && -f $jre_archive && -f $worker && -f $protocol ]]
[[ $(sha256sum "$archive" | awk '{print $1}') == "$expected_joern_sha256" ]]
[[ $(sha256sum "$jre_archive" | awk '{print $1}') == "$expected_jre_sha256" ]]
[[ $(stat -c '%s' "$archive") == 1858298613 ]]
[[ $(stat -c '%s' "$jre_archive") == 52059408 ]]
[[ ! -e $install_parent ]]

mkdir -p "$install_parent" "$lib_root"
chmod 0755 "$install_parent" "$lib_root"

python3 - "$archive" "$install_parent" <<'PY'
import os
import shutil
import stat
import sys
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

archive = Path(sys.argv[1])
destination = Path(sys.argv[2])
maximum_entries = 2000
maximum_expanded = 3 * 1024 * 1024 * 1024
seen: set[str] = set()
expanded = 0

try:
    source = ZipFile(archive)
except BadZipFile as exc:
    raise SystemExit("invalid Joern archive") from exc

with source:
    infos = source.infolist()
    if not 1 <= len(infos) <= maximum_entries:
        raise SystemExit("Joern archive entry count outside limit")
    for info in infos:
        name = info.filename
        item = PurePosixPath(name)
        mode = (info.external_attr >> 16) & 0xFFFF
        kind = stat.S_IFMT(mode)
        if (
            name in seen
            or item.is_absolute()
            or "\\" in name
            or "\0" in name
            or any(part in ("", ".", "..") for part in item.parts)
            or item.parts[0] != "joern-cli"
            or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
        ):
            raise SystemExit("unsafe Joern archive entry")
        seen.add(name)
        expanded += info.file_size
        if expanded > maximum_expanded:
            raise SystemExit("Joern archive expansion exceeds limit")
    for info in infos:
        target = destination.joinpath(*PurePosixPath(info.filename).parts)
        if info.is_dir():
            target.mkdir(mode=0o755, parents=True, exist_ok=True)
            continue
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            written = 0
            with source.open(info, "r") as input_stream, os.fdopen(descriptor, "wb", closefd=False) as output:
                while chunk := input_stream.read(1024 * 1024):
                    output.write(chunk)
                    written += len(chunk)
                    if written > info.file_size:
                        raise SystemExit("Joern archive entry expanded beyond declaration")
                output.flush()
                os.fsync(output.fileno())
            if written != info.file_size:
                raise SystemExit("Joern archive entry size mismatch")
            permissions = (info.external_attr >> 16) & 0o777
            os.fchmod(descriptor, 0o755 if permissions & 0o111 else 0o644)
        finally:
            os.close(descriptor)
PY

python3 - "$jre_archive" "$install_parent" <<'PY'
import os
import posixpath
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive = Path(sys.argv[1])
destination = Path(sys.argv[2])
root_name = "jdk-21.0.12.1+1-jre"
with tarfile.open(archive, "r:gz") as source:
    members = source.getmembers()
    if not 1 <= len(members) <= 1000 or sum(item.size for item in members) > 512 * 1024 * 1024:
        raise SystemExit("JRE archive exceeds bounds")
    names: set[str] = set()
    for member in members:
        item = PurePosixPath(member.name)
        if (
            member.name in names
            or item.is_absolute()
            or any(part in ("", ".", "..") for part in item.parts)
            or item.parts[0] != root_name
            or not (member.isdir() or member.isfile() or member.issym())
        ):
            raise SystemExit("unsafe JRE archive entry")
        names.add(member.name)
        if member.issym():
            normalized = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
            if member.linkname.startswith("/") or not normalized.startswith(f"{root_name}/"):
                raise SystemExit("unsafe JRE symlink")
    for member in members:
        target = destination.joinpath(*PurePosixPath(member.name).parts)
        if member.isdir():
            target.mkdir(mode=0o755, parents=True, exist_ok=True)
        elif member.isfile():
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                stream = source.extractfile(member)
                if stream is None:
                    raise SystemExit("missing JRE file content")
                with stream, os.fdopen(descriptor, "wb", closefd=False) as output:
                    written = 0
                    while chunk := stream.read(1024 * 1024):
                        output.write(chunk)
                        written += len(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if written != member.size:
                    raise SystemExit("JRE file size mismatch")
                os.fchmod(descriptor, 0o755 if member.mode & 0o111 else 0o644)
            finally:
                os.close(descriptor)
    for member in members:
        if member.issym():
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            os.symlink(member.linkname, target)
PY
mv "$install_parent/jdk-21.0.12.1+1-jre" "$jre_root"

install -o root -g root -m 0755 "$worker" "$lib_root/worker.py"
install -o root -g root -m 0644 "$protocol" "$lib_root/output_protocol.py"
python3 -m py_compile "$lib_root/worker.py" "$lib_root/output_protocol.py"
find "$install_parent" "$lib_root" -xdev -type d -exec chmod 0755 {} +
find "$install_parent" "$lib_root" -xdev -type f -perm /022 -exec chmod go-w {} +
chown -R root:root "$install_parent" "$lib_root"

python3 - "$install_parent" <<'PY'
import re
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
expected = "4.0.627"
for component, launcher_required in (
    ("joern-cli", False),
    ("php2cpg", True),
    ("jssrc2cpg", True),
):
    pattern = re.compile(
        rf"^io\.joern\.{re.escape(component)}-([0-9]+(?:\.[0-9]+){{1,5}})(-launcher)?\.jar$"
    )
    names = []
    for candidate in root.rglob(f"io.joern.{component}-*.jar"):
        details = candidate.lstat()
        if stat.S_ISREG(details.st_mode) and not candidate.is_symlink():
            names.append(candidate.name)
    names.sort()
    parsed = [pattern.fullmatch(name) for name in names]
    if any(match is None for match in parsed):
        raise SystemExit("invalid Joern package listing")
    main = [match for match in parsed if match is not None and match.group(2) is None]
    launchers = [match for match in parsed if match is not None and match.group(2) is not None]
    if (
        len(main) != 1
        or len(launchers) != (1 if launcher_required else 0)
        or len(names) != (2 if launcher_required else 1)
        or main[0].group(1) != expected
        or (launcher_required and launchers[0].group(1) != expected)
    ):
        raise SystemExit("invalid Joern package listing")
PY

[[ $(realpath -e "$install_root/joern") == "$install_root/joern" ]]
launcher_help=$(JAVA_HOME="$jre_root" HOME=/var/tmp LANG=C.UTF-8 PATH="$jre_root/bin:/usr/bin:/bin" timeout 120 "$install_root/joern" --help 2>&1)
[[ $(printf %s "$launcher_help" | wc -c) -le 65536 ]]
[[ $(head -n 1 <<<"$launcher_help") == 'Usage: joern [options] [<cpg.bin>]' ]]
! grep -F 'Unknown option' <<<"$launcher_help" >/dev/null

cat > /usr/local/bin/penny-sca-worker <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export PYTHONPATH=/usr/local/lib/penny-sca
export JAVA_HOME=/opt/penny-sca/jre
export PATH=/opt/penny-sca/jre/bin:/usr/bin:/bin
exec /usr/bin/python3 /usr/local/lib/penny-sca/worker.py
SH
chmod 0755 /usr/local/bin/penny-sca-worker
chown root:root /usr/local/bin/penny-sca-worker

# The selected image must not retain per-build cloud-init state or logs.
cloud-init clean --logs --machine-id || true
rm -rf /var/lib/cloud/instances/* /var/tmp/* /tmp/*
sync
fstrim -av || true
echo 'PENNY_SCA_JOERN_INSTALL_OK'
