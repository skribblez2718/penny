"""Static and bounded fixture checks only: never execute either guest script."""

from __future__ import annotations

import ast
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GUEST = Path(__file__).resolve().parents[1] / "guest"
INSTALL = (GUEST / "install-docker.sh").read_text()
CHECK = (GUEST / "check-docker.sh").read_text()
JOERN_INSTALL = (GUEST / "install-joern.sh").read_text()
WORKER = (GUEST / "worker.py").read_text()
VERIFIER = re.search(r"python3 - \"\$assets\" <<'PY'\n(.*?)\nPY", INSTALL, re.S)
CLOSURE = re.search(r"python3 - \"\$root\" <<'PY'\n(.*?)\nPY", CHECK, re.S)
assert VERIFIER is not None and CLOSURE is not None


def parse_curl_ldd(output: str) -> subprocess.CompletedProcess[str]:
    """Execute only the pure parser from the guest heredoc, never its subprocesses."""
    assert CLOSURE is not None
    functions = [
        node
        for node in ast.parse(CLOSURE.group(1)).body
        if isinstance(node, ast.FunctionDef) and node.name == "linked_files"
    ]
    assert len(functions) == 1
    script = (
        "import json, pathlib, re, sys\n"
        + ast.unparse(functions[0])
        + "\nprint(json.dumps(linked_files(sys.argv[1])))\n"
    )
    return subprocess.run(
        [sys.executable, "-c", script, output],
        text=True,
        capture_output=True,
        timeout=3,
        check=False,
    )


