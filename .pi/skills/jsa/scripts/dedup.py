"""
jsa Skill — Merge & Dedup Engine

Consolidates raw findings from chunk workers into deduplicated, 
confidence-promoted, ranked merged findings.

Architecture: plans/jsa-implementation/03-splitter-and-dedup-design.md Part B
"""

import uuid
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# 1.2.1 Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Finding:
    """Raw finding from a single worker on a single chunk."""
    finding_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    chunk_id: str = ""
    file: str = ""
    vuln_class: str = ""
    source: str = ""
    sink: str = ""
    line_start: int = 0
    line_end: int = 0
    confidence: str = "possible"      # "confirmed", "probable", "possible"
    description: str = ""
    code_snippet: str = ""
    data_flow: str = ""
    is_boundary: bool = False         # Finding in overlap region
    scanner: str = ""                 # "semgrep", "ast_trace", "grep", "jsluice"
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class MergedFinding:
    """Finding after deduplication with promoted confidence."""
    merged_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    vuln_class: str = ""
    file: str = ""
    source: str = ""
    sink: str = ""
    line_start: int = 0
    line_end: int = 0
    confidence: str = "possible"
    description: str = ""
    code_snippet: str = ""
    data_flow: str = ""
    source_chunks: list[str] = field(default_factory=list)
    source_finding_ids: list[str] = field(default_factory=list)
    duplicate_count: int = 1
    scanner_consensus: list[str] = field(default_factory=list)
    score: float = 0.0


@dataclass
class MergeResult:
    """Full merge pipeline output."""
    merged_findings: list[MergedFinding] = field(default_factory=list)
    total_raw: int = 0
    total_merged: int = 0
    duplication_rate: float = 0.0
    clusters_formed: int = 0
    cross_file_merges: int = 0


# ---------------------------------------------------------------------------
# 1.2.2 Pattern normalization
# ---------------------------------------------------------------------------

def normalize_pattern(pattern: str) -> str:
    """Normalize source/sink pattern for comparison."""
    p = pattern.strip().lower()
    for prefix in ["window.", "document.", "globalthis.", "global."]:
        if p.startswith(prefix):
            p = p[len(prefix):]
    return p


# ---------------------------------------------------------------------------
# 1.2.3 Category matching
# ---------------------------------------------------------------------------

_URL_SOURCES = {"location.search", "location.hash", "location.href", 
                "location.pathname", "location.host"}
_MESSAGE_SOURCES = {"postmessage", "messageevent.data", "event.data", "onmessage"}
_STORAGE_SOURCES = {"localstorage.getitem", "sessionstorage.getitem", "document.cookie"}

_DOM_SINKS = {"element.innerhtml", "element.outerhtml", "document.write", "document.writeln",
              "insertadjacenthtml", "innerhtml", "outerhtml"}
_EXEC_SINKS = {"eval()", "new function()", "settimeout(string)", "setinterval(string)",
               "script.text", "script.textcontent"}
_NAV_SINKS = {"location.href", "location.assign", "location.replace", "window.open",
              "anchor.href", "iframe.src", "form.action"}


def source_compatible(a: str, b: str) -> bool:
    """Check if two sources are in the same category."""
    a_norm = normalize_pattern(a)
    b_norm = normalize_pattern(b)
    for category in [_URL_SOURCES, _MESSAGE_SOURCES, _STORAGE_SOURCES]:
        if a_norm in category and b_norm in category:
            return True
    return False


def sink_compatible(a: str, b: str) -> bool:
    """Check if two sinks are in the same category."""
    a_norm = normalize_pattern(a)
    b_norm = normalize_pattern(b)
    for category in [_DOM_SINKS, _EXEC_SINKS, _NAV_SINKS]:
        if a_norm in category and b_norm in category:
            return True
    return False


# ---------------------------------------------------------------------------
# 1.2.4 Finding similarity
# ---------------------------------------------------------------------------

