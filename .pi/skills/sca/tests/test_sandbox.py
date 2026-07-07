"""
sca Skill — P10 Docker sandbox tests (Phase 9).

TWO tiers:

  1. FAST / deterministic (no Docker):
       * graceful no-Docker degradation via the injectable docker_available_check
         (mirrors provisioning.py's injectable which_fn pattern);
       * docker-run infra-failure (rc==125) => sandbox_used=False (never a clean
         run) via an injected spy subprocess_run;
       * the ARRAY-FORM argv is built with EVERY required security flag
         (resource limits verified by inspecting the actual argv, per IDEAL_STATE
         success-criterion (d) — "or by inspecting the actual argv, not just
         trusting the function's return value");
       * a PoC's own non-zero exit code NEVER raises;
       * empty/whitespace script rejected gracefully;
       * output truncation cap.

  2. LIVE / non-mocked (marked requires_docker + slow) — verified AGAINST THE
     REAL DOCKER DAEMON (Docker is genuinely installed here:
     `docker run --rm hello-world` succeeds):
       * (a) network isolation  — a real network attempt fails/times out
             (--network=none);
       * (b) filesystem containment — a host file OUTSIDE target_path (a
             DEDICATED FAKE FIXTURE created for this test, NEVER a real system
             file like /etc/shadow) is invisible; the in-scope target file IS
             visible;
       * (c) read-only enforcement — a write outside /tmp fails (EROFS); a write
             to /tmp succeeds;
       * (d) resource limits genuinely reach the real invocation (a live spy
             wraps the REAL subprocess.run, so docker really runs AND we inspect
             the exact argv);
       * timeout + --rm cleanup — a hanging PoC is killed, container not orphaned.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from sandbox import (  # noqa: E402
    DEFAULT_SANDBOX_IMAGE,
    POC_OUTPUT_MAX_CHARS,
    TARGET_MOUNT_POINT,
    build_docker_command,
    default_docker_available_check,
    run_in_sandbox,
)


# ── Docker live-availability gate ───────────────────────────────────────────


def _docker_really_works() -> bool:
    """True only if the real Docker daemon can run a trivial container."""
    if shutil.which("docker") is None:
        return False
    try:
        r = subprocess.run(
            ["docker", "run", "--rm", "hello-world"],
            capture_output=True, text=True, timeout=60,
        )
        return r.returncode == 0
    except Exception:
        return False


def _image_present() -> bool:
    """True if the default sandbox image is available to run locally."""
    try:
        r = subprocess.run(
            ["docker", "image", "inspect", DEFAULT_SANDBOX_IMAGE],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode == 0
    except Exception:
        return False


requires_docker = pytest.mark.skipif(
    not _docker_really_works(), reason="real Docker daemon not available"
)
requires_image = pytest.mark.skipif(
    not _image_present(),
    reason=f"sandbox image {DEFAULT_SANDBOX_IMAGE} not present",
)


# ── FAST TIER: no-Docker degradation ────────────────────────────────────────


class TestGracefulNoDockerDegradation:
    def test_unavailable_returns_sandbox_used_false_never_raises(self, tmp_path):
        res = run_in_sandbox(
            "echo hi", str(tmp_path),
            docker_available_check=lambda: False,
        )
        assert res["sandbox_used"] is False
        assert res["exit_code"] is None
        assert res["timed_out"] is False
        # The reason must make the "no sandbox" signal unambiguous — never
        # mistakable for a clean/passing PoC run.
        assert "not" in res["reason"].lower()
        assert "clean" in res["reason"].lower()

    def test_unavailable_does_not_invoke_subprocess(self, tmp_path):
        calls = []

        def spy_run(*a, **k):  # pragma: no cover - must NOT be called
            calls.append(a)
            raise AssertionError("subprocess must not run when Docker unavailable")

        res = run_in_sandbox(
            "echo hi", str(tmp_path),
            docker_available_check=lambda: False,
            subprocess_run=spy_run,
        )
        assert res["sandbox_used"] is False
        assert calls == []

    def test_hostile_availability_check_degrades_safely(self, tmp_path):
        def boom():
            raise RuntimeError("hostile check")

        res = run_in_sandbox("echo hi", str(tmp_path), docker_available_check=boom)
        assert res["sandbox_used"] is False

    def test_default_docker_available_check_uses_which(self):
        assert default_docker_available_check(which_fn=lambda _n: "/usr/bin/docker") is True
        assert default_docker_available_check(which_fn=lambda _n: None) is False


class TestEmptyScript:
    @pytest.mark.parametrize("script", ["", "   ", "\n\t  \n", None])
    def test_empty_or_whitespace_script_rejected(self, tmp_path, script):
        res = run_in_sandbox(
            script, str(tmp_path), docker_available_check=lambda: True,
        )
        assert res["sandbox_used"] is False
        assert res["exit_code"] is None
        assert "empty" in res["reason"].lower() or "whitespace" in res["reason"].lower()


# ── FAST TIER: argv construction (resource limits by argv inspection) ────────


class TestDockerCommandArgv:
    def _argv(self, **over):
        params = dict(
            script_via_stdin=True,
            target_path="/tmp/some-target",
            container_name="sca-sandbox-test",
            memory_limit="512m",
            cpu_limit="2",
            pids_limit=256,
            image=DEFAULT_SANDBOX_IMAGE,
        )
        params.update(over)
        return build_docker_command(**params)

    def test_array_form_no_shell_string(self):
        argv = self._argv()
        assert isinstance(argv, list)
        assert argv[0] == "docker"
        assert argv[1] == "run"

    def test_required_isolation_flags_present(self):
        argv = self._argv()
        assert "--rm" in argv
        assert "--network=none" in argv
        assert "--read-only" in argv
        assert "--cap-drop" in argv
        i = argv.index("--cap-drop")
        assert argv[i + 1] == "ALL"

    def test_tmpfs_is_the_single_writable_scratch(self):
        argv = self._argv()
        assert "--tmpfs" in argv
        i = argv.index("--tmpfs")
        assert argv[i + 1].startswith("/tmp:")

    def test_resource_limits_present_in_argv(self):
        argv = self._argv(memory_limit="256m", cpu_limit="1", pids_limit=64)
        for flag, val in (("--memory", "256m"), ("--cpus", "1"),
                          ("--pids-limit", "64")):
            assert flag in argv
            assert argv[argv.index(flag) + 1] == val

    def test_only_target_path_is_mounted(self):
        argv = self._argv(target_path="/host/target")
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
        assert mounts == [f"/host/target:{TARGET_MOUNT_POINT}:ro"]
        # No other host-mount mechanism is ever used.
        assert "--mount" not in argv
        assert "--volumes-from" not in argv

    def test_no_privilege_escalation_flags(self):
        argv = self._argv()
        joined = " ".join(argv)
        assert "--privileged" not in argv
        assert "--device" not in joined
        assert "--cap-add" not in argv
        assert "no-new-privileges" in joined

    def test_script_executed_from_stdin(self):
        argv = self._argv(script_via_stdin=True)
        assert argv[-3:] == [DEFAULT_SANDBOX_IMAGE, "sh", "-s"]
        assert "-i" in argv


# ── FAST TIER: infra-failure (rc==125) via injected spy subprocess_run ───────


class _FakeCompleted:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestInfraFailureIsNotACleanRun:
    def test_rc125_is_sandbox_used_false(self, tmp_path):
        def spy_run(argv, **k):
            return _FakeCompleted(125, stderr="Unable to find image")

        res = run_in_sandbox(
            "echo hi", str(tmp_path),
            docker_available_check=lambda: True, subprocess_run=spy_run,
        )
        assert res["sandbox_used"] is False
        assert res["exit_code"] == 125
        assert "not executed" in res["reason"].lower() or "sandbox never ran" in res["reason"].lower()

    def test_poc_nonzero_exit_is_a_real_run_not_an_error(self, tmp_path):
        def spy_run(argv, **k):
            return _FakeCompleted(1, stdout="exploit failed")

        res = run_in_sandbox(
            "exit 1", str(tmp_path),
            docker_available_check=lambda: True, subprocess_run=spy_run,
        )
        # A non-zero PoC exit is a NORMAL outcome: sandbox_used stays True and
        # nothing raises.
        assert res["sandbox_used"] is True
        assert res["exit_code"] == 1
        assert res["timed_out"] is False

    def test_docker_binary_vanished_is_sandbox_used_false(self, tmp_path):
        def spy_run(argv, **k):
            raise FileNotFoundError("docker gone")

        res = run_in_sandbox(
            "echo hi", str(tmp_path),
            docker_available_check=lambda: True, subprocess_run=spy_run,
        )
        assert res["sandbox_used"] is False
        assert res["exit_code"] is None

    def test_timeout_kills_container_and_marks_timed_out(self, tmp_path):
        kills = []

        def spy_run(argv, **k):
            if argv[:2] == ["docker", "kill"]:
                kills.append(argv)
                return _FakeCompleted(0)
            raise subprocess.TimeoutExpired(cmd=argv, timeout=k.get("timeout", 1))

        res = run_in_sandbox(
            "sleep 999", str(tmp_path), timeout_s=1,
            docker_available_check=lambda: True, subprocess_run=spy_run,
        )
        assert res["timed_out"] is True
        assert res["sandbox_used"] is True  # it DID run (then got killed)
        assert kills, "a timed-out container must be killed (no orphan)"
        assert kills[0][:2] == ["docker", "kill"]

    def test_output_is_truncated(self, tmp_path):
        big = "A" * (POC_OUTPUT_MAX_CHARS + 5000)

        def spy_run(argv, **k):
            return _FakeCompleted(0, stdout=big)

        res = run_in_sandbox(
            "echo big", str(tmp_path),
            docker_available_check=lambda: True, subprocess_run=spy_run,
        )
        assert len(res["stdout"]) < len(big)
        assert "truncated" in res["stdout"].lower()


# ── FAST TIER: a live spy proves the REAL argv carries the flags ─────────────


class TestArgvActuallyPassedToSubprocess:
    def test_real_argv_captured(self, tmp_path):
        seen = {}

        def capturing_run(argv, **k):
            # Record the argv the function ACTUALLY passes (not the return value).
            if argv[:2] == ["docker", "run"]:
                seen["argv"] = argv
                seen["input"] = k.get("input")
            return _FakeCompleted(0, stdout="ok")

        run_in_sandbox(
            "echo from-script", str(tmp_path), memory_limit="128m",
            cpu_limit="1", pids_limit=32,
            docker_available_check=lambda: True, subprocess_run=capturing_run,
        )
        argv = seen["argv"]
        assert "--network=none" in argv
        assert "--read-only" in argv
        assert argv[argv.index("--memory") + 1] == "128m"
        assert argv[argv.index("--cpus") + 1] == "1"
        assert argv[argv.index("--pids-limit") + 1] == "32"
        # The PoC script is fed via stdin, never in argv (no shell injection).
        assert seen["input"] == "echo from-script"
        assert "echo from-script" not in " ".join(argv)


# ── LIVE TIER: real Docker-daemon safety-property verification ───────────────


@pytest.mark.slow
@requires_docker
@requires_image
class TestRealSandboxSafetyProperties:
    def test_a_network_isolation_holds(self, tmp_path):
        """(a) A real network attempt must FAIL under --network=none."""
        script = (
            "wget -T 3 -qO- http://1.1.1.1 2>&1; "
            'echo "NET_EXIT=$?"'
        )
        res = run_in_sandbox(script, str(tmp_path), timeout_s=30)
        assert res["sandbox_used"] is True
        # The network call must not succeed: a non-zero NET_EXIT is recorded.
        assert "NET_EXIT=0" not in res["stdout"]
        combined = (res["stdout"] + res["stderr"]).lower()
        assert (
            "unreachable" in combined
            or "bad address" in combined
            or "network is unreachable" in combined
            or "can't connect" in combined
        ), combined

    def test_b_filesystem_containment_holds(self, tmp_path):
        """(b) A host file OUTSIDE target_path (a DEDICATED FAKE FIXTURE, never a
        real system file) is invisible; the in-scope target file IS visible."""
        # Dedicated fake fixture OUTSIDE the mounted target — proves isolation
        # without ever touching a real sensitive system file.
        host_secret = tmp_path / "host-only-secret.txt"
        host_secret.write_text("TOP-SECRET-HOST-FIXTURE-DO-NOT-LEAK\n")

        target = tmp_path / "target"
        target.mkdir()
        (target / "inscope.txt").write_text("IN-SCOPE-TARGET-CONTENT\n")

        script = (
            f"cat {TARGET_MOUNT_POINT}/inscope.txt; "
            f"cat {host_secret} 2>&1; "
            f"echo DONE"
        )
        res = run_in_sandbox(script, str(target), timeout_s=30)
        assert res["sandbox_used"] is True
        # In-scope target content IS visible.
        assert "IN-SCOPE-TARGET-CONTENT" in res["stdout"]
        # The host-only secret is NOT visible anywhere in the container.
        combined = res["stdout"] + res["stderr"]
        assert "TOP-SECRET-HOST-FIXTURE-DO-NOT-LEAK" not in combined
        assert "DONE" in res["stdout"]

    def test_c_read_only_root_enforced(self, tmp_path):
        """(c) A write outside /tmp fails (EROFS); a write to /tmp succeeds."""
        script = (
            "echo x > /should-fail.txt 2>&1; "
            'echo "ROOT_WRITE=$?"; '
            "echo y > /tmp/ok.txt; "
            'echo "TMP_WRITE=$?"'
        )
        res = run_in_sandbox(script, str(tmp_path), timeout_s=30)
        assert res["sandbox_used"] is True
        assert "ROOT_WRITE=0" not in res["stdout"]  # write outside /tmp failed
        assert "TMP_WRITE=0" in res["stdout"]        # /tmp scratch succeeded
        assert "read-only" in (res["stdout"] + res["stderr"]).lower()

    def test_c_target_mount_is_read_only(self, tmp_path):
        """The single target bind-mount is READ-ONLY: a write into it fails."""
        target = tmp_path / "target"
        target.mkdir()
        (target / "f.txt").write_text("orig\n")
        script = (
            f"echo hacked > {TARGET_MOUNT_POINT}/f.txt 2>&1; "
            'echo "TARGET_WRITE=$?"'
        )
        res = run_in_sandbox(script, str(target), timeout_s=30)
        assert "TARGET_WRITE=0" not in res["stdout"]
        # Host file is unchanged.
        assert (target / "f.txt").read_text() == "orig\n"

    def test_d_resource_limits_reach_real_invocation(self, tmp_path):
        """(d) The REAL docker run really executes AND the exact argv carries the
        resource limits (a live spy wraps the real subprocess.run)."""
        seen = {}
        real_run = subprocess.run

        def spy(argv, **k):
            if argv[:2] == ["docker", "run"]:
                seen["argv"] = list(argv)
            return real_run(argv, **k)

        res = run_in_sandbox(
            "echo alive", str(tmp_path), memory_limit="256m",
            cpu_limit="1", pids_limit=64, timeout_s=30, subprocess_run=spy,
        )
        assert res["sandbox_used"] is True
        assert res["exit_code"] == 0
        assert "alive" in res["stdout"]
        argv = seen["argv"]
        assert argv[argv.index("--memory") + 1] == "256m"
        assert argv[argv.index("--cpus") + 1] == "1"
        assert argv[argv.index("--pids-limit") + 1] == "64"

    def test_poc_own_exit_code_is_recorded_not_raised(self, tmp_path):
        """A PoC that exits non-zero is a NORMAL outcome, honestly recorded."""
        res = run_in_sandbox("exit 42", str(tmp_path), timeout_s=30)
        assert res["sandbox_used"] is True
        assert res["exit_code"] == 42
        assert res["timed_out"] is False

    def test_timeout_kills_runaway_container_no_orphan(self, tmp_path):
        """A hanging PoC is killed; no container is left orphaned."""
        res = run_in_sandbox("sleep 600", str(tmp_path), timeout_s=3)
        assert res["timed_out"] is True
        assert res["sandbox_used"] is True
        # No sca-sandbox container should remain running.
        listing = subprocess.run(
            ["docker", "ps", "--filter", "name=sca-sandbox-", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=30,
        )
        assert "sca-sandbox-" not in listing.stdout