class GuestScripts(unittest.TestCase):
    def test_shell_and_worker_syntax(self) -> None:
        for name in (
            "install-docker.sh",
            "check-docker.sh",
            "install-joern.sh",
            "install-php.sh",
        ):
            subprocess.run(["bash", "-n", str(GUEST / name)], check=True, timeout=3)
        compile(WORKER, str(GUEST / "worker.py"), "exec")

    def test_joern_health_uses_package_identity_and_launcher_help(self) -> None:
        assert "--version" not in JOERN_INSTALL
        assert "--version" not in WORKER
        assert "--help" in JOERN_INSTALL
        assert '"--help"' in WORKER
        for component in ("joern-cli", "php2cpg", "jssrc2cpg"):
            assert component in JOERN_INSTALL

        functions = [
            node
            for node in ast.parse(WORKER).body
            if isinstance(node, ast.FunctionDef) and node.name == "joern_cli_package_listing"
        ]
        assert len(functions) == 1
        script = (
            "import pathlib, re, stat, sys\n"
            "from pathlib import Path\n"
            "class JobError(ValueError): pass\n"
            "JOERN_ROOT = pathlib.Path(sys.argv[1])\n"
            "JOERN_VERSION = '4.0.627'\n"
            "JOERN_CLI_PACKAGE = re.compile(r'^io\\.joern\\.joern-cli-([0-9]+(?:\\.[0-9]+){1,5})\\.jar$')\n"
            + ast.unparse(functions[0])
            + "\nprint(joern_cli_package_listing())\n"
        )

        def probe(names: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in names:
                    (root / name).write_bytes(b"fixture")
                return subprocess.run(
                    [sys.executable, "-c", script, str(root)],
                    text=True,
                    capture_output=True,
                    timeout=3,
                    check=False,
                )

        self.assertEqual(probe(("io.joern.joern-cli-4.0.627.jar",)).returncode, 0)
        for names in (
            ("io.joern.joern-cli-4.0.626.jar",),
            (
                "io.joern.joern-cli-4.0.627.jar",
                "io.joern.joern-cli-4.0.628.jar",
            ),
            (
                "io.joern.joern-cli-4.0.627.jar",
                "io.joern.joern-cli-4.0.627-launcher.jar",
            ),
        ):
            with self.subTest(names=names):
                self.assertNotEqual(probe(names).returncode, 0)

    def test_gate_precedes_every_side_effect(self) -> None:
        for script in (INSTALL, CHECK):
            gate = script.index("if ! require_guest; then")
            end = script.index("\nfi", gate)
            assert end < script.index("trap 'on_error")
            assert end < script.index("exec > >(")
            assert "systemd-detect-virt --vm" in script[:end]
            assert "0:0:400:1" in script[:end]
            assert "cmp -s" in script[:end]
            assert "penny-sca-vm-guest-v1" in script[:end]

    def test_install_check_boundary_and_safe_cleanup(self) -> None:
        assert "--build-fixture" in INSTALL
        assert 'exec "$script_dir/check-docker.sh"' in INSTALL
        assert "--observation-delay" in CHECK and "<= 60" in CHECK
        assert "sleep 45" not in CHECK and "sleep 60" not in INSTALL
        assert "docker image inspect penny-sca-fixture:local" in CHECK
        assert "trap cleanup EXIT" in CHECK
        assert 'trap \'on_error "$?" "$LINENO" "$BASH_COMMAND"\' ERR' in CHECK
        assert "--network none" in CHECK and "--internal sca-fixture-net" in CHECK
        assert "--read-only --cap-drop ALL --security-opt no-new-privileges" in CHECK
        for limit in (
            "--pids-limit 32",
            "--memory 64m",
            "--cpus 0.5",
            "memory.max",
            "pids.max",
            "cpu.max",
        ):
            assert limit in CHECK
        assert "libnss_dns.so.2" in CHECK and "/usr/bin/getent hosts" in CHECK
        assert '"http://$web_ip:8080/"' in CHECK and "http://sca-fixture-web:8080/" in CHECK
        assert (
            CHECK.count("/usr/bin/curl --fail --silent --show-error --max-time 5 --noproxy '*'")
            == 2
        )
        assert "wget" not in CHECK and "for name in sh httpd;" in CHECK
        assert "['/usr/bin/ldd', '/usr/bin/curl']" in CHECK
        assert CHECK.index("validate_sources(files)") < CHECK.index(
            "subprocess.run(['/bin/cp', '-L', '--', name, str(target)]"
        )
        assert (
            "cp -L /usr/bin/curl" in CHECK and "['/bin/cp', '-L', '--', name, str(target)]" in CHECK
        )
        assert "[[ -x /usr/bin/curl ]]" in INSTALL
        assert "json.dumps(result, sort_keys=True, separators=(',', ':'))" in CHECK

    def test_curl_closure_parser(self) -> None:
        good = (
            "\tlinux-vdso.so.1 (0x00007fff1234)\n"
            "\tlibcurl.so.4 => /lib/x86_64-linux-gnu/libcurl.so.4 (0x00007f1234)\n"
            "\tlibc.so.6 => /usr/lib/x86_64-linux-gnu/libc.so.6 (0x00007f9876)\n"
            "\t/lib64/ld-linux-x86-64.so.2 (0x00007f5555)\n"
        )
        parsed = parse_curl_ldd(good)
        self.assertEqual(parsed.returncode, 0, parsed.stderr)
        self.assertEqual(
            json.loads(parsed.stdout),
            [
                "/lib/x86_64-linux-gnu/libcurl.so.4",
                "/usr/lib/x86_64-linux-gnu/libc.so.6",
                "/lib64/ld-linux-x86-64.so.2",
            ],
        )
        for bad in (
            good.replace("/lib/x86_64-linux-gnu/libcurl.so.4", "not found"),
            good.replace("/lib/x86_64-linux-gnu/libcurl.so.4", "/etc/passwd"),
            good.replace("/lib/x86_64-linux-gnu/libcurl.so.4", "/lib/../etc/passwd"),
            good.replace("/lib/x86_64-linux-gnu/libcurl.so.4", "/lib64/libcurl.so.4"),
            good.replace("/lib/x86_64-linux-gnu/libcurl.so.4", "libcurl.so.4"),
            good.replace("/lib64/ld-linux-x86-64.so.2", "/etc/ld-linux-x86-64.so.2"),
            good.replace("\t/lib64/ld-linux-x86-64.so.2 (0x00007f5555)\n", ""),
            good + "\tlibc.so.6 => /usr/lib/x86_64-linux-gnu/libc.so.6 (0x00007f9876)\n",
            good + "unexpected line\n",
            "statically linked\n",
        ):
            with self.subTest(bad=bad):
                self.assertNotEqual(parse_curl_ldd(bad).returncode, 0)

    def test_curl_library_symlink_confinement(self) -> None:
        """Simulate guest symlink resolution, without reading or running guest libraries."""
        assert CLOSURE is not None
        functions = [
            node
            for node in ast.parse(CLOSURE.group(1)).body
            if isinstance(node, ast.FunctionDef) and node.name == "validate_sources"
        ]
        assert len(functions) == 1
        script = (
            "import json, pathlib, sys\nfrom unittest.mock import patch\n"
            + ast.unparse(functions[0])
            + "\nmapping = json.loads(sys.argv[1])\n"
            + "def resolved(path, strict=False): return pathlib.Path(mapping[str(path)])\n"
            + "with patch.object(pathlib.Path, 'resolve', resolved), "
            + "patch.object(pathlib.Path, 'is_file', return_value=True):\n"
            + "    validate_sources(list(mapping))\n"
        )

        def validate(mapping: dict[str, str]) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, "-c", script, json.dumps(mapping)],
                text=True,
                capture_output=True,
                timeout=3,
                check=False,
            )

        paths = {
            "/lib/x86_64-linux-gnu/libcurl.so.4": "/usr/lib/x86_64-linux-gnu/libcurl.so.4.8.0",
            "/lib64/ld-linux-x86-64.so.2": "/usr/lib64/ld-linux-x86-64.so.2",
        }
        self.assertEqual(validate(paths).returncode, 0)
        for escaped in ("/etc/passwd", "/usr/lib64/other-loader.so"):
            with self.subTest(escaped=escaped):
                self.assertNotEqual(
                    validate({**paths, "/lib/x86_64-linux-gnu/libcurl.so.4": escaped}).returncode,
                    0,
                )
        self.assertNotEqual(
            validate({**paths, "/lib64/ld-linux-x86-64.so.2": "/usr/lib64/other.so"}).returncode,
            0,
        )

    def test_manifest_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packages = root / "packages"
            packages.mkdir()
            sample = packages / "docker.io_29.1.3-0ubuntu3~22.04.2_amd64.deb"
            sample.write_bytes(b"fixture only")
            entry = {"file": sample.name, "sha256": hashlib.sha256(sample.read_bytes()).hexdigest()}

            def verify(entries: object) -> subprocess.CompletedProcess[str]:
                assert VERIFIER is not None
                (root / "packages.json").write_text(json.dumps(entries))
                return subprocess.run(
                    [sys.executable, "-c", VERIFIER.group(1), str(root)],
                    text=True,
                    capture_output=True,
                    timeout=3,
                    check=False,
                )

            self.assertEqual(verify([entry]).returncode, 0)
            epoch = packages / "libcap2_1%3a2.66-4ubuntu1_amd64.deb"
            epoch.write_bytes(b"epoch fixture")
            epoch_entry = {
                "file": epoch.name,
                "sha256": hashlib.sha256(epoch.read_bytes()).hexdigest(),
            }
            self.assertEqual(verify([entry, epoch_entry]).returncode, 0)
            epoch.unlink()
            epoch = packages / "libcap2_1:2.66-4ubuntu1_amd64.deb"
            epoch.write_bytes(b"literal epoch fixture")
            epoch_entry = {
                "file": epoch.name,
                "sha256": hashlib.sha256(epoch.read_bytes()).hexdigest(),
            }
            self.assertEqual(verify([entry, epoch_entry]).returncode, 0)
            epoch.unlink()
            sample.write_bytes(b"tampered")
            self.assertNotEqual(verify([entry]).returncode, 0)
            sample.write_bytes(b"fixture only")
            for invalid in (
                [entry, entry],
                [{**entry, "file": "../escape.deb"}],
                [{**entry, "file": "libcap2_1%3a2/66_amd64.deb"}],
                [{**entry, "file": "libcap2_1:2;touch_amd64.deb"}],
                [{**entry, "sha256": "0" * 64}],
                [{**entry, "extra": "unexpected"}],
                [],
                {"not": "an array"},
            ):
                self.assertNotEqual(verify(invalid).returncode, 0)
            extra = packages / "unlisted.deb"
            extra.write_bytes(b"extra")
            self.assertNotEqual(verify([entry]).returncode, 0)
            extra.unlink()
            sample.unlink()
            sample.symlink_to(root / "packages.json")
            self.assertNotEqual(verify([entry]).returncode, 0)


if __name__ == "__main__":
    unittest.main()