def _tokenize_code(snippet: str) -> set[str]:
    """Simple tokenization for Jaccard similarity."""
    import re
    return set(re.findall(r'[a-zA-Z_]\w+|\S', snippet.lower()))


def finding_similarity(a: Finding, b: Finding) -> float:
    """
    Weighted 5-component similarity between two findings.
    
    Components:
    - source_match (25%): Same or compatible source
    - sink_match (25%): Same or compatible sink
    - line_proximity (20%): How close in the file
    - code_overlap (15%): Jaccard similarity of tokens
    - description_similarity (15%): Word overlap in descriptions
    
    Returns 0.0 (different) to 1.0 (identical).
    """
    score = 0.0
    
    # 1. Source match
    if normalize_pattern(a.source) == normalize_pattern(b.source):
        score += 0.25
    elif source_compatible(a.source, b.source):
        score += 0.10
    
    # 2. Sink match
    if normalize_pattern(a.sink) == normalize_pattern(b.sink):
        score += 0.25
    elif sink_compatible(a.sink, b.sink):
        score += 0.10
    
    # 3. Line proximity (exponential decay)
    line_dist = abs(a.line_start - b.line_start)
    if line_dist == 0:
        score += 0.20
    elif line_dist <= 5:
        score += 0.15
    elif line_dist <= 20:
        score += 0.08
    elif line_dist <= 100:
        score += 0.03
    
    # 4. Code snippet overlap (Jaccard)
    a_tokens = _tokenize_code(a.code_snippet)
    b_tokens = _tokenize_code(b.code_snippet)
    if a_tokens and b_tokens:
        jaccard = len(a_tokens & b_tokens) / max(len(a_tokens | b_tokens), 1)
        score += jaccard * 0.15
    
    # 5. Description similarity (word Jaccard)
    a_words = set(a.description.lower().split())
    b_words = set(b.description.lower().split())
    if a_words and b_words:
        word_jaccard = len(a_words & b_words) / max(len(a_words | b_words), 1)
        score += word_jaccard * 0.15
    
    return score


# ---------------------------------------------------------------------------
# 1.2.5 Clustering
# ---------------------------------------------------------------------------

def cluster_findings(
    findings: list[Finding],
    threshold: float = 0.6,
) -> list[list[Finding]]:
    """
    Greedy agglomerative clustering.
    
    Sorts by confidence (anchors first), then greedily assigns 
    each finding to the cluster with highest average similarity.
    """
    if len(findings) <= 1:
        return [findings] if findings else []
    
    confidence_order = {"confirmed": 0, "probable": 1, "possible": 2}
    sorted_findings = sorted(findings, key=lambda f: confidence_order.get(f.confidence, 3))
    
    n = len(sorted_findings)
    
    # Compute similarity matrix
    sim_matrix: list[list[float]] = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            sim = finding_similarity(sorted_findings[i], sorted_findings[j])
            sim_matrix[i][j] = sim
            sim_matrix[j][i] = sim
    
    # Greedy clustering
    clusters: list[list[int]] = []
    
    for i in range(n):
        best_cluster = -1
        best_avg_sim = threshold
        
        for c_idx, cluster in enumerate(clusters):
            avg_sim = sum(sim_matrix[i][j] for j in cluster) / len(cluster)
            if avg_sim > best_avg_sim:
                best_avg_sim = avg_sim
                best_cluster = c_idx
        
        if best_cluster >= 0:
            clusters[best_cluster].append(i)
        else:
            clusters.append([i])
    
    return [[sorted_findings[i] for i in cluster] for cluster in clusters]


# ---------------------------------------------------------------------------
# 1.2.6 Merge cluster
# ---------------------------------------------------------------------------

