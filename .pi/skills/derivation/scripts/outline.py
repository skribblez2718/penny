#!/usr/bin/env python3
"""Deterministic structural-outline extractor for the derivation gather phase.

A cheap, dependency-free (stdlib-only) reader that turns a text document into its
STRUCTURAL skeleton — the ordered list of section headings (level + title +
line), with zero body prose. It is the deterministic counterpart to
``prefilter.py``: where prefilter.py screens literal overlap, outline.py records
*structure only*, so the gather phase can pass a source's shape to the reviewer
as a POINTER without ever reproducing its protected expression.

It recognises the three heading conventions common to a source corpus:

  * Markdown ATX      — ``# Title`` … ``###### Title`` (trailing ``#`` stripped)
  * Markdown Setext   — a title line underlined by ``===`` (h1) or ``---`` (h2)
  * reStructuredText  — a title line underlined by a run of a punctuation char

Usage
-----
  outline.py --path FILE [--max-sections 200]

Emits a JSON report to stdout (``{path, section_count, sections:[{level,title,line}]}``)
and exits 0 (advisory, like prefilter.py). A missing/unreadable file yields a
``{"status": "error", ...}`` report and still exits 0 — a bad source must never
wedge the screen.

The module is import-safe: ``extract_outline(text)`` and ``section_titles(...)``
are pure and are reused in-process by the derivation playbook (facts/structure
only — never raw passages).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Mirror prefilter.py's scannable-file convention exactly (single source of truth
# for "what counts as a text source"): .md / .txt / .rst / .text.
_TEXT_EXT = {".md", ".txt", ".rst", ".text"}

# Markdown ATX heading: 1–6 leading '#', a space, the title, optional trailing '#'.
_ATX = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
# A Setext / reStructuredText underline: a run (>= 2) of a single punctuation char.
_UNDERLINE = re.compile(r"^([=\-~`:'\"^_*+#.])\1{1,}\s*$")
# rST underline chars, in a conventional level order (best-effort; structure only).
_RST_LEVELS = "=-~`:'\"^_*+#."


def read_text(path: Path) -> str:
    """Read a file as UTF-8, replacing undecodable bytes. Empty string on any
    failure (mirrors prefilter.read_text — a bad source must not raise)."""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — a bad source must not wedge the screen
        return ""


def _clean_title(title: str) -> str:
    """Collapse whitespace in a heading title (structure only, no prose)."""
    return " ".join(title.split()).strip()


def extract_outline(text: str, *, max_sections: int = 200) -> list[dict]:
    """Return the ordered structural outline of ``text`` as
    ``[{"level": int, "title": str, "line": int}]`` — headings ONLY, never body
    prose. Pure and deterministic. ``level`` is 1..6 for ATX/Setext; rST levels
    are assigned by first-seen underline char (1-based, capped at 6)."""
    lines = text.splitlines()
    sections: list[dict] = []
    rst_order: list[str] = []
    i = 0
    n = len(lines)
    while i < n and len(sections) < max_sections:
        line = lines[i]
        atx = _ATX.match(line)
        if atx:
            title = _clean_title(atx.group(2))
            if title:
                sections.append({"level": len(atx.group(1)), "title": title, "line": i + 1})
            i += 1
            continue
        # Setext / rST: a non-blank title line underlined by a punctuation run at
        # least as long as the (stripped) title.
        stripped = line.strip()
        if stripped and i + 1 < n:
            under = _UNDERLINE.match(lines[i + 1])
            if under and len(lines[i + 1].strip()) >= len(stripped) and not _ATX.match(line):
                ch = under.group(1)
                if ch == "=":
                    level = 1
                elif ch == "-":
                    level = 2
                else:
                    if ch not in rst_order:
                        rst_order.append(ch)
                    level = min(6, 2 + rst_order.index(ch) + 1)
                sections.append({"level": level, "title": _clean_title(stripped), "line": i + 1})
                i += 2
                continue
        i += 1
    return sections


def section_titles(outline: list[dict]) -> list[str]:
    """Just the titles, in order — the leanest pointer form."""
    return [str(s.get("title", "")) for s in outline if str(s.get("title", "")).strip()]


def outline_file(path: Path, *, max_sections: int = 200) -> dict:
    """Structural outline of a single file as a JSON-safe report dict."""
    if not path.is_file():
        return {"status": "error", "error": f"not a file: {path}", "path": str(path)}
    sections = extract_outline(read_text(path), max_sections=max_sections)
    return {
        "status": "ok",
        "path": str(path),
        "section_count": len(sections),
        "sections": sections,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Deterministic structural-outline extractor.")
    ap.add_argument("--path", required=True)
    ap.add_argument("--max-sections", type=int, default=200)
    args = ap.parse_args(argv)
    report = outline_file(Path(args.path), max_sections=max(1, args.max_sections))
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
