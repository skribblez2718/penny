"""
sca Skill — Tool provisioning & supply-chain integrity (Phase 3).

Standalone, importable primitives consumed later (Phase 4/6/7) by the tool
extensions and the baseline/targeted scan dispatch. NOTHING here is wired into
orchestrate.py yet.

Provided primitives:

  compute_sha256(path)
      Deterministic SHA256 hex digest of the bytes on disk at ``path``.

  verify_or_lock(tool_name, binary_path, *, confirmed, lockfile_path=...)
      Trust-On-First-Use (TOFU) lock against a checked-in lockfile
      (``.pi/skills/sca/tool-lock.json``). Philosophy: a first-ever install must
      be EXPLICITLY confirmed by a human/operator, never silently trusted; once
      locked, any hash change is a BLOCKING failure (tamper / substitution),
      never a warning. See the CRITICAL note below.

  check_tool_installed(tool_name, which_fn=shutil.which) -> ToolStatus
  check_required_tools(which_fn=...)  -> (ok, missing)
  check_optional_tools(which_fn=...)  -> list[dict]
      PATH/filesystem interaction is entirely through the injectable ``which_fn``
      so tests never depend on the real PATH or real binaries.

CRITICAL (Truth-priority): this module NEVER fabricates or hardcodes a SHA256
for any real tool binary. A hash is only ever recorded by computing it from
whatever bytes are actually on disk at call time, and only when the caller
passes ``confirmed=True`` (a human who just watched a real install happen). No
"known good" hash for osv-scanner v2.4.0 (etc.) exists anywhere in this code.

SECURITY: no network access, no external process execution. All filesystem
reads are bounded to the given paths. A corrupt lockfile is treated as
"no entries" (with a warning) and is NEVER silently trusted as verified.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from tool_manifest import get_tool, required_tools, optional_tools


logger = logging.getLogger("sca.provisioning")

# Canonical lockfile location: <skill>/tool-lock.json (checked in at real
# provisioning time; metadata only, never binary bytes). Resolved relative to
# THIS file so it is never a hardcoded home-relative path.
#
# WARNING: this resolves INSIDE the real skill tree
# (.pi/skills/sca/tool-lock.json). Its design intent is real-provisioning-time
# state, NOT something a manual/live verification run should ever create. Tests
# and manual verification MUST pass an explicit lockfile_path override (e.g.
# ``tmp_path / "tool-lock.json"``) to avoid polluting real skill state. A stray
# tool-lock.json from a dev's manual run bit both Penny and Carren during
# independent review; it is gitignored (.pi/skills/sca/.gitignore) so it is not
# accidentally committed.
DEFAULT_LOCKFILE = Path(__file__).resolve().parent.parent / "tool-lock.json"

# Read chunk size for hashing (bounded memory on large binaries).
_HASH_CHUNK = 1024 * 1024


# ── Result / status containers ───────────────────────────────────────────


@dataclass(frozen=True)
class VerifyResult:
    """Outcome of a ``verify_or_lock`` call.

    ok      whether the tool may be trusted/used.
    status  one of:
              "locked"               newly recorded (first-ever, confirmed).
              "verified"             existing lock, hash matched.
              "blocked_unconfirmed"  first-ever, confirmed=False -> blocked.
              "blocked_mismatch"     existing lock, hash differs -> blocked.
              "blocked_missing_binary" no readable binary at binary_path.
    sha256  the freshly computed hash (or None if it could not be computed).
    reason  human-readable explanation.
    """

    ok: bool
    status: str
    sha256: Optional[str]
    reason: str


@dataclass(frozen=True)
class ToolStatus:
    """Result of ``check_tool_installed``."""

    installed: bool
    path: Optional[str]
    version_verified: bool


# ── SHA256 ───────────────────────────────────────────────────────────────


def compute_sha256(path) -> str:
    """Return the SHA256 hex digest of the file at ``path``.

    Reads the file in bounded chunks. Accepts a ``str`` or ``Path``. Raises
    ``FileNotFoundError`` / ``OSError`` if the file cannot be read — callers
    that must degrade gracefully should catch it (see ``verify_or_lock``).
    """
    h = hashlib.sha256()
    with open(os.fspath(path), "rb") as fh:
        for chunk in iter(lambda: fh.read(_HASH_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Lockfile read/write (crash-safe) ─────────────────────────────────────


def _read_lock(lockfile_path: Path) -> dict:
    """Return the lock document, or ``{"tools": {}}`` on missing/corrupt files.

    A missing lockfile (fresh checkout) is NOT an error. A malformed/corrupt
    lockfile is logged as a warning and treated as "no entries" — never
    silently trusted as containing verified hashes.
    """
    p = Path(lockfile_path)
    if not p.exists():
        return {"tools": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("tool-lock file is unreadable/corrupt (%s): %s", p, exc)
        return {"tools": {}}
    if not isinstance(data, dict) or not isinstance(data.get("tools"), dict):
        logger.warning("tool-lock file has unexpected shape (%s); ignoring", p)
        return {"tools": {}}
    return data


def _write_lock(lockfile_path: Path, data: dict) -> None:
    """Atomically write the lock document (temp file + os.replace)."""
    p = Path(lockfile_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, p)


# ── Trust-On-First-Use verify/lock ───────────────────────────────────────


def verify_or_lock(
    tool_name: str,
    binary_path,
    *,
    confirmed: bool,
    lockfile_path=DEFAULT_LOCKFILE,
    version: Optional[str] = None,
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> VerifyResult:
    """Verify ``binary_path`` against the lock, or lock it on first confirmed use.

    Behaviour (see VerifyResult.status):
      - Binary unreadable                    -> blocked_missing_binary.
      - No existing lock entry, confirmed=F  -> blocked_unconfirmed (no write).
      - No existing lock entry, confirmed=T  -> locked (records fresh hash).
      - Existing entry, hash matches         -> verified (idempotent).
      - Existing entry, hash differs         -> blocked_mismatch (never a
                                                warning; entry NOT overwritten).

    The recorded entry contains ONLY metadata (name, version, sha256,
    locked_at, source path) — never any binary bytes.

    WARNING: the default ``lockfile_path`` (DEFAULT_LOCKFILE) resolves inside
    the real skill tree (.pi/skills/sca/tool-lock.json). Tests and manual
    verification MUST pass an explicit ``lockfile_path`` override (e.g.
    ``tmp_path / "tool-lock.json"``) to avoid polluting real skill state.
    """
    # Compute the hash from actual on-disk bytes (never fabricated).
    try:
        digest = compute_sha256(binary_path)
    except (FileNotFoundError, OSError):
        return VerifyResult(
            ok=False,
            status="blocked_missing_binary",
            sha256=None,
            reason=f"no readable binary for {tool_name!r} at {binary_path}",
        )

    lock = _read_lock(lockfile_path)
    entry = lock["tools"].get(tool_name)

    if entry is not None:
        recorded = entry.get("sha256")
        if recorded == digest:
            return VerifyResult(
                ok=True,
                status="verified",
                sha256=digest,
                reason=f"{tool_name} hash matches locked value",
            )
        return VerifyResult(
            ok=False,
            status="blocked_mismatch",
            sha256=digest,
            reason=(
                f"{tool_name} hash {digest} does not match locked "
                f"{recorded}; refusing to trust (possible tamper/substitution)"
            ),
        )

    # No existing entry.
    if not confirmed:
        return VerifyResult(
            ok=False,
            status="blocked_unconfirmed",
            sha256=digest,
            reason=(
                f"{tool_name} is first-seen and has no lock entry; refusing to "
                "trust without explicit human confirmation (confirmed=True)"
            ),
        )

    # First-ever install, explicitly confirmed -> record it.
    lock["tools"][tool_name] = {
        "version": version,
        "sha256": digest,
        "locked_at": now_fn().isoformat(),
        "source_path": str(binary_path),
    }
    _write_lock(lockfile_path, lock)
    return VerifyResult(
        ok=True,
        status="locked",
        sha256=digest,
        reason=f"{tool_name} recorded into lock on first confirmed install",
    )


# ── PATH / installation checks (injectable which_fn) ──────────────────────


def _path_is_usable(path: Optional[str]) -> bool:
    """True only if ``path`` names an existing regular file (a which_fn may lie).

    Guards the edge case where which_fn returns a path but nothing real is
    behind it. Executable-bit is best-effort: on some filesystems the bit may
    be absent yet the file still dispatchable, so existence-as-a-file is the
    hard gate and executability is not required to report installed.
    """
    if not path:
        return False
    try:
        return os.path.isfile(path)
    except OSError:  # pragma: no cover - defensive
        return False


def check_tool_installed(
    tool_name: str,
    which_fn: Callable[[str], Optional[str]] = shutil.which,
) -> ToolStatus:
    """Return a ToolStatus for ``tool_name`` using an injectable ``which_fn``.

    Looks up the tool's ``binary`` name (which may differ from ``tool_name``,
    e.g. retire.js -> "retire") via ``which_fn``. ``installed`` is True only
    when the resolved path names a real file. ``version_verified`` is always
    False in this phase (verifying a version would require invoking the binary,
    which this phase forbids). Raises ``UnknownToolError`` for unknown tools.
    """
    spec = get_tool(tool_name)  # raises UnknownToolError for unknown names
    resolved = which_fn(spec.binary)
    if _path_is_usable(resolved):
        return ToolStatus(installed=True, path=resolved, version_verified=False)
    return ToolStatus(installed=False, path=None, version_verified=False)


def check_required_tools(
    which_fn: Callable[[str], Optional[str]] = shutil.which,
) -> Tuple[bool, List[str]]:
    """Return (ok, missing) for the REQUIRED tier.

    ``ok`` is False when ANY required tool is missing; ``missing`` lists every
    absent required tool by name. A missing required tool is BLOCKING (the
    enforcement of that block is wired up in a later phase; this function only
    reports it correctly).
    """
    missing = [
        spec.name
        for spec in required_tools()
        if not check_tool_installed(spec.name, which_fn=which_fn).installed
    ]
    return (len(missing) == 0, missing)


def check_optional_tools(
    which_fn: Callable[[str], Optional[str]] = shutil.which,
) -> List[dict]:
    """Return per-tool status for the OPTIONAL tier (never blocking).

    Each row: ``{"tool", "installed", "path", "degraded", "note"}``. A missing
    optional tool is marked ``degraded=True`` with a human-readable note; it
    NEVER causes a blocking failure.
    """
    rows: List[dict] = []
    for spec in optional_tools():
        status = check_tool_installed(spec.name, which_fn=which_fn)
        if status.installed:
            rows.append(
                {
                    "tool": spec.name,
                    "installed": True,
                    "path": status.path,
                    "degraded": False,
                    "note": "",
                }
            )
        else:
            rows.append(
                {
                    "tool": spec.name,
                    "installed": False,
                    "path": None,
                    "degraded": True,
                    "note": (
                        f"optional tool {spec.name!r} not found on PATH; scan "
                        "coverage is degraded (non-blocking)"
                    ),
                }
            )
    return rows
