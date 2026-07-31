#!/usr/bin/env python3
"""Tier-1.5 compression-distance signal for the derivation skill.

Normalized Compression Distance between authored CONTENT and every source in the
CORPUS:  NCD(x, y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y)).

It is a TRIPWIRE, never a verdict, and it is NEVER exculpatory:

  * an unusually LOW distance *relative to this corpus's own distribution* means
    "read that source closely in Tier-2" — it can strengthen a rubric-based
    DERIVATIVE_RISK case, never establish one;
  * a HIGH / unflagged distance is NOT evidence of independence — structure,
    selection and paraphrase dependence survive compression distance untouched
    (the same caveat prefilter.py already carries for n-grams);
  * below the token floor NO number-based signal is emitted at all (valid: false).

Usage
-----
  ncd.py --content PATH --sources (DIR | manifest.json)
         [--min-tokens 1000] [--mad-k 2.0] [--min-sources 4]

`--sources` accepts exactly what prefilter.py accepts and is read through
prefilter.py's own loader + tokenizer, so both tiers see the same corpus and the
same normalized text. Emits a JSON report to stdout; exit code is always 0
(advisory) — the report's `status` field carries the signal.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import lzma
import statistics
import sys
import zlib
from pathlib import Path

_MIN_TOKENS = 1000  # length floor: NCD is not meaningful on short texts
_ZLIB_WINDOW = 32768  # zlib's 32 KiB match window — prefer lzma above it
_MIN_SOURCES = 4  # fewer valid sources ⇒ values only, no outlier flags
_MAD_K = 2.0  # flag ncd < median - K*MAD
_MAD_FLOOR = 0.01  # scale floor so a zero-MAD corpus still flags a low outlier

# One entry per compressor: name -> C(bytes) -> compressed size. zlib is the
# cheap first read; lzma is the second opinion and the one to trust above 32 KiB.
COMPRESSORS: dict = {
    "zlib": lambda b: len(zlib.compress(b, 9)),
    "lzma": lambda b: len(lzma.compress(b, preset=9)),
}


def load_prefilter() -> object | None:
    """Load the sibling prefilter.py in-process (no sys.path pollution) so both
    tiers share ONE tokenizer and ONE corpus loader. None if unavailable."""
    path = Path(__file__).resolve().parent / "prefilter.py"
    spec = importlib.util.spec_from_file_location("_derivation_prefilter", str(path))
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:  # noqa: BLE001 — a broken sibling must not wedge the screen
        return None
    return mod


def normalize(pf, text: str) -> str:
    """Tier-1's exact view of the text: prefilter.tokenize() (Unicode \\w+ runs,
    lowercased — markdown, punctuation and whitespace dropped) rejoined on
    single spaces. Both tiers therefore compare the same characters."""
    return " ".join(pf.tokenize(text))


def ncd(x: bytes, y: bytes, csize, cx: int | None = None) -> float:
    """NCD(x,y) with an optional precomputed C(x). Clamped at 0; values slightly
    above 1 are real (imperfect compressors) and are reported as-is."""
    cx = csize(x) if cx is None else cx
    cy, cxy = csize(y), csize(x + y)
    hi = max(cx, cy)
    return round(max(0.0, (cxy - min(cx, cy)) / hi), 4) if hi > 0 else 1.0


def score_source(sid: str, x_norm: str, y_norm: str, min_tokens: int, cx: dict) -> dict:
    """One per-source row. Below the token floor: valid=false and NO numbers."""
    row = {
        "source_id": sid,
        "ncd_zlib": None,
        "ncd_lzma": None,
        "content_tokens": len(x_norm.split()),
        "source_tokens": len(y_norm.split()),
        "valid": False,
        "outlier": False,
        "outlier_by": [],
        "note": "",
    }
    if row["content_tokens"] < min_tokens or row["source_tokens"] < min_tokens:
        row["note"] = f"below the {min_tokens}-token floor — no NCD signal emitted"
        return row
    row["valid"] = True
    x, y = x_norm.encode("utf-8"), y_norm.encode("utf-8")
    for name, csize in COMPRESSORS.items():
        row[f"ncd_{name}"] = ncd(x, y, csize, cx.get(name))
    if max(len(x), len(y)) > _ZLIB_WINDOW:
        row["note"] = "input exceeds zlib's 32 KiB window — trust ncd_lzma"
    return row


def distribution(rows: list[dict], name: str, mad_k: float, min_sources: int) -> dict:
    """Per-compressor corpus distribution. No fixed universal threshold exists:
    the flag line is derived from THIS corpus's median/MAD, or is None when too
    few valid sources make a distribution meaningless."""
    vals = [r[f"ncd_{name}"] for r in rows if r["valid"] and r[f"ncd_{name}"] is not None]
    if len(vals) < min_sources:
        return {"n": len(vals), "median": None, "mad": None, "threshold": None}
    med = statistics.median(vals)
    mad = statistics.median([abs(v - med) for v in vals])
    return {
        "n": len(vals),
        "median": round(med, 4),
        "mad": round(mad, 4),
        "threshold": round(med - mad_k * max(mad, _MAD_FLOOR), 4),
    }


def flag_outliers(rows: list[dict], dists: dict) -> None:
    """Mark valid sources conspicuously BELOW this corpus's own distribution under
    EITHER compressor (attention-only; agreement across both is stronger)."""
    for row in rows:
        if not row["valid"]:
            continue
        row["outlier_by"] = [
            name
            for name in COMPRESSORS
            if dists[name]["threshold"] is not None
            and row[f"ncd_{name}"] < dists[name]["threshold"]
        ]
        row["outlier"] = bool(row["outlier_by"])


def build_report(pf, content_path: Path, sources: Path, args) -> dict:
    x_norm = normalize(pf, pf.read_text(content_path))
    min_tokens = max(1, args.min_tokens)
    xb = x_norm.encode("utf-8")
    cx = {name: csize(xb) for name, csize in COMPRESSORS.items()}  # C(x) once, not per source
    rows = [
        score_source(e["id"], x_norm, normalize(pf, e["text"]), min_tokens, cx)
        for e in pf.load_corpus(sources)
    ]
    dists = {n: distribution(rows, n, args.mad_k, max(1, args.min_sources)) for n in COMPRESSORS}
    flag_outliers(rows, dists)
    rows.sort(key=lambda r: (r["ncd_lzma"] is None, r["ncd_lzma"] or 0.0))
    if any(r["outlier"] for r in rows):
        status = "flag"
    elif any(dists[n]["threshold"] is not None for n in COMPRESSORS):
        status = "clean"  # no outliers — NOT evidence of independence
    else:
        status = "insufficient_corpus"  # too few valid sources to compare against
    return {
        "status": status,
        "tier": 1.5,
        "axis": "information-theoretic similarity (tripwire only; never a verdict)",
        "compressors": ["zlib-9", "lzma-9"],
        "min_tokens": min_tokens,
        "mad_k": args.mad_k,
        "min_sources_for_outliers": max(1, args.min_sources),
        "content": str(content_path),
        "content_tokens": len(x_norm.split()),
        "sources_scored": len(rows),
        "valid_sources": sum(1 for r in rows if r["valid"]),
        "distribution": dists,
        "per_source": rows,
        "note": "A LOW outlier only elevates Tier-2 attention on that source; it never sets a "
        "verdict. A high, unflagged or insufficient_corpus result is NOT evidence of "
        "independence — structure/selection/paraphrase dependence survives compression distance.",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Tier-1.5 compression-distance (NCD) signal.")
    ap.add_argument("--content", required=True)
    ap.add_argument("--sources", required=True)
    ap.add_argument("--min-tokens", type=int, default=_MIN_TOKENS)
    ap.add_argument("--mad-k", type=float, default=_MAD_K)
    ap.add_argument("--min-sources", type=int, default=_MIN_SOURCES)
    args = ap.parse_args(argv)

    pf = load_prefilter()
    if pf is None:
        print(json.dumps({"status": "error", "error": "sibling prefilter.py not importable"}))
        return 0
    content_path = Path(args.content)
    if not content_path.is_file():
        print(json.dumps({"status": "error", "error": f"content not found: {content_path}"}))
        return 0
    print(json.dumps(build_report(pf, content_path, Path(args.sources), args), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
