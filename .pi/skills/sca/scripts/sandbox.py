"""
sca Skill — P10_VERIFICATION Docker sandbox execution primitive (Phase 9).

This module is the SOLE code-execution primitive in the entire sca pipeline: it
runs a vera-authored proof-of-concept (PoC) script against the analysis target
inside a locked-down Docker container. Every other phase is read-only analysis;
P10 is the one place target-adjacent code is actually executed, so the isolation
here is the highest-stakes control in the skill.

DESIGN (a single, ruthlessly-simple containment model):
  * The container has NO network              (--network=none).
  * Its root filesystem is READ-ONLY          (--read-only) with a SINGLE small
    writable scratch tmpfs at /tmp            (--tmpfs /tmp:...).
  * ALL Linux capabilities are dropped        (--cap-drop=ALL); no privileged
    mode, no device access, no cap re-adds.
  * Resource-bounded                          (--memory / --cpus / --pids-limit)
    plus a hard host-side timeout that KILLS a runaway container.
  * The ONLY host filesystem content visible inside the container is
    ``target_path``, bind-mounted READ-ONLY at /target. NOTHING else from the
    host is ever mounted. THIS is the out-of-scope enforcement mechanism: there
    is no "out-of-scope list" to check because nothing outside target_path is
    ever exposed in the first place (strictly safer than the originally-drafted
    "mount broader host access then restrict it" design).
  * ``--rm`` guarantees the container is torn down on exit (and, after a
    timeout-kill, removed too) — a malicious/runaway PoC cannot orphan state.

SECURITY / DISCIPLINE:
  * Every docker invocation is ARRAY-FORM (subprocess.run([...])) — never a
    shell-interpolated string, so a hostile target_path or script can never
    inject a host command. The PoC script itself runs as a shell script INSIDE
    the container (that is the whole point of a PoC), fed via STDIN to ``sh -s``
    so it never touches the host argv at all.
  * ``run_in_sandbox`` NEVER raises on a PoC's own failure: a non-zero exit
    code from the PoC is a NORMAL, expected outcome (a failed exploit attempt),
    not an orchestrator error.
  * Graceful no-Docker degradation: an injectable ``docker_available_check``
    (mirroring provisioning.py's injectable ``which_fn`` pattern) lets the
    caller/tests deterministically force the unavailable path. When Docker is
    unavailable — OR when the ``docker run`` itself fails to even start the
    container (daemon down, image missing, disk full: rc==125) — the result is
    ``sandbox_used=False`` with a clear reason. This is NEVER conflated with "the
    PoC ran and found nothing": a sandbox that never ran is a distinct,
    unambiguous signal, and it NEVER blocks the pipeline.

CONFIDENCE: CERTAIN — Docker is genuinely installed and working in this dev
environment (`docker run --rm hello-world` succeeds), and this module's safety
properties (network isolation, filesystem containment, read-only root, resource
limits, timeout cleanup) are LIVE-VERIFIED against the real Docker daemon by
test_sandbox.py, not mocked.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("sca.sandbox")

# ── Defaults (documented, overridable per call) ────────────────────────────

# A minimal, shell-capable base image. alpine ships a POSIX ``sh`` plus wget/nc
# (enough for a network-isolation PoC to *attempt* a connection and fail under
# --network=none). Pinned to a specific tag for reproducibility.
DEFAULT_SANDBOX_IMAGE = "alpine:3.19"

# Writable scratch tmpfs mounted at /tmp inside the otherwise read-only root.
# Small on purpose: a PoC needs a little scratch space, not a data lake. Sticky
# (mode=1777) like a real /tmp so unprivileged writes work.
TMPFS_MOUNT = "/tmp:rw,size=64m,mode=1777"

# The read-only bind-mount point for target_path inside the container.
TARGET_MOUNT_POINT = "/target"

# Hard cap on captured stdout/stderr chars persisted per stream (reuses the
# "never store unbounded agent-adjacent output" discipline established in the
# Phase 6b/7/8 truncation work). A pathologically chatty PoC cannot bloat state
# or the on-disk log: output beyond this is dropped with a truncation marker.
POC_OUTPUT_MAX_CHARS = 20000

# docker run's OWN failure exit code (could not create/start the container:
# daemon down, image pull failure, disk full, bad flag). Distinct from ANY exit
# code the PoC script itself may return — so a 125 means "the SANDBOX failed",
# never "the PoC ran and exited 125".
_DOCKER_RUN_INFRA_FAILURE_RC = 125

_TRUNCATION_MARKER = "\n…[truncated: output exceeded {cap} chars]"


def default_docker_available_check(
    which_fn: Callable[[str], Optional[str]] = shutil.which,
) -> bool:
    """Return True if a ``docker`` binary is resolvable on PATH.

    Mirrors provisioning.py's injectable ``which_fn`` pattern so tests never
    depend on the real PATH. This is a CHEAP availability probe (PATH only, no
    subprocess) — the deeper "daemon actually reachable / image actually
    runnable" condition is handled at run time by treating a docker-run infra
    failure (rc==125 / FileNotFoundError) as ``sandbox_used=False`` rather than
    as a clean PoC run. Keeping the default probe cheap and deterministic avoids
    a slow/side-effecting ``docker info`` on every call.
    """
    try:
        return which_fn("docker") is not None
    except Exception:  # pragma: no cover - defensive
        return False


def build_docker_command(
    *,
    script_via_stdin: bool,
    target_path: str,
    container_name: str,
    memory_limit: str,
    cpu_limit: str,
    pids_limit: int,
    image: str,
) -> List[str]:
    """Build the ARRAY-FORM ``docker run`` argv for a sandboxed PoC.

    Kept as a pure, separately-testable function so the exact security flags can
    be asserted deterministically (per IDEAL_STATE success-criterion (d):
    resource limits are verified by inspecting the actual argv, not by trusting
    the function's return value). The PoC script is supplied on STDIN to
    ``sh -s`` (``script_via_stdin=True`` appends ``-i``/``sh -s``), so it never
    appears in argv.

    The single ``-v {target}:{/target}:ro`` bind mount is the ONLY host path
    ever exposed; no other ``-v`` / ``--mount`` is ever added.
    """
    argv: List[str] = [
        "docker", "run",
        "--rm",                                  # tear down on exit (+ post-kill)
        "--name", container_name,                # deterministic handle for kill
        "--network=none",                        # NO network — primary control
        "--read-only",                           # read-only root filesystem
        "--tmpfs", TMPFS_MOUNT,                  # single writable scratch tmpfs
        "--memory", str(memory_limit),           # memory ceiling
        "--cpus", str(cpu_limit),                # cpu ceiling
        "--pids-limit", str(pids_limit),         # process-count ceiling (fork bomb)
        "--cap-drop", "ALL",                     # drop every Linux capability
        "--security-opt", "no-new-privileges",   # no setuid privilege escalation
        # THE ONLY host filesystem content ever visible (read-only):
        "-v", f"{target_path}:{TARGET_MOUNT_POINT}:ro",
        "-w", TARGET_MOUNT_POINT,                # start in the mounted target
    ]
    if script_via_stdin:
        argv.append("-i")                        # keep STDIN open for the script
    argv.append(image)
    argv.extend(["sh", "-s"])                    # execute the PoC from STDIN
    return argv


def _truncate(text: Optional[str], cap: int = POC_OUTPUT_MAX_CHARS) -> str:
    """Cap a captured output stream to ``cap`` chars with a clear marker."""
    if not text:
        return ""
    if len(text) <= cap:
        return text
    return text[:cap] + _TRUNCATION_MARKER.format(cap=cap)


def _result(
    *,
    exit_code: Optional[int],
    stdout: str,
    stderr: str,
    duration_s: float,
    timed_out: bool,
    sandbox_used: bool,
    reason: str,
) -> Dict[str, Any]:
    """Assemble the canonical run_in_sandbox return dict (single source of shape)."""
    return {
        "exit_code": exit_code,
        "stdout": _truncate(stdout),
        "stderr": _truncate(stderr),
        "duration_s": round(duration_s, 3),
        "timed_out": timed_out,
        "sandbox_used": sandbox_used,
        "reason": reason,
    }


def run_in_sandbox(
    script: str,
    target_path: str,
    *,
    timeout_s: int = 60,
    memory_limit: str = "512m",
    cpu_limit: str = "2",
    pids_limit: int = 256,
    image: str = DEFAULT_SANDBOX_IMAGE,
    docker_available_check: Callable[[], bool] = default_docker_available_check,
    subprocess_run: Callable[..., Any] = subprocess.run,
) -> Dict[str, Any]:
    """Execute ``script`` against ``target_path`` inside a locked-down container.

    Returns a dict with EXACTLY these keys::

        {
          "exit_code":   int | None,   # the PoC's own exit code (None if none)
          "stdout":      str,          # captured + truncated
          "stderr":      str,          # captured + truncated
          "duration_s":  float,
          "timed_out":   bool,         # killed for exceeding timeout_s
          "sandbox_used": bool,        # False => no isolation actually ran
          "reason":      str,          # human-readable status
        }

    NEVER raises on a PoC's own failure (a non-zero exit code is a normal,
    expected outcome). NEVER blocks the pipeline. When Docker is unavailable, or
    when ``docker run`` itself fails to start the container (rc==125 /
    FileNotFoundError), returns ``sandbox_used=False`` with a clear reason — a
    signal that is NEVER conflated with a clean PoC run.
    """
    started = time.monotonic()

    # ── Graceful no-Docker degradation (injectable check) ──
    try:
        available = bool(docker_available_check())
    except Exception:  # pragma: no cover - defensive (a hostile injected check)
        available = False
    if not available:
        return _result(
            exit_code=None, stdout="", stderr="",
            duration_s=time.monotonic() - started,
            timed_out=False, sandbox_used=False,
            reason=(
                "Docker unavailable (docker_available_check returned False); "
                "PoC NOT executed — this is NOT a clean/passing result, the "
                "sandbox never ran."
            ),
        )

    # An empty/whitespace-only script is nothing to run (defensive; the
    # orchestrator also rejects these before dispatch).
    if not isinstance(script, str) or not script.strip():
        return _result(
            exit_code=None, stdout="", stderr="",
            duration_s=time.monotonic() - started,
            timed_out=False, sandbox_used=False,
            reason="empty/whitespace-only PoC script; nothing executed",
        )

    container_name = f"sca-sandbox-{uuid.uuid4().hex}"
    argv = build_docker_command(
        script_via_stdin=True,
        target_path=target_path,
        container_name=container_name,
        memory_limit=memory_limit,
        cpu_limit=cpu_limit,
        pids_limit=pids_limit,
        image=image,
    )

    try:
        completed = subprocess_run(
            argv,
            input=script,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        # Hard timeout: KILL the container so a runaway/malicious PoC cannot hang
        # or exhaust the host. --rm removes it once killed. Best-effort cleanup;
        # never raises.
        _kill_container(container_name, subprocess_run)
        partial_out = _decode(getattr(exc, "output", None))
        partial_err = _decode(getattr(exc, "stderr", None))
        return _result(
            exit_code=None, stdout=partial_out, stderr=partial_err,
            duration_s=time.monotonic() - started,
            timed_out=True, sandbox_used=True,
            reason=(
                f"PoC exceeded timeout_s={timeout_s}; container killed and "
                f"removed (no orphan)."
            ),
        )
    except FileNotFoundError as exc:
        # docker binary vanished between the availability check and the run.
        return _result(
            exit_code=None, stdout="", stderr=str(exc),
            duration_s=time.monotonic() - started,
            timed_out=False, sandbox_used=False,
            reason=(
                "docker binary not found at run time; PoC NOT executed — "
                "sandbox never ran (NOT a clean result)."
            ),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return _result(
            exit_code=None, stdout="", stderr=str(exc),
            duration_s=time.monotonic() - started,
            timed_out=False, sandbox_used=False,
            reason=f"unexpected sandbox launch error: {exc}",
        )

    rc = completed.returncode
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""

    # docker-run infra failure (daemon down / image missing / disk full / bad
    # flag): rc==125 means the CONTAINER never ran, distinct from any exit code
    # the PoC itself could return. Treat as sandbox_used=False (never a clean
    # PoC run).
    if rc == _DOCKER_RUN_INFRA_FAILURE_RC:
        return _result(
            exit_code=rc, stdout=stdout, stderr=stderr,
            duration_s=time.monotonic() - started,
            timed_out=False, sandbox_used=False,
            reason=(
                "docker run failed to start the container (rc=125: daemon "
                "down / image missing / disk full); PoC NOT executed — sandbox "
                "never ran (NOT a clean result)."
            ),
        )

    # Normal completion: rc is the PoC's OWN exit code (0 or non-zero are both
    # legitimate, honestly-recorded outcomes).
    return _result(
        exit_code=rc, stdout=stdout, stderr=stderr,
        duration_s=time.monotonic() - started,
        timed_out=False, sandbox_used=True,
        reason=f"PoC executed in sandbox (exit_code={rc}).",
    )


def _kill_container(
    container_name: str, subprocess_run: Callable[..., Any]
) -> None:
    """Best-effort ``docker kill`` of a named container (never raises)."""
    try:
        subprocess_run(
            ["docker", "kill", container_name],
            capture_output=True, text=True, timeout=15,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("could not kill container %s: %s", container_name, exc)


def _decode(value: Any) -> str:
    """Coerce a TimeoutExpired's partial output (str/bytes/None) to str."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace")
        except Exception:  # pragma: no cover - defensive
            return ""
    return str(value)
