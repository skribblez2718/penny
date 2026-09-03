#!/usr/bin/env python3
"""Validate local Markdown links in the public documentation surface.

This is intentionally narrower than a site crawler. It reads only files enumerated by
``git ls-files`` in the root README/indexes, agent guidance, the Penny protocol index,
and the explicitly mirrored human pages. External URLs, mail links, and same-page
anchors are outside its scope.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from html import unescape
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT_PATHS = {"AGENTS.md", "README.md", "docs/penny/AGENTS.md"}
HUMAN_MIRRORS = {
    "docs/humans/architecture/project-standards.md",
    "docs/humans/coding/conventions.md",
    "docs/humans/coding/deployment-conventions.md",
    "docs/humans/coding/security-overview.md",
    "docs/humans/documentation/agents-md-standard.md",
    "docs/humans/prompts/layer-architecture.md",
    "docs/humans/prompts/overview.md",
}
LINK_RE = re.compile(r"!?\[[^\]]*\]\((?P<target>[^)\s]+(?:\s+[^)]*)?)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+(?P<heading>.+?)\s*#*\s*$")


def tracked_files(root: Path) -> list[str]:
    output = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"], check=True, capture_output=True
    ).stdout
    return sorted(item.decode("utf-8", "surrogateescape") for item in output.split(b"\0") if item)


def in_scope(path: str) -> bool:
    return (
        path in ROOT_PATHS
        or path in HUMAN_MIRRORS
        or (path.startswith("docs/agents/") and path.endswith(".md"))
    )


def _target_parts(raw: str) -> tuple[str, str]:
    target = raw.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    # Markdown permits a quoted title after a target. Titles are not part of the path.
    target = target.split(maxsplit=1)[0]
    target, _, anchor = target.partition("#")
    target, _, _query = target.partition("?")
    return unquote(target), unquote(anchor)


def _anchorize(heading: str) -> str:
    value = unescape(heading).strip().lower()
    value = re.sub(r"[`*_~]", "", value)
    value = re.sub(r"\[[^\]]+\]\([^)]*\)", lambda m: m.group(0).split("]", 1)[0][1:], value)
    value = re.sub(r"[^\w\s-]", "", value, flags=re.UNICODE)
    return re.sub(r"[\s-]+", "-", value).strip("-")


def anchors(path: Path) -> set[str]:
    seen: dict[str, int] = {}
    result: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        base = _anchorize(match.group("heading"))
        count = seen.get(base, 0)
        seen[base] = count + 1
        result.add(base if count == 0 else f"{base}-{count}")
    return result


def document_errors(root: Path, source: Path) -> list[str]:  # noqa: C901
    errors: list[str] = []
    text = source.read_text(encoding="utf-8")
    in_fence = False
    for line_no, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in LINK_RE.finditer(line):
            raw = match.group("target")
            target, anchor = _target_parts(raw)
            if not target:
                # Same-page anchors are intentionally outside this checker's scope.
                continue
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith("//"):
                continue
            candidate = (source.parent / target).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                errors.append(
                    f"{source.relative_to(root)}:{line_no}: local link escapes repository: {raw}"
                )
                continue
            if not candidate.exists() or not candidate.is_file():
                errors.append(f"{source.relative_to(root)}:{line_no}: missing local target: {raw}")
                continue
            if anchor and candidate.suffix.lower() == ".md" and anchor not in anchors(candidate):
                errors.append(
                    f"{source.relative_to(root)}:{line_no}: missing heading anchor #{anchor} in {target}"
                )
    return errors


def check(root: Path) -> list[str]:
    return [
        error
        for path in tracked_files(root)
        if in_scope(path)
        for error in document_errors(root, root / path)
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="repository root (default: cwd)")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    errors = check(root)
    if errors:
        print(f"FAIL: {len(errors)} local Markdown link error(s)")
        print("\n".join(f"  {error}" for error in errors))
        return 1
    print("OK: local Markdown links in the in-scope documentation surface resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
