"""
sca Skill — Input validation & census helpers (Phase 2).

Pure, network-free functions used by the orchestrator during target validation
and the P0_CHARTER phase:

  - is_url_shaped(target_path):
      Return True when the target looks like a live URL / remote (http(s)://,
      git://, ssh://, scp-style git remote, or any explicit ``scheme://``).
      sca analyzes LOCAL source trees; live-URL analysis belongs to the jsa
      skill. The check is deliberately CONSERVATIVE: only strings with an
      explicit scheme (or scp-style remote) are treated as URL-shaped. Ambiguous
      bare strings (e.g. "example.com/repo") fall through so normal path
      validation can run and naturally reject them as "does not exist".

  - detect_lockfiles(target_path):
      Bounded, node_modules/.git-ignoring filesystem walk that records the JS/TS
      lockfiles present and how many distinct workspace roots contain one.
      Multiple workspaces are treated as ONE analysis unit — this function never
      raises and never hard-fails on mixed-language / multi-workspace repos.

SECURITY: no network access, no subprocess. The walk is bounded in depth and in
total entries scanned to avoid DoS on pathological repos.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List

# ── URL detection ────────────────────────────────────────────────────────

# Explicit schemes that unambiguously denote a remote / live target.
_EXPLICIT_SCHEMES = (
    "http://",
    "https://",
    "git://",
    "ssh://",
    "ftp://",
    "ftps://",
    "git+ssh://",
    "git+https://",
    "svn://",
)

# Any RFC-3986-ish "scheme://" prefix (letter, then letters/digits/+/-/.).
_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://")

# scp-style git remote, e.g. "git@github.com:org/repo.git".
_SCP_GIT_RE = re.compile(r"^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:")


# Classification labels returned by ``url_shape_kind``.
URL_KIND_SCHEME = "scheme"  # explicit ``scheme://`` (e.g. https://, git://)
URL_KIND_SCP = "scp"        # scp-style git remote (e.g. git@host:repo.git)


def url_shape_kind(target_path: Any) -> Any:
    """Classify how ``target_path`` is URL-shaped, or ``None`` if it is not.

    Returns:
      - ``URL_KIND_SCHEME`` for an explicit ``scheme://`` prefix. Such a string
        contains ``//`` and can NEVER name a single real local path segment, so
        there is no collision risk with an existing local directory.
      - ``URL_KIND_SCP`` for an scp-style git remote (``user@host:path``). This
        pattern CAN collide with a real local directory literally named that
        way, so callers must let an existence/is_dir check win over it.
      - ``None`` when the string is not URL-shaped (bare domains fall through).

    Never raises; non-string / empty input returns ``None``.
    """
    if not isinstance(target_path, str):
        return None
    s = target_path.strip()
    if not s:
        return None
    lowered = s.lower()
    for scheme in _EXPLICIT_SCHEMES:
        if lowered.startswith(scheme):
            return URL_KIND_SCHEME
    if _SCHEME_RE.match(s):
        return URL_KIND_SCHEME
    if _SCP_GIT_RE.match(s):
        return URL_KIND_SCP
    return None


def is_url_shaped(target_path: Any) -> bool:
    """Return True if ``target_path`` looks like a live URL / remote.

    Conservative by design (see module docstring): only explicit ``scheme://``
    prefixes and scp-style git remotes are treated as URL-shaped. Bare domains
    with no scheme fall through (return False) so path validation can handle
    them. Never raises; non-string input returns False.

    NOTE: this is a pure shape check and does NOT consult the filesystem. An
    scp-style string can collide with a real local directory of the same name;
    callers that must let existence win should use ``url_shape_kind`` and gate
    the ``URL_KIND_SCP`` case on an is_dir check (see orchestrate._validate_target).
    """
    return url_shape_kind(target_path) is not None


# ── Lockfile / monorepo detection ────────────────────────────────────────

# JS/TS package-manager lockfiles. Presence of any of these marks a workspace
# root. See IDEAL_STATE success_criteria #3.
LOCKFILE_NAMES: frozenset = frozenset(
    {
        "pnpm-lock.yaml",
        "yarn.lock",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "bun.lock",
        "bun.lockb",
    }
)

# Directories never worth walking for lockfile detection (vendored deps, VCS
# metadata, virtualenvs). Pruned during the walk to keep it bounded and to avoid
# counting a dependency's own lockfile as a workspace.
_IGNORE_DIRS: frozenset = frozenset(
    {
        "node_modules",
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "vendor",
        "__pycache__",
        ".tox",
        "dist",
        "build",
    }
)

# Walk bounds (DoS guardrails per security_review).
_MAX_DEPTH = 12
_MAX_ENTRIES = 50000


def detect_lockfiles(target_path: Any) -> Dict[str, Any]:
    """Return detected JS/TS lockfiles and distinct workspace count.

    Returns a dict::

        {"lockfiles": [<relative posix paths>...], "workspace_count": <int>}

    - ``lockfiles`` is a sorted list of lockfile paths relative to
      ``target_path`` (POSIX separators). Both bun.lock and bun.lockb in one
      directory are recorded (no dedup).
    - ``workspace_count`` is the number of DISTINCT directories that contain at
      least one lockfile. When no lockfiles are found it defaults to 1 (the repo
      root is the single analysis unit).

    Never raises; degrades to the empty default on missing / non-directory /
    unreadable targets. The walk is bounded in depth and total entries.
    """
    default: Dict[str, Any] = {"lockfiles": [], "workspace_count": 1}
    if not isinstance(target_path, str) or not target_path.strip():
        return default

    root = Path(target_path)
    try:
        if not root.is_dir():
            return default
    except OSError:  # pragma: no cover - defensive (unreadable path)
        return default

    root_str = str(root)
    found: List[str] = []
    workspace_dirs = set()
    entries_seen = 0

    try:
        for dirpath, dirnames, filenames in os.walk(root_str, topdown=True):
            # Depth bound (relative to the target root).
            rel = os.path.relpath(dirpath, root_str)
            depth = 0 if rel == "." else rel.count(os.sep) + 1
            if depth >= _MAX_DEPTH:
                dirnames[:] = []

            # Prune ignored + hidden directories in place (topdown=True).
            dirnames[:] = [
                d
                for d in dirnames
                if d not in _IGNORE_DIRS and not d.startswith(".")
            ]

            entries_seen += len(filenames) + len(dirnames)
            if entries_seen > _MAX_ENTRIES:  # pragma: no cover - DoS guardrail
                break

            for fn in filenames:
                if fn in LOCKFILE_NAMES:
                    rel_path = os.path.relpath(os.path.join(dirpath, fn), root_str)
                    found.append(Path(rel_path).as_posix())
                    workspace_dirs.add(dirpath)
    except OSError:  # pragma: no cover - defensive (walk error)
        # Partial results are still useful; degrade gracefully.
        pass

    found.sort()
    return {
        "lockfiles": found,
        "workspace_count": len(workspace_dirs) if workspace_dirs else 1,
    }
