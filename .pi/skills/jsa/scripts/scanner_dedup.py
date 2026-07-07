"""Scanner-level finding deduplication for SAST findings."""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Rule ID normalization
# ---------------------------------------------------------------------------

RULE_ID_MAP: dict[str, str] = {
    "js/xss-through-dom": "dom_xss",
    "js/reflected-xss": "reflected_xss",
    "js/stored-xss": "stored_xss",
    "js/sql-injection": "sqli",
    "js/request-forgery": "ssrf",
    "js/path-injection": "open_redirect",
    "js/command-line-injection": "http_header_injection",
    "js/prototype-pollution": "prototype_pollution",
    "js/insecure-randomness": "secret_disclosure",
    "js/unsafe-jquery-plugin": "dom_xss",
    "js/code-injection": "csti",
}


def normalize_rule_id(rule_id: str) -> str:
    """Map a SAST rule ID to a normalized vuln class.

    Unknown rule IDs are returned unchanged (passthrough).
    """
    return RULE_ID_MAP.get(rule_id, rule_id)


# ---------------------------------------------------------------------------
# Helper predicates
# ---------------------------------------------------------------------------

def files_overlap(file_a: str, file_b: str) -> bool:
    """Check if two file paths refer to the same file.

    Compares basename to handle relative vs absolute path differences.
    """
    return os.path.basename(file_a) == os.path.basename(file_b)


def line_proximity(line_a: int, line_b: int, threshold: int = 10) -> bool:
    """Return True when the absolute line difference is within threshold."""
    return abs(int(line_a) - int(line_b)) <= threshold


# ---------------------------------------------------------------------------
# Match heuristics
# ---------------------------------------------------------------------------

def _get_fingerprint(finding: dict) -> str | None:
    return finding.get("fingerprint") or finding.get("extra", {}).get("fingerprint")


def _get_file(finding: dict) -> str:
    return finding.get("file") or finding.get("path") or ""


def _get_line(finding: dict) -> int:
    line = finding.get("line")
    if line is not None:
        return int(line)
    start = finding.get("line_start")
    if start is not None:
        return int(start)
    return 0


def _get_rule_id(finding: dict) -> str:
    return finding.get("rule_id") or finding.get("check_id") or ""


def _get_source(finding: dict) -> str:
    return finding.get("source", "")


def fingerprint_match(fa: dict, fb: dict) -> bool:
    """Fast O(1) pre-filter using fingerprint equality.

    Both findings must share the same non-empty fingerprint on the same file.
    """
    fp_a = _get_fingerprint(fa)
    fp_b = _get_fingerprint(fb)
    if not fp_a or not fp_b:
        return False
    if fp_a != fp_b:
        return False
    return files_overlap(_get_file(fa), _get_file(fb))


def findings_equivalent(fa: dict, fb: dict) -> bool:
    """Comprehensive equivalence check between two findings.

    1. Normalize rule IDs → compare vuln_class.
    2. Check files_overlap.
    3. Try fingerprint_match first (fast path), fall back to line_proximity.
    """
    vuln_a = normalize_rule_id(_get_rule_id(fa))
    vuln_b = normalize_rule_id(_get_rule_id(fb))
    if vuln_a != vuln_b:
        return False

    if not files_overlap(_get_file(fa), _get_file(fb)):
        return False

    if fingerprint_match(fa, fb):
        return True

    return line_proximity(_get_line(fa), _get_line(fb))


# ---------------------------------------------------------------------------
# Merge pipeline
# ---------------------------------------------------------------------------

def _detail_length(f: dict) -> int:
    """Heuristic for how much detail a finding carries."""
    msg = f.get("message", "") or f.get("description", "")
    snippet = f.get("code_snippet", "") or f.get("extra", {}).get("lines", "")
    return len(msg) + len(snippet)


def _dedup_by_fingerprint(findings: list[dict]) -> list[dict]:
    """Keep the most detailed finding when two findings share fingerprint+file."""
    seen: dict[tuple[str, str], dict] = {}
    for f in findings:
        fp = _get_fingerprint(f)
        fname = _get_file(f)
        if not fp:
            continue
        key = (fp, os.path.basename(fname))
        if key not in seen or _detail_length(f) > _detail_length(seen[key]):
            seen[key] = f
    # Re-assemble in original order, preferring the kept ones
    kept_fps: set[tuple[str, str]] = set()
    result: list[dict] = []
    for f in findings:
        fp = _get_fingerprint(f)
        if not fp:
            result.append(f)
            continue
        key = (fp, os.path.basename(_get_file(f)))
        if key in kept_fps:
            continue
        kept_fps.add(key)
        result.append(seen[key])
    return result


def merge_scanner_findings(sast_findings: list[dict]) -> list[dict]:
    """Deduplicate SAST findings.

    Steps:
    1. Pre-filter findings by fingerprint.
    2. Normalize all rule_ids.
    3. Group by (vuln_class, file basename).
    4. Within each group, cluster by line_proximity.
    5. For each cluster, keep the finding with the longest detail.
    6. Return deduplicated list.
    """
    # Step 1: fingerprint dedup within findings
    filtered = _dedup_by_fingerprint(sast_findings)

    # Step 2: normalize rule_ids in place (on copies to avoid mutating inputs)
    all_findings: list[dict] = []
    for f in filtered:
        nf = dict(f)
        rid = _get_rule_id(nf)
        if rid:
            nf["vuln_class"] = nf.get("vuln_class") or normalize_rule_id(rid)
        all_findings.append(nf)

    # Step 3: Group by (vuln_class, file basename)
    groups: dict[tuple[str, str], list[dict]] = {}
    for f in all_findings:
        vc = f.get("vuln_class", "")
        fname = os.path.basename(_get_file(f))
        key = (vc, fname)
        groups.setdefault(key, []).append(f)

    # Step 4+5: Cluster by line_proximity within each group
    merged: list[dict] = []
    for group in groups.values():
        # Simple greedy clustering by line_proximity
        clusters: list[list[dict]] = []
        for f in group:
            placed = False
            for cluster in clusters:
                if any(findings_equivalent(f, c) for c in cluster):
                    cluster.append(f)
                    placed = True
                    break
            if not placed:
                clusters.append([f])

        for cluster in clusters:
            # Pick the finding with the longest detail
            best = max(cluster, key=_detail_length)
            out = dict(best)
            merged.append(out)

    return merged


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def dedup_stats(input_sast: int, output: int) -> dict:
    """Return statistics for the deduplication pass."""
    dedup_rate = 1.0 - (output / input_sast) if input_sast > 0 else 0.0
    return {
        "input_sast": input_sast,
        "output": output,
        "dedup_rate": dedup_rate,
    }
