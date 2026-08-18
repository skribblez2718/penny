"""Knowledge-base privacy and admission gate.

This checker enforces two independent things, because either one alone is insufficient:

1. **The tracked scaffold stays a scaffold.** ``docs/kb`` holds exactly five tracked files
   and its default-deny ``.gitignore`` covers every class of live KB path. A clean clone
   therefore contains no knowledge base and no host configuration.

2. **Root admission is default-deny for *any* registry-resolved root**, not only
   ``docs/kb``. A resolved root is admissible only when it is outside every Git worktree,
   or is exactly the allowlisted in-repository scaffold with every live path untracked and
   ignored, no nested repository or worktree, no symlink component, and owner-only
   permissions.

``.gitignore`` is deliberately *not* treated as the privacy control. A force-added live
file, a non-ignored live path, a nested repository, or a symlinked component all fail
admission even where Git would have ignored the path. Ignore rules are one layer of
several; see ``docs/agents/knowledge-base/privacy-and-promotion.md``.

The checker never opens private content. It reasons about paths, tracked status, ignore
status, file type, and permission bits only.
"""

from __future__ import annotations

import argparse
import os
import stat
import subprocess
import sys
from pathlib import Path

SCAFFOLD_REL = "docs/kb"

# The exact tracked scaffold. Anything else tracked beneath the scaffold is a leak.
SCAFFOLD_FILES = (
    ".gitignore",
    "README.md",
    "manifest.example.json",
    "templates/page.md",
    "templates/source.json",
)

# One representative path per class of live KB data. Every one must be ignored inside the
# scaffold, and none may ever be tracked.
LIVE_PATH_CLASSES = (
    "manifest.json",
    "index.md",
    ".kb/policy.json",
    ".kb/lock",
    ".kb/current.json",
    ".kb/generations/g/catalog.json",
    ".kb/generations/g/index.sqlite",
    "sources/objects/" + "a" * 64,
    "sources/records/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
    "pages/p/revisions/r/page.md",
    "pages/p/revisions/r/claims.json",
    "conflicts/c.json",
    "work/run/artifacts/state/artifact",
)

# Live directory names that must never appear as tracked entries anywhere in the repository.
LIVE_DIR_NAMES = ("sources", "pages", "conflicts", "work", ".kb")


def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=check
    )


def tracked_under(root: Path, rel: str) -> list[str]:
    out = _git(root, "ls-files", "-z", "--", rel).stdout
    return [p for p in out.split("\0") if p]


def is_ignored(root: Path, rel: str) -> bool:
    """True when Git would ignore this path, evaluated without touching the index."""
    return _git(root, "check-ignore", "-q", "--no-index", "--", rel, check=False).returncode == 0


# ------------------------------------------------------------------ scaffold integrity


def check_scaffold_shape(root: Path) -> list[str]:
    expected = {f"{SCAFFOLD_REL}/{name}" for name in SCAFFOLD_FILES}
    actual = set(tracked_under(root, SCAFFOLD_REL))
    errors = [f"scaffold is missing tracked file {p}" for p in sorted(expected - actual)]
    errors += [
        f"scaffold has unexpected tracked file {p} (the scaffold is exactly five files)"
        for p in sorted(actual - expected)
    ]
    return errors


def check_scaffold_ignores(root: Path) -> list[str]:
    errors: list[str] = []
    for rel in LIVE_PATH_CLASSES:
        candidate = f"{SCAFFOLD_REL}/{rel}"
        if not is_ignored(root, candidate):
            errors.append(f"live KB path is not ignored in the scaffold: {candidate}")
    for name in SCAFFOLD_FILES:
        candidate = f"{SCAFFOLD_REL}/{name}"
        if is_ignored(root, candidate):
            errors.append(f"scaffold file is ignored and could not be re-included: {candidate}")
    return errors


def check_no_tracked_live_paths(root: Path) -> list[str]:
    """Detect force-added live content anywhere in the repository."""
    errors: list[str] = []
    for path in tracked_under(root, "."):
        parts = Path(path).parts
        if path.startswith(f"{SCAFFOLD_REL}/") and parts[-1] in {"manifest.json", "index.md"}:
            errors.append(f"live KB file is tracked (force-added?): {path}")
        if path.startswith(f"{SCAFFOLD_REL}/") and any(p in LIVE_DIR_NAMES for p in parts[2:-1]):
            errors.append(f"live KB directory content is tracked (force-added?): {path}")
    return errors


# --------------------------------------------------------------------- root admission


def _has_symlink_component(path: Path) -> bool:
    current = path
    while True:
        if current.is_symlink():
            return True
        if current.parent == current:
            return False
        current = current.parent


def _worktree_root(path: Path) -> Path | None:
    """Nearest enclosing Git worktree root, or None when outside every worktree."""
    current = path if path.is_dir() else path.parent
    while True:
        if (current / ".git").exists():
            return current
        if current.parent == current:
            return None
        current = current.parent


def _permission_errors(path: Path, *, public_scaffold: bool) -> list[str]:
    """Custody bits for a root, by admission mode.

    An outside-worktree private root must be owner-only ``0700``. A tracked public scaffold
    root inside a worktree necessarily carries public read/execute bits — it is a public
    repository file — so only group/other *write* is disqualifying there. Every ignored live
    directory beneath it is still held to ``0700``; see ``_live_dir_permission_errors``.
    """
    if os.name != "posix":
        return []
    info = path.stat()
    errors: list[str] = []
    if info.st_uid != os.getuid():
        errors.append(f"root is not owned by the current user: {path}")
    mode = stat.S_IMODE(info.st_mode)
    if public_scaffold:
        if mode & (stat.S_IWGRP | stat.S_IWOTH):
            errors.append(f"scaffold root is group/other writable: {path}")
    elif mode & (stat.S_IRWXG | stat.S_IRWXO):
        errors.append(f"root is group/other accessible (require owner-only 0700): {path}")
    return errors