def merge_cluster(cluster: list[Finding]) -> MergedFinding:
    """Merge a cluster of similar findings into one MergedFinding."""
    if len(cluster) == 1:
        f = cluster[0]
        return MergedFinding(
            vuln_class=f.vuln_class,
            file=f.file,
            source=f.source,
            sink=f.sink,
            line_start=f.line_start,
            line_end=f.line_end,
            confidence=f.confidence,
            description=f.description,
            code_snippet=f.code_snippet,
            data_flow=f.data_flow,
            source_chunks=[f.chunk_id],
            source_finding_ids=[f.finding_id],
            duplicate_count=1,
            scanner_consensus=[f.scanner] if f.scanner else [],
        )
    
    # Select best as base (highest confidence, then most detail)
    confidence_order = {"confirmed": 3, "probable": 2, "possible": 1}
    ranked = sorted(
        cluster,
        key=lambda f: (
            confidence_order.get(f.confidence, 0),
            len(f.description),
            len(f.data_flow),
        ),
        reverse=True,
    )
    best = ranked[0]
    
    line_start = min(f.line_start for f in cluster)
    line_end = max(f.line_end for f in cluster)
    widest = max(cluster, key=lambda f: f.line_end - f.line_start)
    
    # Merge unique data flows
    all_flows = list(dict.fromkeys(f.data_flow for f in cluster if f.data_flow))
    merged_flow = " | ".join(all_flows) if len(all_flows) > 1 else (all_flows[0] if all_flows else "")
    
    promoted = promote_confidence(cluster)
    scanners = list(dict.fromkeys(f.scanner for f in cluster if f.scanner))
    
    return MergedFinding(
        vuln_class=best.vuln_class,
        file=best.file,
        source=best.source,
        sink=best.sink,
        line_start=line_start,
        line_end=line_end,
        confidence=promoted,
        description=best.description,
        code_snippet=widest.code_snippet,
        data_flow=merged_flow,
        source_chunks=list(dict.fromkeys(f.chunk_id for f in cluster)),
        source_finding_ids=[f.finding_id for f in cluster],
        duplicate_count=len(cluster),
        scanner_consensus=scanners,
    )


# ---------------------------------------------------------------------------
# 1.2.7 Confidence promotion
# ---------------------------------------------------------------------------

def promote_confidence(cluster: list[Finding]) -> str:
    """
    Promote confidence when multiple independent workers agree.
    
    Rules:
    - 1 finding: keep original
    - 2+ findings from different chunks: possible → probable
    - 3+ findings from different chunks + 2+ scanners: → confirmed
    - All boundary-only (same chunk): no promotion
    """
    non_boundary = [f for f in cluster if not f.is_boundary]
    effective = non_boundary if non_boundary else cluster
    distinct_chunks = len(set(f.chunk_id for f in effective))
    distinct_scanners = len(set(f.scanner for f in effective if f.scanner))
    
    base = max(
        (f.confidence for f in cluster),
        key=lambda c: {"confirmed": 3, "probable": 2, "possible": 1}.get(c, 0),
    )
    
    if distinct_chunks < 2:
        return base
    
    if base == "possible":
        if len(effective) >= 3 and distinct_scanners >= 2:
            return "confirmed"
        elif len(effective) >= 2:
            return "probable"
    
    if base == "probable":
        if len(effective) >= 3 and distinct_scanners >= 2:
            return "confirmed"
    
    return base


# ---------------------------------------------------------------------------
# 1.2.8 Cross-file dedup
# ---------------------------------------------------------------------------

def cross_file_dedup(
    merged_findings: list[MergedFinding],
) -> list[MergedFinding]:
    """
    Deduplicate findings across different files.
    
    Uses pattern matching: same vuln_class + same source+sink in different files.
    Note: For full semantic dedup, use MemPalace search (called from FSM).
    This function does basic pattern-based cross-file dedup.
    """
    result: list[MergedFinding] = []
    seen_patterns: set[tuple[str, str, str]] = set()
    
    for f in merged_findings:
        key = (f.vuln_class, normalize_pattern(f.source), normalize_pattern(f.sink))
        
        if key in seen_patterns:
            # Merge into existing finding with same pattern
            for existing in result:
                ek = (existing.vuln_class, normalize_pattern(existing.source), normalize_pattern(existing.sink))
                if ek == key:
                    existing.source_chunks.extend(f.source_chunks)
                    existing.source_finding_ids.extend(f.source_finding_ids)
                    existing.duplicate_count += f.duplicate_count
                    if f.file not in existing.source_chunks:
                        existing.description += f"\n\nAlso found in: {f.file}"
                    break
        else:
            seen_patterns.add(key)
            result.append(f)
    
    return result


