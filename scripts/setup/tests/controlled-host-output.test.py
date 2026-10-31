#!/usr/bin/env python3
"""Executable, nonroot evidence-publisher boundary tests. Never runs apply."""

import json
import pathlib
import re
import subprocess
import sys
import tempfile

script = pathlib.Path(sys.argv[1])
source = script.read_text()
match = re.search(
    r"publish_evidence\(\) \{\n    python3 -I -c '\n(.*?)\n' \"\$EVIDENCE\"",
    source,
    re.S,
)
assert match, "publisher not found"
publisher = match.group(1)
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    private = root / "private"
    private.mkdir(mode=0o700)
    fixed = str(root / "fixed-evidence")

    def publish(
        destination: pathlib.Path, code: str = publisher
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [sys.executable, "-I", "-c", code, str(destination), fixed],
            input=b"bounded-result\n",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    good = private / "good.txt"
    assert publish(good).returncode == 0
    assert good.read_bytes() == b"bounded-result\n"
    assert publish(good).returncode != 0, "existing destination overwritten"
    victim = private / "victim"
    victim.write_bytes(b"unchanged")
    symlink = private / "symlink"
    symlink.symlink_to(victim)
    assert publish(symlink).returncode != 0, "symlink destination overwritten"
    assert victim.read_bytes() == b"unchanged"
    alias = root / "alias"
    alias.symlink_to(private, target_is_directory=True)
    assert publish(alias / "substituted").returncode != 0, "symlink parent followed"
    other = root / "other"
    other.mkdir(mode=0o700)
    assert publish(other / "fresh").returncode == 0, "private scratch not allowed"
    other.chmod(0o777)
    assert publish(other / "not-private").returncode != 0, "writable parent accepted"
    assert not (other / "not-private").exists()
    # Deterministic race: substitute the destination immediately before link()
    # in the identical production publisher. O_EXCL/link() must not replace it.
    raced = private / "raced"
    injected = publisher.replace(
        "        os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)",
        '        os.symlink("victim", name, dir_fd=fd)\n'
        "        os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)",
    )
    assert injected != publisher
    assert publish(raced, injected).returncode != 0, "destination race won"
    assert raced.is_symlink() and victim.read_bytes() == b"unchanged"
    assert not list(private.glob(".penny-*")), "temporary file leaked"
    # Simulate root in the same code without privilege: the only permitted parent
    # is the fixed root-owned evidence dir; a /tmp ancestor fails root admission.
    root_code = publisher.replace("root = os.geteuid() == 0", "root = True")
    assert publish(other / "root-at-wrong-parent", root_code).returncode != 0
    assert publish(private / "root-under-tmp", root_code).returncode != 0
    assert not (private / "root-under-tmp").exists()
payload = re.search(
    r"<<'PY' \| publish_evidence\n(import datetime, json, sys.*?)\nPY", source, re.S
)
assert payload, "static receipt generator missing"
receipt = subprocess.run(
    [
        sys.executable,
        "-I",
        "-c",
        payload.group(1),
        *(["a" * 64] * 8),
        "/dev/sda",
        *(["b" * 64] * 4),
    ],
    capture_output=True,
    check=True,
)
parsed = json.loads(receipt.stdout)
assert parsed["unit_sha256"]["slice"] == "b" * 64
assert parsed["limits"]["slice_memory_max"] == "2G"
assert parsed["limits"]["stdout"] == parsed["limits"]["stderr"] == "null"
assert parsed["live_qualification"] == "NOT_RUN"
print("descriptor-relative output/symlink/race and static payload tests passed (nonroot)")
