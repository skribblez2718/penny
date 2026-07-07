"""
sca Skill — NodeGoat benchmark harness (Phase 11).

Pure, deterministic scoring for a "how well did the sca pipeline do against a
KNOWN-VULNERABLE application" benchmark. The reference target is OWASP NodeGoat
(https://github.com/OWASP/NodeGoat), a deliberately-vulnerable Node/Express app
with a well-understood catalogue of planted flaws.

What lives here:

  * ``GROUND_TRUTH_ENTRY_FIELDS`` — the documented per-entry ground-truth
    schema, mirroring the field style already established in
    ``scripts/normalize.py`` (``file``/``line``/``severity``/``cvss_4_0_vector``
    etc.). See ``ground-truth.json`` for the on-disk template.
  * ``compute_benchmark_metrics(ground_truth, discovered_findings, ...)`` — a
    PURE function returning TP/FP/FN counts and precision/recall/F1. It performs
    a deterministic one-to-one (greedy) match between ground-truth entries and
    discovered findings. NO network, NO subprocess, NO filesystem — the math is
    fully unit-testable with synthetic fixtures and does NOT depend on a real
    NodeGoat clone ever existing.
  * ``load_ground_truth(path)`` — a small JSON loader that returns the
    ``entries`` list (an honest empty list when the template has not been
    populated by someone who actually inspected the real repo).

HONESTY DISCIPLINE (same rule the runtime report generator follows): this module
NEVER fabricates ground-truth vulnerability locations. Real ``file:line`` entries
must be populated by a human who has genuinely cloned and inspected the real
NodeGoat repository (see ``ground-truth.json`` and ``README.md`` in this
directory). An empty template scores every real finding as a false positive,
which is the honest outcome of "we have not verified any ground truth yet" —
never a plausible-but-invented set of locations.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple


# ── Ground-truth schema ──────────────────────────────────────────────────
#
# Per-entry fields, mirroring scripts/normalize.py's NormalizedFinding style.
# ``file`` + ``line`` are the identity/location fields used for matching; the
# rest are descriptive metadata carried through for reporting.
GROUND_TRUTH_ENTRY_FIELDS = (
    "app_path",         # path to the vulnerable app root the entry belongs to
    "vuln_class",       # e.g. "command-injection", "nosql-injection", "ssrf"
    "file",             # source file (repo-relative), e.g. "app/routes/contributions.js"
    "line",             # 1-based line number of the vulnerable sink
    "severity",         # critical|high|medium|low|unknown (impact axis)
    "cvss_4_0_vector",  # CVSS 4.0 vector string, or null when not assigned
)


# ── Ground-truth loading (honest empty template tolerated) ───────────────


def load_ground_truth(path: str | os.PathLike[str]) -> List[Dict[str, Any]]:
    """Return the list of ground-truth entries from a ground-truth JSON file.

    The on-disk shape is ``{"schema": 1, ..., "entries": [ {...}, ... ]}``. An
    absent file, a malformed file, or a file whose ``entries`` is empty all
    return ``[]`` — an honest "no verified ground truth" signal rather than a
    fabricated set. Never raises on a missing/empty template.
    """
    p = Path(path)
    if not p.exists():
        return []
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(doc, dict):
        return []
    entries = doc.get("entries")
    if not isinstance(entries, list):
        return []
    # Keep only dict entries (defensive against a hand-edited template).
    return [e for e in entries if isinstance(e, dict)]


# ── Matching primitives ──────────────────────────────────────────────────


def _norm_path(value: Any) -> str:
    """Normalize a path for comparison: forward slashes, no leading './'."""
    s = str(value or "").replace("\\", "/").strip()
    while s.startswith("./"):
        s = s[2:]
    return s.strip("/")


def _files_match(a: Any, b: Any) -> bool:
    """True when two file paths refer to the same file by path-suffix match.

    A ground-truth ``file`` is typically repo-relative (``app/routes/x.js``)
    while a discovered finding's ``file`` may be absolute or relative to a
    different root. We compare by trailing path components so
    ``/clone/app/routes/x.js`` matches ``app/routes/x.js`` without either side
    having to know the other's root. Empty paths never match.
    """
    na, nb = _norm_path(a), _norm_path(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    pa, pb = na.split("/"), nb.split("/")
    shorter, longer = (pa, pb) if len(pa) <= len(pb) else (pb, pa)
    return longer[-len(shorter):] == shorter


def _entries_match(
    gt: Dict[str, Any],
    finding: Dict[str, Any],
    *,
    line_tolerance: int,
    match_vuln_class: bool,
) -> bool:
    """True when a discovered finding corresponds to a ground-truth entry.

    Matching is on (file, line) with an optional ``line_tolerance`` window
    (default 0 = exact) to absorb off-by-a-few reporting differences between
    tools. When ``match_vuln_class`` is enabled AND both sides carry a
    ``vuln_class``, they must also agree (case-insensitive) — off by default
    because tool taxonomies differ from the ground-truth taxonomy.
    """
    if not _files_match(gt.get("file"), finding.get("file")):
        return False
    gt_line = gt.get("line")
    f_line = finding.get("line")
    if not isinstance(gt_line, int) or not isinstance(f_line, int):
        return False
    if abs(gt_line - f_line) > max(0, line_tolerance):
        return False
    if match_vuln_class:
        gt_class = str(gt.get("vuln_class") or "").strip().lower()
        f_class = str(finding.get("vuln_class") or "").strip().lower()
        if gt_class and f_class and gt_class != f_class:
            return False
    return True


# ── Core metric computation (pure) ───────────────────────────────────────


def compute_benchmark_metrics(
    ground_truth: List[Dict[str, Any]],
    discovered_findings: List[Dict[str, Any]],
    *,
    line_tolerance: int = 0,
    match_vuln_class: bool = False,
) -> Dict[str, Any]:
    """Score discovered findings against a ground-truth catalogue.

    Performs a deterministic greedy one-to-one match: each ground-truth entry is
    paired with at most one discovered finding and vice versa, in list order.

      * true_positives  — ground-truth entries that matched a finding
      * false_positives — discovered findings that matched no ground-truth entry
      * false_negatives — ground-truth entries that matched no finding

    precision = TP / (TP + FP), recall = TP / (TP + FN),
    F1 = 2·P·R / (P + R). Each is defined as ``0.0`` when its denominator is
    zero (empty findings, empty ground truth, or no overlap) — never a
    divide-by-zero. Metrics are rounded to 6 decimal places for determinism.

    Pure: no I/O, no network, no subprocess. Inputs are plain lists of dicts.
    """
    gt = list(ground_truth or [])
    findings = list(discovered_findings or [])

    matched_findings: set[int] = set()
    matched_pairs: List[Tuple[int, int]] = []

    for gi, gt_entry in enumerate(gt):
        if not isinstance(gt_entry, dict):
            continue
        for fi, finding in enumerate(findings):
            if fi in matched_findings or not isinstance(finding, dict):
                continue
            if _entries_match(
                gt_entry,
                finding,
                line_tolerance=line_tolerance,
                match_vuln_class=match_vuln_class,
            ):
                matched_findings.add(fi)
                matched_pairs.append((gi, fi))
                break

    tp = len(matched_pairs)
    fp = len(findings) - len(matched_findings)
    fn = len(gt) - tp

    precision = _safe_div(tp, tp + fp)
    recall = _safe_div(tp, tp + fn)
    f1 = _safe_div(2 * precision * recall, precision + recall)

    return {
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
        "ground_truth_count": len(gt),
        "discovered_count": len(findings),
        "matched_pairs": matched_pairs,
    }


def _safe_div(numerator: float, denominator: float) -> float:
    """Return numerator/denominator, or 0.0 when the denominator is zero.

    Edge case (documented): empty ground truth or empty findings yields a 0.0
    metric rather than a divide-by-zero — a sensible, honest "nothing to measure"
    signal.
    """
    if not denominator:
        return 0.0
    return float(numerator) / float(denominator)
