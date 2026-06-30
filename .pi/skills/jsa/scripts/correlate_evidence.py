"""
jsa Skill — Cross-stream evidence correlation

Links normalized components, vulnerabilities, and code findings through
explicit correlation edges. Does NOT merge the underlying records — each
evidence type stays separate and is linked by typed edges with confidence
scores and evidence chains.

Why a separate module:
- Correlation is fundamentally different from deduplication. Dedup removes
  duplicates within a single stream. Correlation links records across streams.
- Edges are typed (component_affected_by_vuln, file_belongs_to_component,
  app_invokes_vulnerable_symbol, etc.) and have confidence scores, not
  binary matches. This is a different data model.
- This is the third of three split modules: components, vulnerabilities,
  code findings.

Hard gates (deterministic, applied before any scoring):
- Component version outside CVE affected range → no edge
- Component identity unknown → no edge (unless strong identifier)
- SAST finding in multi-component bundle with no source map → downgrade
- Only vuln_class matches (XSS == dom_xss) → never promote above weak

Positive signals (scored):
- Component purl/name/version exactly affected
- Script is loaded on in-scope page
- Source map maps finding to affected component
- Vulnerable function/symbol appears
- App code invokes vulnerable symbol (first-party)
- Tainted source reaches vulnerable symbol
- KEV / EPSS / CVSS high

Negative signals (scored):
- Version unknown
- File is vendor bundle without source map
- Vulnerable symbol only in library impl, not app callsite
- Shallow/non-vulnerable API mode detected

Agent review is reserved for ambiguous candidates (score 0.45-0.85 or
high-impact). All deterministic scoring happens here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Evidence packet for agent reviewer
# ---------------------------------------------------------------------------

# Valid edge types
EDGE_COMPONENT_AFFECTED = "component_affected_by_vuln"          # Component → Vulnerability
EDGE_FILE_BELONGS = "file_belongs_to_component"                  # File → Component
EDGE_SCRIPT_LOADED = "script_loaded_on_page"                      # File → Page
EDGE_SAST_IN_COMPONENT = "sast_in_component_source"               # CodeFinding → Component
EDGE_APP_INVOKES = "app_invokes_vulnerable_symbol"                # CodeFinding → Vulnerability
EDGE_TAINTED_REACHES = "tainted_input_reaches_vulnerable_symbol"  # CodeFinding → Vulnerability
EDGE_DYNAMIC_CONFIRMS = "dynamic_probe_confirms"                 # Probe → Component/Vulnerability
EDGE_AGENT_ASSESSED = "agent_assessed"                             # Agent → Edge


@dataclass
class CorrelationEdge:
    """An explicit link between two evidence records across streams.

    Edges have a typed edge_type (not a generic relation), a confidence level
    (not a binary match), and a list of evidence supporting the link. This
    structure is preserved through downstream analysis.
    """
    edge_id: str = ""                       # unique identifier
    edge_type: str = ""                     # one of EDGE_* constants
    from_id: str = ""                       # source record ID
    to_id: str = ""                         # target record ID
    confidence: str = "possible"            # "certain" | "probable" | "possible" | "unlikely"
    score: float = 0.0                      # 0.0-1.0 deterministic score
    evidence: list[dict] = field(default_factory=list)
    hard_negative: bool = False             # set if a hard gate was triggered
    reason: str = ""                       # human-readable explanation


# ---------------------------------------------------------------------------
# Hard gates
# ---------------------------------------------------------------------------

def _hard_gate_component_version(
    component_version: Optional[str],
    vuln_id: str,
) -> Optional[str]:
    """Apply hard gate: component version must be known for CVE correlation.

    Returns None if the edge should be created, or a string explaining why
    it should not (this becomes the hard_negative reason).
    """
    if not component_version:
        return f"No version for component; cannot correlate to {vuln_id}"
    return None


def _hard_gate_bundle_without_source_map(
    file_classification: str,
    source_map_present: bool,
) -> Optional[str]:
    """Apply hard gate: multi-component bundles without source maps.

    File classifications: 'single_component', 'multi_component_bundle',
    'first_party', 'inline', 'cdn_bundle', 'unknown'.

    If the file is a multi_component_bundle with no source map, downgrade
    file-level correlation. The edge can still be created but with reduced
    confidence.
    """
    if file_classification == "multi_component_bundle" and not source_map_present:
        return "Multi-component bundle without source map; correlation downgraded"
    return None


def _hard_gate_vuln_class_only(
    code_vuln_class: str,
    vuln_summary: str,
) -> bool:
    """Apply hard gate: only vulnerability class matches (XSS == dom_xss).

    Returns True if the gate fires (i.e., only vuln_class matches with no
    other evidence). This is a weak correlation that should never be
    promoted above 'possible'.
    """
    if not code_vuln_class or not vuln_summary:
        return False
    code_class_lower = code_vuln_class.lower()
    summary_lower = vuln_summary.lower()
    # If the code class is in the summary but no specific API or symbol is mentioned
    if code_class_lower in summary_lower:
        # Check for specific API/symbol mentions
        if any(api in summary_lower for api in ["extend", "merge", "html", "prefilter", "parse"]):
            return False  # has specific evidence
        return True  # only generic class match
    return False


# ---------------------------------------------------------------------------
# Positive signals
# ---------------------------------------------------------------------------

def _score_component_purl_match(
    component_purl: str,
    vuln_affected_packages: list[str],
) -> float:
    """Score: +0.40 if component purl matches affected package exactly.

    Args:
        component_purl: e.g., "pkg:npm/jquery@1.9.0"
        vuln_affected_packages: list of affected package purls
    """
    if not component_purl or not vuln_affected_packages:
        return 0.0
    if component_purl in vuln_affected_packages:
        return 0.40
    # Substring match (e.g., jquery matches pkg:npm/jquery@1.9.0)
    if any(component_purl in p or p in component_purl for p in vuln_affected_packages):
        return 0.20
    return 0.0


def _score_loaded_on_page(
    component_loaded_on_pages: list[str],
    in_scope_pages: list[str],
) -> float:
    """Score: +0.15 if component is loaded on an in-scope page."""
    if not component_loaded_on_pages or not in_scope_pages:
        return 0.0
    if any(p in in_scope_pages for p in component_loaded_on_pages):
        return 0.15
    return 0.0


def _score_source_map_mapping(
    source_map_present: bool,
    finding_in_component_source: bool,
) -> float:
    """Score: +0.25 if source map maps finding to affected component."""
    if source_map_present and finding_in_component_source:
        return 0.25
    return 0.0


def _score_vulnerable_symbol_appears(
    finding_symbols: list[str],
    vuln_vulnerable_symbols: list[str],
) -> float:
    """Score: +0.20 if vulnerable function/symbol appears in finding."""
    if not finding_symbols or not vuln_vulnerable_symbols:
        return 0.0
    if any(s in vuln_vulnerable_symbols for s in finding_symbols):
        return 0.20
    return 0.0


def _score_app_invokes_vulnerable_symbol(
    finding_in_first_party: bool,
    finding_symbols: list[str],
    vuln_vulnerable_symbols: list[str],
) -> float:
    """Score: +0.30 if first-party code invokes vulnerable symbol."""
    if not finding_in_first_party:
        return 0.0
    if not finding_symbols or not vuln_vulnerable_symbols:
        return 0.0
    if any(s in vuln_vulnerable_symbols for s in finding_symbols):
        return 0.30
    return 0.0


def _score_tainted_reaches_symbol(
    tainted_source: bool,
    vulnerable_symbol_appears: bool,
) -> float:
    """Score: +0.25 if tainted source reaches vulnerable symbol."""
    if tainted_source and vulnerable_symbol_appears:
        return 0.25
    return 0.0


def _score_kev(epss: Optional[float], kev: bool, cvss: Optional[float]) -> float:
    """Score priority enrichment: KEV, EPSS, CVSS."""
    score = 0.0
    if kev:
        score += 0.20
    if epss is not None and epss >= 0.5:
        score += 0.15
    if cvss is not None and cvss >= 7.0:
        score += 0.10
    return min(score, 0.30)  # cap at 0.30 total


# ---------------------------------------------------------------------------
# Negative signals
# ---------------------------------------------------------------------------

def _penalty_unknown_version(component_version: Optional[str]) -> float:
    return 0.0 if component_version else 0.20


def _penalty_version_from_filename_only(detection_evidence: list[dict]) -> float:
    # If only the filename-based detector provided the version (no source map,
    # no content, no runtime probe), apply a penalty
    if not detection_evidence:
        return 0.0
    sources = {e.get("source") for e in detection_evidence if e.get("has_version")}
    if sources == {"wappalyzer"}:
        return 0.10
    return 0.0


def _penalty_vendor_bundle_no_source_map(
    file_classification: str,
    source_map_present: bool,
) -> float:
    if file_classification == "multi_component_bundle" and not source_map_present:
        return 0.15
    return 0.0


def _penalty_vuln_symbol_only_in_library(
    finding_in_first_party: bool,
    symbol_appears: bool,
) -> float:
    if symbol_appears and not finding_in_first_party:
        return 0.20
    return 0.0


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def correlate_component_vuln(
    component: dict,
    vulnerability: dict,
    in_scope_pages: Optional[list[str]] = None,
) -> CorrelationEdge:
    """
    Build a correlation edge between a Component and a Vulnerability.

    Applies hard gates first, then accumulates positive and negative signals
    into a 0.0-1.0 score. Returns a CorrelationEdge (not a merge — the
    component and vulnerability records stay separate).

    Args:
        component: dict with at least:
            purl, version, loaded_on_pages, detection_evidence
        vulnerability: dict with at least:
            canonical_id, affected_packages (list of purls)
        in_scope_pages: list of pages that are in scope for testing

    Returns:
        CorrelationEdge with edge_type=EDGE_COMPONENT_AFFECTED.
    """
    from_id = component.get("purl", "")
    to_id = vulnerability.get("canonical_id", "")
    edge_id = f"edge:{from_id}->{to_id}"

    # Hard gate: version must be known
    hard_neg = _hard_gate_component_version(component.get("version"), to_id)
    if hard_neg:
        return CorrelationEdge(
            edge_id=edge_id,
            edge_type=EDGE_COMPONENT_AFFECTED,
            from_id=from_id,
            to_id=to_id,
            confidence="unlikely",
            score=0.0,
            hard_negative=True,
            reason=hard_neg,
        )

    # Accumulate positive signals
    score = 0.0
    score += _score_component_purl_match(
        component.get("purl", ""),
        vulnerability.get("affected_packages", []),
    )
    score += _score_loaded_on_page(
        component.get("loaded_on_pages", []),
        in_scope_pages or [],
    )
    score += _score_kev(
        vulnerability.get("epss"),
        vulnerability.get("kev", False),
        vulnerability.get("cvss"),
    )

    # Accumulate negative signals
    score -= _penalty_unknown_version(component.get("version"))
    score -= _penalty_version_from_filename_only(
        component.get("detection_evidence", [])
    )

    # Clamp to [0.0, 1.0]
    score = max(0.0, min(1.0, score))

    # Determine confidence
    if score >= 0.70:
        confidence = "certain"
    elif score >= 0.45:
        confidence = "probable"
    elif score >= 0.20:
        confidence = "possible"
    else:
        confidence = "unlikely"

    return CorrelationEdge(
        edge_id=edge_id,
        edge_type=EDGE_COMPONENT_AFFECTED,
        from_id=from_id,
        to_id=to_id,
        confidence=confidence,
        score=score,
        evidence=[
            {
                "type": "purl_match",
                "purl": component.get("purl", ""),
                "vuln_affected_packages": vulnerability.get("affected_packages", []),
            },
            {
                "type": "loaded_on_pages",
                "pages": component.get("loaded_on_pages", []),
                "in_scope": in_scope_pages or [],
            },
        ],
        hard_negative=False,
        reason=f"Score {score:.2f} → {confidence}",
    )


def correlate_sast_to_vuln(
    code_finding: dict,
    vulnerability: dict,
    file_classification: str = "single_component",
    source_map_present: bool = True,
) -> CorrelationEdge:
    """
    Build a correlation edge between a CodeFinding and a Vulnerability.

    Args:
        code_finding: dict with at least:
            finding_id, file, vuln_class, symbols, source_kind, sink_kind
        vulnerability: dict with at least:
            canonical_id, vulnerable_symbols, summary
        file_classification: classification of the JS file
        source_map_present: whether source map is available

    Returns:
        CorrelationEdge with edge_type=EDGE_APP_INVOKES or EDGE_SAST_IN_COMPONENT.
    """
    from_id = code_finding.get("finding_id", code_finding.get("file", ""))
    to_id = vulnerability.get("canonical_id", "")
    edge_id = f"edge:{from_id}->{to_id}"

    # Hard gate: multi-component bundle without source map downgrades
    hard_neg = _hard_gate_bundle_without_source_map(file_classification, source_map_present)

    # Hard gate: only vuln_class matches
    only_class_match = _hard_gate_vuln_class_only(
        code_finding.get("vuln_class", ""),
        vulnerability.get("summary", ""),
    )

    # Determine if first-party
    is_first_party = file_classification == "first_party"

    # Score
    score = 0.0
    vuln_symbols = vulnerability.get("vulnerable_symbols", [])
    finding_symbols = code_finding.get("symbols", [])

    symbol_appears = bool(
        finding_symbols and vuln_symbols and
        any(s in vuln_symbols for s in finding_symbols)
    )

    score += _score_vulnerable_symbol_appears(finding_symbols, vuln_symbols)
    if is_first_party:
        score += _score_app_invokes_vulnerable_symbol(
            is_first_party, finding_symbols, vuln_symbols
        )
    if code_finding.get("taint_flow"):
        score += _score_tainted_reaches_symbol(
            tainted_source=True,
            vulnerable_symbol_appears=symbol_appears,
        )

    # Penalties
    score -= _penalty_vuln_symbol_only_in_library(is_first_party, symbol_appears)
    score -= _penalty_vendor_bundle_no_source_map(file_classification, source_map_present)

    # Clamp
    score = max(0.0, min(1.0, score))

    # Determine edge type and confidence
    if is_first_party and symbol_appears:
        edge_type = EDGE_APP_INVOKES
    else:
        edge_type = EDGE_SAST_IN_COMPONENT

    if only_class_match:
        # Gate: never promote above weak correlation
        confidence = "possible"
    elif score >= 0.50:
        confidence = "probable"
    elif score >= 0.25:
        confidence = "possible"
    else:
        confidence = "unlikely"

    return CorrelationEdge(
        edge_id=edge_id,
        edge_type=edge_type,
        from_id=from_id,
        to_id=to_id,
        confidence=confidence,
        score=score,
        evidence=[
            {
                "type": "symbol_match",
                "finding_symbols": finding_symbols,
                "vuln_symbols": vuln_symbols,
            },
            {
                "type": "file_classification",
                "classification": file_classification,
                "source_map_present": source_map_present,
            },
        ],
        hard_negative=hard_neg is not None,
        reason=hard_neg or (f"Only class match" if only_class_match else f"Score {score:.2f} → {confidence}"),
    )


# ---------------------------------------------------------------------------
# Agent candidate selection
# ---------------------------------------------------------------------------

def select_agent_candidates(
    edges: list[CorrelationEdge],
    high_impact_confidence: str = "possible",
) -> list[CorrelationEdge]:
    """
    Select edges that need agent review.

    Returns edges with score in the ambiguous range (0.45-0.85) or that
    are high-impact but not certain. Hard-negative edges are excluded.

    Args:
        edges: list of CorrelationEdge to filter
        high_impact_confidence: only include edges at this confidence or
            above that aren't certain. Default: "possible".

    Returns:
        Filtered list of edges to send to agent.
    """
    candidates = []
    confidence_order = {"certain": 0, "probable": 1, "possible": 2, "unlikely": 3}
    threshold = confidence_order.get(high_impact_confidence, 2)

    for edge in edges:
        if edge.hard_negative:
            continue
        # Ambiguous range: 0.45-0.85
        if 0.45 <= edge.score <= 0.85:
            candidates.append(edge)
        # High-impact but not certain
        elif edge.confidence != "certain" and confidence_order.get(edge.confidence, 99) <= threshold:
            # And not "unlikely" — that would be excluded
            if edge.confidence != "unlikely":
                candidates.append(edge)

    return candidates


def edges_to_dicts(edges: list[CorrelationEdge]) -> list[dict]:
    """Serialize edges to dicts for state metadata storage."""
    return [
        {
            "edge_id": e.edge_id,
            "edge_type": e.edge_type,
            "from_id": e.from_id,
            "to_id": e.to_id,
            "confidence": e.confidence,
            "score": e.score,
            "evidence": e.evidence,
            "hard_negative": e.hard_negative,
            "reason": e.reason,
        }
        for e in edges
    ]


# ---------------------------------------------------------------------------
# Agent Review — Building bounded evidence packets
# ---------------------------------------------------------------------------

@dataclass
class EvidencePacket:
    """Bounded evidence packet for agent reviewer.

    Contains just-enough structured context for an agent to judge an ambiguous
    correlation edge, WITHOUT exposing raw application code. Each packet bundles:
    - The correlation edge (deterministic score + evidence chain)
    - Component context (purl, version, classification)
    - Vulnerability context (canonical_id, CVSS, vulnerable_symbols)
    - SAST finding context (file, rule, symbols, taint_flow)

    The agent reviewer produces a verdict:
    - exploitable: strong evidence the vulnerability is reachable + exploitable
    - not_exploitable: clear mitigations or unreachable code path
    - needs_deeper: ambiguous — requires targeted vuln-class specialist
    - confidence_override: agent's judgment of the final confidence level
    - notes: free-text reasoning for the verdict
    """
    packet_id: str
    edge: CorrelationEdge
    component: dict
    vulnerability: dict
    sast_findings: list[dict]

    def to_dict(self) -> dict:
        """Serialize packet for transport to agent."""
        return {
            "packet_id": self.packet_id,
            "edge": self.edge.__dict__,
            "component": self.component,
            "vulnerability": self.vulnerability,
            "sast_findings": self.sast_findings,
        }


def build_evidence_packets(
    edges: list[dict],
    agent_candidate_ids: list[str],
    components: list[dict],
    vulnerabilities: list[dict],
    sast_findings: list[dict],
) -> list[EvidencePacket]:
    """Build bounded evidence packets for ambiguous edges needing agent review.

    Packages all relevant structured evidence for each candidate edge into a
    self-contained packet. Agent receives ONLY this packet — no raw code, no
    full file content.

    Args:
        edges: list of CorrelationEdge dicts (from state.metadata["dedup"]["edges"])
        agent_candidate_ids: list of edge IDs selected by select_agent_candidates()
        components: normalized component dicts from NORMALIZE phase
        vulnerabilities: canonicalized vulnerability dicts from NORMALIZE phase
        sast_findings: deduped SAST findings from DEDUP_WITHIN_SOURCE phase

    Returns:
        List of EvidencePacket objects, one per candidate edge.
    """
    # Build lookups by ID
    edges_by_id: dict[str, dict] = {e.get("edge_id"): e for e in edges}
    comps_by_purl: dict[str, dict] = {c.get("purl"): c for c in components}
    vulns_by_id: dict[str, dict] = {v.get("canonical_id"): v for v in vulnerabilities}
    findings_by_file: dict[str, list[dict]] = {}
    for f in sast_findings:
        findings_by_file.setdefault(f.get("file", ""), []).append(f)

    packets: list[EvidencePacket] = []

    for cid in agent_candidate_ids:
        edge_data = edges_by_id.get(cid)
        if not edge_data:
            continue

        # Parse from_id and to_id to find linked records
        from_id = edge_data.get("from_id", "")
        to_id = edge_data.get("to_id", "")
        edge_type = edge_data.get("edge_type", "")

        # Reconstruct the CorrelationEdge object
        edge = CorrelationEdge(
            edge_id=edge_data.get("edge_id", cid),
            edge_type=edge_type,
            from_id=from_id,
            to_id=to_id,
            confidence=edge_data.get("confidence", "possible"),
            score=edge_data.get("score", 0.0),
            evidence=edge_data.get("evidence", []),
            hard_negative=edge_data.get("hard_negative", False),
            reason=edge_data.get("reason", ""),
        )

        # Find the component (by purl match on from_id for component edges,
        # or by file match on SAST edges)
        component: dict = {}
        for c in components:
            if c.get("purl", "") == from_id:
                component = c
                break

        # If no direct purl match, try matching from_id to a file in component files
        if not component:
            for c in components:
                if from_id in c.get("files", []):
                    component = c
                    break

        # Find the vulnerability (by canonical_id match on to_id)
        vulnerability: dict = {}
        if to_id in vulns_by_id:
            vulnerability = vulns_by_id[to_id]

        # Find related SAST findings (by file)
        related_findings: list[dict] = []
        # from_id may be a file path for SAST findings
        if from_id in findings_by_file:
            related_findings.extend(findings_by_file[from_id])

        # Also try to match from_id as a filename suffix
        for file_path, file_findings in findings_by_file.items():
            if from_id and from_id in file_path:
                related_findings.extend(file_findings)

        # Deduplicate findings
        seen = set()
        unique_findings = []
        for f in related_findings:
            key = (f.get("rule_id", ""), f.get("file", ""), f.get("line", ""))
            if key not in seen:
                seen.add(key)
                unique_findings.append(f)

        packets.append(
            EvidencePacket(
                packet_id=cid,
                edge=edge,
                component=component,
                vulnerability=vulnerability,
                sast_findings=unique_findings,
            )
        )

    return packets


def packets_to_dicts(packets: list[EvidencePacket]) -> list[dict]:
    """Serialize evidence packets to dicts for state metadata."""
    return [p.to_dict() for p in packets]


def evidence_packet_to_dict(packet: EvidencePacket) -> dict:
    """Serialize a single evidence packet to dict."""
    return packet.to_dict()