# ---------------------------------------------------------------------------
# 1.2.9 Scoring
# ---------------------------------------------------------------------------

_VULN_SEVERITY: dict[str, int] = {
    "dom_xss": 30, "reflected_xss": 30, "stored_xss": 30,
    "prototype_pollution": 28, "csti": 25, "sqli": 25,
    "ssrf": 22, "xxe": 20, "secret_disclosure": 20,
    "postmessage": 18, "dom_clobbering": 18,
    "open_redirect": 15, "request_override": 15,
    "http_header_injection": 15, "dom_data_manipulation": 12,
    "link_manipulation": 10, "csrf": 10, "cors": 10,
    "clickjacking": 8, "idor": 8, "http_smuggling": 8,
    "cache_poisoning": 8, "insecure_deserialization": 8,
}


def score_merged_finding(f: MergedFinding) -> float:
    """
    Score 0-100 for ranking.
    
    40% confidence + 30% severity + 15% pervasiveness + 15% scanner consensus
    """
    conf_score = {"confirmed": 40, "probable": 25, "possible": 10}.get(f.confidence, 5)
    severity = _VULN_SEVERITY.get(f.vuln_class, 10)
    dup_score = min(f.duplicate_count * 3, 15)
    scanner_score = min(len(f.scanner_consensus) * 5, 15)
    
    return conf_score + severity + dup_score + scanner_score


# ---------------------------------------------------------------------------
# 1.2.10 Full pipeline
# ---------------------------------------------------------------------------

def merge_and_dedup(
    raw_findings: list[Finding],
    merge_threshold: float = 0.6,
) -> MergeResult:
    """
    Full merge and dedup pipeline.
    
    1. Group by (file, vuln_class)
    2. Cluster + merge within each group
    3. Cross-file dedup
    4. Score and rank
    
    Args:
        raw_findings: All findings from all chunk workers
        merge_threshold: Similarity threshold for clustering (0.6 default)
    
    Returns:
        MergeResult with merged findings and statistics
    """
    total_raw = len(raw_findings)
    
    # Step 1: Group by (file, vuln_class)
    groups: dict[tuple[str, str], list[Finding]] = {}
    for f in raw_findings:
        key = (f.file, f.vuln_class)
        groups.setdefault(key, []).append(f)
    
    # Step 2-3: Cluster + merge within each group
    all_merged: list[MergedFinding] = []
    clusters_formed = 0
    
    for (file, vuln_class), group_findings in groups.items():
        clusters = cluster_findings(group_findings, merge_threshold)
        for cluster in clusters:
            if len(cluster) > 1:
                clusters_formed += 1
            merged = merge_cluster(cluster)
            all_merged.append(merged)
    
    # Step 4: Cross-file dedup
    before_cross = len(all_merged)
    all_merged = cross_file_dedup(all_merged)
    cross_file_merges = before_cross - len(all_merged)
    
    # Step 5: Score and rank
    for f in all_merged:
        f.score = score_merged_finding(f)
    all_merged.sort(key=lambda f: f.score, reverse=True)
    
    total_merged = len(all_merged)
    duplication_rate = 1.0 - (total_merged / total_raw) if total_raw > 0 else 0.0
    
    return MergeResult(
        merged_findings=all_merged,
        total_raw=total_raw,
        total_merged=total_merged,
        duplication_rate=duplication_rate,
        clusters_formed=clusters_formed,
        cross_file_merges=cross_file_merges,
    )
