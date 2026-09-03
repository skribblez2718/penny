"""Validate every tracked AGENTS.md in the repository against its exact grammar.

Two grammars exist, and exactly one file uses the first:

**Bootstrap grammar — the repository-root ``AGENTS.md`` only.** Pi loads the root by
walking *up* from the working directory, so it is the sole always-on entry point. It may
therefore carry bounded project-wide invariants, traversal/protocol/Pi-lookup guidance,
and the next-level index — but it may link *only* to sub-index ``AGENTS.md`` files, never
to a leaf document, and it may not name an operator filesystem path.

**Nested grammar — every other tracked ``AGENTS.md``, anywhere in the repository.** A
nested index is a heading plus complete, one-line, direct-child entries and nothing else.
This includes ``docs/penny/AGENTS.md``, which is outside ``docs/agents/**`` and was not
covered by the previous ``docs/agents``-only scope.

``docs/humans/`` is human-facing prose navigation and may contain no ``AGENTS.md`` at all.

Scope is enumerated from ``git ls-files`` — tracked files only. This is deliberate: the
checker must never descend into an ignored, operator-configured private root.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT_INDEX = "AGENTS.md"
HUMANS_PREFIX = "docs/humans/"

# A nested index entry is exactly: "- [Title](target): description" on one line.
ENTRY_RE = re.compile(r"^- \[(?P<label>[^\]]+)\]\((?P<target>[^)]+)\)(?::\s*(?P<desc>.*))?$")
LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^(?P<hashes>#+)\s+(?P<title>.*)$")
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "#")
ROUTING_PREFIXES = ("MUST READ FOR", "READ WHEN", "CONSULT WHEN")
ROUTING_RE = re.compile(r"^(?:MUST READ FOR|READ WHEN|CONSULT WHEN)\s+\S")

# Operator-filesystem shapes that must never appear in the always-on root file.
PRIVATE_PATH_RE = re.compile(r"(?:(?<![\w$])/(?:home|Users|root|mnt|media|var)/|~/|[A-Za-z]:\\)")

# The root is an always-on context cost paid on every turn and multiplied into every
# subagent. It is bounded so that domain detail cannot accumulate there.
ROOT_MAX_LINES = 120
ROOT_MAX_BYTES = 8_192


def tracked_files(root: Path) -> list[str]:
    """Return every tracked repository-relative path, NUL-safe."""
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def agents_files(tracked: list[str]) -> list[str]:
    return sorted(p for p in tracked if p == ROOT_INDEX or p.endswith("/AGENTS.md"))


def _strip_anchor(target: str) -> str:
    return target.split("#", 1)[0]


def _heading_levels(lines: list[str]) -> list[str]:
    return [m.group("hashes") for m in (HEADING_RE.match(ln) for ln in lines) if m]


# --------------------------------------------------------------------------- root


def _root_budget_errors(text: str, lines: list[str]) -> list[str]:
    errors: list[str] = []
    if len(lines) > ROOT_MAX_LINES:
        errors.append(
            f"root exceeds the {ROOT_MAX_LINES}-line bootstrap budget ({len(lines)} lines)"
        )
    size = len(text.encode("utf-8"))
    if size > ROOT_MAX_BYTES:
        errors.append(f"root exceeds the {ROOT_MAX_BYTES}-byte bootstrap budget ({size} bytes)")
    h1_count = _heading_levels(lines).count("#")
    if h1_count != 1:
        errors.append(f"root must have exactly one level-one heading (found {h1_count})")
    return errors


def _root_private_path_errors(lines: list[str]) -> list[str]:
    errors: list[str] = []
    for lineno, line in enumerate(lines, 1):
        match = PRIVATE_PATH_RE.search(line)
        if match:
            errors.append(
                f"line {lineno}: operator filesystem path {match.group(0)!r} "
                f"is forbidden in the public root index"
            )
    return errors


def _root_link_errors(text: str, tracked: set[str]) -> list[str]:
    errors: list[str] = []
    for label, raw_target in LINK_RE.findall(text):
        if raw_target.startswith(EXTERNAL_PREFIXES):
            continue
        target = _strip_anchor(raw_target)
        if not target:
            continue
        # The root points only at next-level sub-indexes. A link to a leaf document
        # skips the index chain and is the exact bloat this grammar prevents.
        if not target.endswith("/AGENTS.md"):
            errors.append(
                f"[{label}]({raw_target}) links past the index chain; "
                f"the root may link only to a sub-index AGENTS.md"
            )
        elif target not in tracked:
            errors.append(f"[{label}]({raw_target}) points to missing or untracked {target}")
    return errors


def _routing_error(lineno: int, label: str, target: str, desc: str) -> str | None:
    """Validate the controlled routing prefix used by an index entry."""
    if ROUTING_RE.match(desc):
        return None
    expected = ", ".join(f"{prefix} …" for prefix in ROUTING_PREFIXES)
    return f"line {lineno}: [{label}]({target}) must begin with one of: {expected}"


def _root_routing_errors(lines: list[str]) -> list[str]:
    """Require typed routing for root next-level index entries, not bootstrap prose."""
    errors: list[str] = []
    for lineno, raw in enumerate(lines, 1):
        entry = ENTRY_RE.match(raw.rstrip())
        if not entry:
            continue
        desc = (entry.group("desc") or "").strip()
        error = _routing_error(lineno, entry.group("label"), entry.group("target"), desc)
        if error:
            errors.append(error)
    return errors


def validate_root(text: str, tracked: set[str]) -> list[str]:
    """Bootstrap grammar for the repository-root AGENTS.md."""
    lines = text.splitlines()
    return (
        _root_budget_errors(text, lines)
        + _root_private_path_errors(lines)
        + _root_link_errors(text, tracked)
        + _root_routing_errors(lines)
    )


# ------------------------------------------------------------------------- nested


def _target_shape_error(target: str, raw_target: str, label: str) -> str | None:
    """Return an error when the entry target is not a direct child, else None."""
    if target.startswith("/") or ".." in Path(target).parts:
        return f"[{label}]({raw_target}) links outside its own directory"
    parts = Path(target).parts
    is_leaf = len(parts) == 1 and target.endswith(".md") and target != "AGENTS.md"
    is_subindex = len(parts) == 2 and parts[1] == "AGENTS.md"
    if not (is_leaf or is_subindex):
        return (
            f"[{label}]({raw_target}) is not a direct child "
            f"(expected 'file.md' or 'subdir/AGENTS.md')"
        )
    return None


def _entry_errors(
    lineno: int, line: str, directory: str, tracked: set[str], seen: set[str]
) -> list[str]:
    """Validate one matched entry line and record its target in ``seen``."""
    entry = ENTRY_RE.match(line)
    assert entry is not None
    label = entry.group("label")
    raw_target = entry.group("target")
    desc = (entry.group("desc") or "").strip()

    errors: list[str] = []
    if not desc:
        errors.append(f"line {lineno}: [{label}]({raw_target}) has no one-line description")
    else:
        routing_error = _routing_error(lineno, label, raw_target, desc)
        if routing_error:
            errors.append(routing_error)

    if raw_target.startswith(EXTERNAL_PREFIXES):
        errors.append(
            f"line {lineno}: [{label}]({raw_target}) must be a relative direct-child path"
        )
        return errors

    target = _strip_anchor(raw_target)
    shape_error = _target_shape_error(target, raw_target, label)
    if shape_error:
        errors.append(f"line {lineno}: {shape_error}")
        return errors

    if target in seen:
        errors.append(f"line {lineno}: duplicate entry for {target}")
    seen.add(target)

    resolved = f"{directory}/{target}"
    if resolved not in tracked:
        errors.append(
            f"line {lineno}: [{label}]({raw_target}) points to missing or untracked {resolved}"
        )
    return errors


def _scan_nested(path: str, text: str, tracked: set[str]) -> tuple[list[str], set[str]]:
    """Walk the file line by line, returning (errors, listed targets)."""
    directory = str(Path(path).parent)
    errors: list[str] = []
    seen: set[str] = set()
    heading_count = 0

    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        if not line.strip():
            continue

        heading = HEADING_RE.match(line)
        if heading:
            heading_count += 1
            if heading.group("hashes") != "#":
                errors.append(
                    f"line {lineno}: only one level-one heading is allowed; found {line.strip()!r}"
                )
            elif heading_count > 1:
                errors.append(f"line {lineno}: duplicate level-one heading {line.strip()!r}")
            continue

        if not ENTRY_RE.match(line):
            errors.append(
                f"line {lineno}: prose is forbidden in a nested index: {line.strip()[:72]!r}"
            )
            continue

        if heading_count == 0:
            errors.append(f"line {lineno}: entry appears before the index heading")
        errors.extend(_entry_errors(lineno, line, directory, tracked, seen))

    if heading_count == 0:
        errors.append("missing the level-one index heading")
    return errors, seen


def _expected_children(directory: str, tracked: set[str]) -> set[str]:
    """Every tracked direct-child document and direct subdirectory index."""
    prefix = f"{directory}/"
    expected: set[str] = set()
    for candidate in tracked:
        if not candidate.startswith(prefix) or not candidate.endswith(".md"):
            continue
        rel_parts = Path(candidate[len(prefix) :]).parts
        if len(rel_parts) == 1:
            if rel_parts[0] != "AGENTS.md":
                expected.add(rel_parts[0])
        elif f"{prefix}{rel_parts[0]}/AGENTS.md" in tracked:
            expected.add(f"{rel_parts[0]}/AGENTS.md")
    return expected


def validate_nested(path: str, text: str, tracked: set[str]) -> list[str]:
    """Nested grammar: heading plus complete direct-child one-line entries, nothing else."""
    errors, seen = _scan_nested(path, text, tracked)
    directory = str(Path(path).parent)
    # Completeness: an unlisted child orphans that branch of the chain.
    for missing in sorted(_expected_children(directory, tracked) - seen):
        errors.append(f"missing entry for direct child {missing}")
    return errors


# ---------------------------------------------------------------------------- run


def check(root: Path) -> list[str]:
    tracked_list = tracked_files(root)
    tracked = set(tracked_list)
    failures: list[str] = []

    for path in agents_files(tracked_list):
        if path.startswith(HUMANS_PREFIX):
            failures.append(f"{path}: AGENTS.md is forbidden under {HUMANS_PREFIX}")
            continue
        text = (root / path).read_text(encoding="utf-8")
        if path == ROOT_INDEX:
            errors = validate_root(text, tracked)
        else:
            errors = validate_nested(path, text, tracked)
        failures.extend(f"{path}: {err}" for err in errors)

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="repository root (default: cwd)")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    failures = check(root)
    if failures:
        print(f"FAIL: {len(failures)} AGENTS.md grammar violation(s)")
        for failure in failures:
            print(f"  {failure}")
        return 1

    count = len(agents_files(tracked_files(root)))
    print(f"OK: {count} tracked AGENTS.md file(s) satisfy the bootstrap/nested grammar.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