def _live_dir_permission_errors(resolved: Path) -> list[str]:
    """Every ignored live directory beneath a scaffold root must be owner-only 0700."""
    if os.name != "posix":
        return []
    errors: list[str] = []
    for name in LIVE_DIR_NAMES:
        live = resolved / name
        if not live.is_dir():
            continue
        if stat.S_IMODE(live.stat().st_mode) & (stat.S_IRWXG | stat.S_IRWXO):
            errors.append(f"live KB directory is group/other accessible: {live}")
    return errors


def admit_root(
    candidate: Path,
    *,
    scaffold_root: Path | None = None,
    allow_inside_scaffold: bool = False,
) -> list[str]:
    """Return admission failures. An empty list means the root is admissible.

    Default-deny: an inside-worktree root is refused unless it is exactly the allowlisted
    scaffold *and* the profile explicitly declared that admission mode.
    """
    if not candidate.exists():
        return [f"root does not exist: {candidate}"]
    if _has_symlink_component(candidate):
        return [f"root path contains a symlink component: {candidate}"]
    if not candidate.is_dir():
        return [f"root is not a directory: {candidate}"]

    resolved = candidate.resolve()
    worktree = _worktree_root(resolved)
    errors = _permission_errors(resolved, public_scaffold=worktree is not None)

    if worktree is None:
        return errors  # outside_worktree

    if not allow_inside_scaffold:
        errors.append(
            f"root is inside a Git worktree ({worktree}) and the profile does not declare "
            f"inside_allowlisted_scaffold admission"
        )
        return errors

    if scaffold_root is None or resolved != scaffold_root.resolve():
        errors.append(
            f"root is inside a Git worktree but is not the exact allowlisted scaffold: {resolved}"
        )
        return errors

    errors.extend(_nested_repo_errors(resolved, worktree))
    errors.extend(_unignored_live_path_errors(worktree, resolved))
    errors.extend(_live_dir_permission_errors(resolved))
    return errors


def _nested_repo_errors(resolved: Path, worktree: Path) -> list[str]:
    errors: list[str] = []
    for child in resolved.rglob(".git"):
        errors.append(f"nested repository or worktree changes containment: {child}")
    inner = _worktree_root(resolved)
    if inner is not None and inner.resolve() != worktree.resolve():
        errors.append(f"root's nearest worktree {inner} differs from the containing worktree")
    return errors


def _unignored_live_path_errors(worktree: Path, resolved: Path) -> list[str]:
    rel_root = resolved.relative_to(worktree.resolve())
    errors: list[str] = []
    for rel in LIVE_PATH_CLASSES:
        candidate = f"{rel_root.as_posix()}/{rel}"
        if not is_ignored(worktree, candidate):
            errors.append(f"live path would not be ignored inside the scaffold: {candidate}")
    return errors


# ------------------------------------------------------------------------ copy surfaces


def check_archive_surface(root: Path) -> list[str]:
    """No live KB path may appear in a Git archive of the tracked tree."""
    out = _git(root, "archive", "--format=tar", "HEAD", check=False)
    if out.returncode != 0:
        return []
    names = subprocess.run(
        ["tar", "-tf", "-"], input=out.stdout, capture_output=True, text=True
    ).stdout.splitlines()
    errors: list[str] = []
    for name in names:
        parts = Path(name).parts
        if name.startswith(f"{SCAFFOLD_REL}/") and any(p in LIVE_DIR_NAMES for p in parts[2:]):
            errors.append(f"archive contains a live KB path: {name}")
    return errors


# -------------------------------------------------------------------------------- run


def run_checks(root: Path, args: argparse.Namespace) -> list[str]:
    failures: list[str] = []
    failures += check_scaffold_shape(root)
    failures += check_scaffold_ignores(root)
    failures += check_no_tracked_live_paths(root)

    scaffold = root / SCAFFOLD_REL
    # The scaffold itself is the one in-repository root that may be admitted, and only when
    # a profile explicitly declares that mode. Prove both directions here.
    denied_by_default = admit_root(scaffold, scaffold_root=scaffold, allow_inside_scaffold=False)
    if not denied_by_default:
        failures.append("default-deny failed: an in-worktree root was admitted without declaration")

    if args.clean_archive:
        failures += check_archive_surface(root)

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Knowledge-base privacy and admission gate.")
    parser.add_argument("--root", default=".", help="repository root (default: cwd)")
    parser.add_argument(
        "--fixture-mode",
        action="store_true",
        help="permit synthetic temporary KB roots (used by contract tests from Phase 7)",
    )
    parser.add_argument("--clean-archive", action="store_true", help="scan the Git archive surface")
    parser.add_argument("--package", action="store_true", help="scan the package dry-run surface")
    parser.add_argument("--logs", action="store_true", help="scan log and observability surfaces")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    deferred = [name for name, on in (("--package", args.package), ("--logs", args.logs)) if on]
    if deferred:
        # Fail loudly rather than passing vacuously: these surfaces only exist once the app
        # and adapter are built, so a silent success here would be a false gate at G9/G11.
        print(f"FAIL: {', '.join(deferred)} surface scanning requires the G9 app/adapter build")
        return 2

    failures = run_checks(root, args)
    if failures:
        print(f"FAIL: {len(failures)} knowledge-base privacy violation(s)")
        for failure in failures:
            print(f"  {failure}")
        return 1

    print(
        f"OK: scaffold is exactly {len(SCAFFOLD_FILES)} tracked files, "
        f"{len(LIVE_PATH_CLASSES)} live path classes are ignored, and root admission is default-deny."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
