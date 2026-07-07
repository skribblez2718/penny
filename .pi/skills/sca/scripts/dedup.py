"""
sca Skill — Deterministic findings deduplication (Phase 5).

Standalone, importable. NOTHING here is wired into orchestrate.py yet. No
network, no subprocess, no ML/embedding dependency — dedup uses ONLY Python's
stdlib ``difflib.SequenceMatcher`` for textual similarity, so results are fully
deterministic and reproducible.

  deduplicate_findings(findings, similarity_threshold=0.85)
      -> (deduplicated_list, merge_record)

Two stages:

  PRIMARY (exact key)
      Collapse findings sharing the exact key (tool, rule_id, file, line) into
      one, PREFERRING the finding with more populated fields (so we keep the
      richer record). COLUMN-AWARE: when BOTH compared findings carry a
      non-None ``column``, the column must ALSO match for a collapse. If either
      column is None we FALL BACK to the base (tool, rule_id, file, line) key
      (documented fallback). This prevents two genuinely-different secrets on
      the same line but different columns from silently collapsing.

  SECONDARY (textual similarity)
      For findings that do NOT share a primary key, compute
      ``SequenceMatcher(None, a.description, b.description).ratio()``. Two
      findings merge when ALL of:
        * ratio >= similarity_threshold (default 0.85), AND
        * same file, AND
        * |line_a - line_b| <= SIMILARITY_LINE_WINDOW (== 5, INCLUSIVE), AND
        * NOT (both have a non-None column AND those columns differ).
      The higher-CONFIDENCE finding survives.

SECRETS SAFETY (Carren-reproduced, Truth-priority): secret-detection rules
(gitleaks/semgrep generic-secrets/trufflehog) emit a STATIC, per-rule
``description`` that by design never contains the secret value — so two
GENUINELY-DIFFERENT secrets flagged by the same rule have identical description
text (SequenceMatcher ratio 1.0). Relying on description similarity alone would
silently merge them and hide a real leaked secret. The column-difference guard
above is the fix: two truly-duplicate findings from re-running the same tool on
the same code report the SAME column, whereas two distinct secrets a few
columns apart report DIFFERENT columns — so a column mismatch is treated as a
hard "do not merge" signal on both stages, regardless of description ratio.
LIMITATION: the column-conflict guard only fires when BOTH findings carry a
non-None column (see _columns_conflict). If EITHER finding has column=None --
not just both -- there is no positional signal on that side of the comparison,
and we fall back to the description/line heuristic; the conservative 0.85
threshold + line window still bound the risk, but two distinct same-line
secrets with identical boilerplate could theoretically still merge whenever at
least one of them lacks a column. In practice gitleaks/semgrep both populate
StartColumn/startColumn for secret matches, so this residual case is rare.

CONFIDENCE vs SEVERITY (Truth-priority): merge selection in the similarity
stage uses CONFIDENCE only — never severity. A scarier severity with lower
confidence does NOT win. The two axes stay independent throughout.

TRADEOFF (documented, security-reviewed): the 0.85 threshold plus the
file + line-window guard is a deliberately CONSERVATIVE choice. An overly
aggressive similarity merge could hide a genuinely distinct vulnerability
(false-merge). We accept keeping occasional near-duplicates over risking a
silent merge of two real, different findings.

merge_record shape: ``{surviving_id: [merged_away_id, ...], ...}`` — keyed by
every surviving finding id (empty list when nothing was merged into it), for
coverage accounting downstream.
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Dict, List, Tuple

from normalize import NormalizedFinding


# Line proximity window for the SECONDARY (similarity) stage. INCLUSIVE:
# |line delta| == SIMILARITY_LINE_WINDOW still counts as "close enough".
SIMILARITY_LINE_WINDOW = 5

# Confidence ranking for the similarity-stage "keep higher confidence" rule.
# This ranks CONFIDENCE only; severity is never consulted here.
_CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1, "unknown": 0}


# ── helpers ──────────────────────────────────────────────────────────────


def _populated_field_count(finding: NormalizedFinding) -> int:
    """Count meaningfully-populated fields (non-None, non-empty)."""
    count = 0
    for value in vars(finding).values():
        if value is None:
            continue
        if isinstance(value, str) and value == "":
            continue
        if isinstance(value, (list, tuple, dict)) and len(value) == 0:
            continue
        count += 1
    return count


def _confidence_rank(finding: NormalizedFinding) -> int:
    return _CONFIDENCE_RANK.get((finding.confidence or "").strip().lower(), 0)


def _columns_conflict(a: NormalizedFinding, b: NormalizedFinding) -> bool:
    """True when BOTH findings have a non-None column AND those columns differ.

    A conflicting column is a hard "these are distinct findings" signal used by
    BOTH dedup stages (see module docstring, SECRETS SAFETY). When either
    column is None we return False (no positional signal -> fall back to the
    base key / description heuristic).
    """
    return (
        a.column is not None
        and b.column is not None
        and a.column != b.column
    )


def _primary_match(a: NormalizedFinding, b: NormalizedFinding) -> bool:
    """PRIMARY exact-key match, column-aware.

    Requires equal (tool, rule_id, file, line). Additionally, when BOTH
    findings carry a non-None column, the columns must be equal; if either
    column is None we fall back to the base key (documented fallback).
    """
    if (a.tool, a.rule_id, a.file, a.line) != (b.tool, b.rule_id, b.file, b.line):
        return False
    return not _columns_conflict(a, b)


def _prefer_more_populated(
    a: NormalizedFinding, b: NormalizedFinding
) -> Tuple[NormalizedFinding, NormalizedFinding]:
    """Return (winner, loser); winner has more populated fields. Ties keep ``a``."""
    if _populated_field_count(b) > _populated_field_count(a):
        return b, a
    return a, b


def _prefer_higher_confidence(
    a: NormalizedFinding, b: NormalizedFinding
) -> Tuple[NormalizedFinding, NormalizedFinding]:
    """Return (winner, loser); winner has higher CONFIDENCE. Ties keep ``a``."""
    if _confidence_rank(b) > _confidence_rank(a):
        return b, a
    return a, b


def _merge_into(merge_record: Dict[str, List[str]], winner_id: str,
                loser_id: str) -> None:
    """Fold ``loser_id`` (and anything it previously absorbed) into ``winner_id``."""
    absorbed = merge_record.setdefault(winner_id, [])
    absorbed.append(loser_id)
    if loser_id in merge_record and loser_id != winner_id:
        absorbed.extend(merge_record.pop(loser_id))


# ── public API ───────────────────────────────────────────────────────────


def deduplicate_findings(
    findings: List[NormalizedFinding],
    similarity_threshold: float = 0.85,
) -> Tuple[List[NormalizedFinding], Dict[str, List[str]]]:
    """Deduplicate ``findings`` deterministically.

    Returns ``(deduplicated_list, merge_record)`` where ``merge_record`` maps
    each surviving finding id to the list of ids merged into it (possibly
    empty). See module docstring for the two-stage algorithm and tradeoffs.
    """
    if not findings:
        return [], {}

    merge_record: Dict[str, List[str]] = {}

    # ── PRIMARY: exact (tool, rule_id, file, line) + column-aware ───────────────────────
    # List-based (not a plain dict) because the column-fallback semantics can't
    # be expressed as a single hashable key: two findings match unless BOTH
    # carry a non-None column AND those columns differ. Insertion order is
    # preserved for determinism.
    survivors: List[NormalizedFinding] = []
    for finding in findings:
        matched_index = None
        for idx, existing in enumerate(survivors):
            if _primary_match(existing, finding):
                matched_index = idx
                break
        if matched_index is None:
            survivors.append(finding)
            continue
        winner, loser = _prefer_more_populated(survivors[matched_index], finding)
        survivors[matched_index] = winner
        _merge_into(merge_record, winner.id, loser.id)

    # ── SECONDARY: textual similarity (difflib, deterministic) ───────────
    handled: set = set()  # ids either merged away OR already finalized
    result: List[NormalizedFinding] = []
    for i, anchor in enumerate(survivors):
        if anchor.id in handled:
            continue
        current = anchor
        for j in range(i + 1, len(survivors)):
            candidate = survivors[j]
            if candidate.id in handled:
                continue
            if current.file != candidate.file:
                continue
            if abs(current.line - candidate.line) > SIMILARITY_LINE_WINDOW:
                continue
            # SECRETS SAFETY: a non-None column mismatch means distinct
            # positions -> never similarity-merge, regardless of how identical
            # the (static, per-rule) description text is. See module docstring.
            if _columns_conflict(current, candidate):
                continue
            ratio = SequenceMatcher(
                None, current.description or "", candidate.description or ""
            ).ratio()
            if ratio >= similarity_threshold:
                winner, loser = _prefer_higher_confidence(current, candidate)
                _merge_into(merge_record, winner.id, loser.id)
                handled.add(loser.id)
                current = winner
        handled.add(current.id)
        result.append(current)

    # Normalize merge_record: one entry per SURVIVING finding (empty if none
    # merged in), for clean coverage accounting downstream.
    final_merge = {f.id: merge_record.get(f.id, []) for f in result}
    return result, final_merge
