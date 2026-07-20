#!/usr/bin/env python3
"""Tier-1 deterministic pre-filter for the derivation skill.

A cheap, dependency-free literal-overlap screen of authored CONTENT against an
N-source CORPUS. This covers ONLY the D1 (verbatim / near-verbatim) axis — the
non-literal axes (D2–D7: close paraphrase, structure/selection, examples,
analogies, figures, single-source dependence) require judgement and are annie's
job in Tier-2, not a script's. Therefore:

  * a HARD breach here lets annie short-circuit to DERIVATIVE_RISK, but
  * a CLEAN report does NOT imply independence (paraphrase defeats string match).

Usage
-----
  prefilter.py --content PATH --sources (DIR | manifest.json)
               [--ngram 8] [--flag-ratio 0.03] [--flag-run 24]

`--sources` is either a directory of source texts (``*.md``/``*.txt``/``*.rst``;
id = relative path, license = "unknown") or a ``manifest.json`` — a list of
``{id, path|url, origin, license, bucket}`` entries (path resolved relative to
the manifest). A missing/unknown license is reported as ``"unknown"`` (annie
treats unknown as restricted).

Emits a JSON report to stdout. Exit code is always 0 (advisory); the report's
``status`` field ("clean" | "flag") carries the signal.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_WORD = re.compile(r"\w+", re.UNICODE)
_TEXT_EXT = {".md", ".txt", ".rst", ".text"}


def tokenize(text: str) -> list[str]:
    return [m.group(0).lower() for m in _WORD.finditer(text)]


def ngram_positions(toks: list[str], n: int) -> list[str]:
    """Ordered n-gram (shingle) list — positional, so contiguous runs survive."""
    if len(toks) < n:
        return []
    return [" ".join(toks[i : i + n]) for i in range(len(toks) - n + 1)]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — a bad source must not wedge the screen
        return ""


def load_corpus(sources: Path) -> list[dict]:
    """-> [{id, origin, license, bucket, text}]. Directory or manifest.json."""
    entries: list[dict] = []
    if sources.is_dir():
        for p in sorted(sources.rglob("*")):
            if p.is_file() and p.suffix.lower() in _TEXT_EXT:
                entries.append(
                    {
                        "id": str(p.relative_to(sources)),
                        "origin": str(p.relative_to(sources)),
                        "license": "unknown",
                        "bucket": "",
                        "text": read_text(p),
                    }
                )
        return entries
    if sources.is_file():
        try:
            data = json.loads(read_text(sources))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"status": "error", "error": f"bad manifest: {exc}"}))
            raise SystemExit(0)
        base = sources.parent
        for item in data if isinstance(data, list) else []:
            path_str = str(item.get("path", ""))
            text = ""
            if path_str:
                p = Path(path_str)
                p = p if p.is_absolute() else base / p
                text = read_text(p)
            entries.append(
                {
                    "id": str(item.get("id") or path_str or item.get("url", "?")),
                    "origin": str(item.get("origin", "")),
                    "license": str(item.get("license") or "unknown"),
                    "bucket": str(item.get("bucket", "")),
                    "text": text,
                }
            )
        return entries
    print(json.dumps({"status": "error", "error": f"sources not found: {sources}"}))
    raise SystemExit(0)


def longest_true_run(flags: list[bool]) -> int:
    best = cur = 0
    for f in flags:
        cur = cur + 1 if f else 0
        best = max(best, cur)
    return best


def screen_one(content_ngrams: list[str], source_text: str, n: int) -> dict:
    src_set = set(ngram_positions(tokenize(source_text), n))
    if not content_ngrams:
        return {"overlap_ratio": 0.0, "matched_shingles": 0, "longest_run_tokens": 0, "sample_hits": []}
    flags = [g in src_set for g in content_ngrams]
    matched = [g for g, f in zip(content_ngrams, flags) if f]
    run = longest_true_run(flags)
    return {
        "overlap_ratio": round(len(matched) / len(content_ngrams), 4),
        "matched_shingles": len(matched),
        "longest_run_tokens": (run + n - 1) if run else 0,
        "sample_hits": matched[:5],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Tier-1 literal-overlap pre-filter.")
    ap.add_argument("--content", required=True)
    ap.add_argument("--sources", required=True)
    ap.add_argument("--ngram", type=int, default=8)
    ap.add_argument("--flag-ratio", type=float, default=0.03)
    ap.add_argument("--flag-run", type=int, default=24)
    args = ap.parse_args(argv)

    content_path = Path(args.content)
    if not content_path.is_file():
        print(json.dumps({"status": "error", "error": f"content not found: {content_path}"}))
        return 0

    n = max(1, args.ngram)
    content_ngrams = ngram_positions(tokenize(read_text(content_path)), n)
    corpus = load_corpus(Path(args.sources))

    per_source = []
    for e in corpus:
        m = screen_one(content_ngrams, e["text"], n)
        breach = m["overlap_ratio"] >= args.flag_ratio or m["longest_run_tokens"] >= args.flag_run
        per_source.append(
            {
                "id": e["id"],
                "origin": e["origin"],
                "license": e["license"],
                "bucket": e["bucket"],
                "breach": breach,
                **m,
            }
        )

    per_source.sort(key=lambda s: s["overlap_ratio"], reverse=True)
    max_ratio = max((s["overlap_ratio"] for s in per_source), default=0.0)
    max_run = max((s["longest_run_tokens"] for s in per_source), default=0)
    status = "flag" if any(s["breach"] for s in per_source) else "clean"

    report = {
        "status": status,
        "tier": 1,
        "axis": "D1 verbatim/near-verbatim only (non-literal axes are Tier-2)",
        "ngram": n,
        "flag_ratio": args.flag_ratio,
        "flag_run_tokens": args.flag_run,
        "content": str(content_path),
        "content_ngrams": len(content_ngrams),
        "sources_screened": len(per_source),
        "max_overlap_ratio": max_ratio,
        "max_longest_run_tokens": max_run,
        "per_source": per_source,
        "note": "clean does NOT imply independence — paraphrase/structure copying "
        "defeats literal matching and is judged in Tier-2.",
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
