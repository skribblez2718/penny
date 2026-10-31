#!/usr/bin/env python3
"""Exercise the bootstrap's embedded extractor without root or host mutation."""

import io
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile

script = pathlib.Path(sys.argv[1]).read_text()
block = re.search(r'python3 - "\$BUNDLE" "\$pending" <<\x27PY\x27\n(.*?)\nPY', script, re.S)
assert block, "extractor not found"
source = block.group(1)
compile(source, "<bootstrap extractor>", "exec")
assert os.geteuid() != 0, "adversarial archive suite must run as nonroot"


def member(
    name: str, kind: bytes = tarfile.REGTYPE, size: int = 0, pax: dict[str, str] | None = None
) -> tarfile.TarInfo:
    item = tarfile.TarInfo(name)
    item.type = kind
    item.size = size
    item.pax_headers = pax or {}
    return item


def check(members: list[tarfile.TarInfo], accepted: bool = False) -> None:
    with tempfile.TemporaryDirectory() as directory:
        base = pathlib.Path(directory)
        archive, output = base / "release.tar", base / "output"
        output.mkdir()
        with tarfile.open(archive, "w") as tar:
            for item in members:
                tar.addfile(item, io.BytesIO(b"0" * item.size) if item.size else None)
        result = subprocess.run(
            [sys.executable, "-c", source, str(archive), str(output)],
            capture_output=True,
            text=True,
        )
        assert (result.returncode == 0) == accepted, (result.stderr, [m.name for m in members])
        if not accepted:
            assert list(output.iterdir()) == [], "rejected archive wrote content"


for name in ("../escape", "/absolute", "a/../escape", "a//b", "a/./b", "a\\b"):
    check([member(name)])
check([member("a"), member("a")])
check([member("a/", tarfile.DIRTYPE), member("a")])
check([member("a"), member("a/b")])
for kind in (
    tarfile.SYMTYPE,
    tarfile.LNKTYPE,
    tarfile.CHRTYPE,
    tarfile.BLKTYPE,
    tarfile.FIFOTYPE,
    tarfile.GNUTYPE_SPARSE,
):
    check([member("bad", kind)])
check([member("bad", pax={"GNU.sparse.size": "999"})])
check([member(f"dir-{i}", tarfile.DIRTYPE) for i in range(5001)])
check([member("bin", tarfile.DIRTYPE), member("bin/worker", size=4)], accepted=True)
# A sparse outer tar fixture advertises >64 MiB without allocating that memory.
with tempfile.TemporaryDirectory() as directory:
    archive, output = pathlib.Path(directory) / "oversize.tar", pathlib.Path(directory) / "output"
    output.mkdir()
    info = member("oversize", size=67108865)
    with archive.open("wb") as out:
        out.write(info.tobuf())
        out.seek(512 + info.size + (512 - info.size % 512) % 512 + 1023)
        out.write(b"\0")
    result = subprocess.run(
        [sys.executable, "-c", source, str(archive), str(output)], capture_output=True
    )
    assert result.returncode != 0 and not list(output.iterdir()), result.stderr
# Nine 64 MiB regular members cross the aggregate 512 MiB cap. Sparse outer
# fixture avoids allocating the advertised bytes; extraction must reject first.
with tempfile.TemporaryDirectory() as directory:
    archive, output = pathlib.Path(directory) / "aggregate.tar", pathlib.Path(directory) / "output"
    output.mkdir()
    with archive.open("wb") as out:
        for i in range(9):
            item = member(f"file-{i}", size=67108864)
            out.write(item.tobuf())
            out.seek(out.tell() + item.size)
        out.write(b"\0" * 1024)
    result = subprocess.run(
        [sys.executable, "-c", source, str(archive), str(output)], capture_output=True
    )
    assert result.returncode != 0 and not list(output.iterdir()), result.stderr
print("adversarial archive extraction passed (nonroot)")
