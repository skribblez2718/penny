"""Main self-improvement compression loop.

Orchestrates:
  1. Pattern detection from MISMATCH/PARTIAL outcomes
  2. Target classification (via target_classifier)
  3. Amendment generation (via amendment_generator)
  4. Deduplication against previously proposed amendments

Returns a list of amendment dicts ready for mempalace storage.
"""

from collections import Counter
from typing import List, Dict, Any, Optional

from target_classifier import classify_target, TargetLayer
from amendment_generator import generate_amendment

# Minimum occurrences of a grouping key to trigger a pattern
_PATTERN_THRESHOLD = 2

# Human-readable phrase per categorical failure mode — used for the amendment's
# guidance heading and target classification (which run on natural language, not
# the enum token). Unknown keys (reason-based, from older records) pass through
# unchanged. Mirrors capture.FAILURE_MODES.
_FAILURE_MODE_PHRASE = {
    "misread_request": "misread what the user actually asked for",
    "incomplete": "left part of the stated goal unmet",
    "wrong_result": "produced an incorrect result",
    "unverified_claim": "asserted something without grounding or evidence",
    "missing_constraint": "ignored a stated constraint or requirement",
    "wrong_intermediate": "relied on a wrong intermediate inference",
    "scope_creep": "did more or different work than was asked",
    "refused_wrongly": "declined a valid, in-scope request",
}


def _grouping_key(outcome: Dict[str, Any]) -> str:
    """The key the compression loop clusters on.

    Prefer the categorical ``failure_mode`` — free-text ``reason`` rarely
    repeats verbatim (judge/human WHY sentences almost never match), so
    reason-only clustering never fires; the enum recurs reliably. "other" and
    empty are NOT clustering keys (they'd over-group unrelated failures), so
    they fall back to the normalized reason — which preserves the old behavior
    for records written before failure_mode existed.
    """
    fm = str(outcome.get("failure_mode", "")).strip().lower()
    if fm and fm != "other":
        return fm
    return str(outcome.get("reason", "")).strip().lower()


def _describe(pattern: str) -> str:
    """Natural-language rendering of a grouping key for classification/guidance.
    A failure-mode enum becomes its phrase; a reason string passes through."""
    return _FAILURE_MODE_PHRASE.get(pattern, pattern)


def identify_patterns(outcomes: List[Dict[str, Any]]) -> List[str]:
    """Extract recurring patterns from outcome records.

    Groups MISMATCH/PARTIAL outcomes by their grouping key (categorical
    failure_mode, else normalized reason) and returns the keys meeting the
    recurrence threshold.
    """
    relevant = [o for o in outcomes if o.get("outcome") in ("MISMATCH", "PARTIAL")]
    if not relevant:
        return []

    keys = [_grouping_key(o) for o in relevant]
    keys = [k for k in keys if k]

    counts = Counter(keys)
    return [key for key, count in counts.items() if count >= _PATTERN_THRESHOLD]


def _deduplicate(
    new_amendments: List[Dict[str, Any]], previous: Optional[List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """Remove amendments whose trigger is already in previous proposals."""
    if not previous:
        return new_amendments

    existing_triggers = {a.get("trigger", "").strip().lower() for a in previous}
    return [
        a for a in new_amendments if a.get("trigger", "").strip().lower() not in existing_triggers
    ]


def _one_line(text: str, cap: int = 160) -> str:
    return " ".join(str(text).split())[:cap]


def build_guidance_text(pattern: str, evidence: List[str], occurrences: int) -> str:
    """Render an appendable '### Learned:' block from a recurring failure.

    This is the real proposed text (replacing the old TODO placeholder that
    made every generated amendment a no-op). Leading blank lines make a raw
    EOF append (the applier's ADD action inserts no separator) heading-safe in
    the frontmatter-free prompt markdown. Kept compact so the amendment drawer
    stays well under the bridge's 4,000-char chunking threshold — chunked
    drawers break every JSON reader of penny/system_amendments.
    """
    lines = [
        "",
        "",
        f"### Learned: {_one_line(pattern, 120)}",
        "",
        f"This failure recurred {occurrences}x in recent outcomes:",
    ]
    for ev in evidence[:3]:
        lines.append(f"- {_one_line(ev)}")
    lines.extend(
        [
            "",
            "Before finalizing work in this area, explicitly check for this failure "
            f"mode and address it up front: {_one_line(pattern, 120)}.",
        ]
    )
    return "\n".join(lines) + "\n"


def _map_domain_to_target_file(domain: str) -> str:
    """Map a domain name to the most likely Domain Guidance file.

    This is a heuristic — in production, the classification logic would
    be more sophisticated or use domain-specific metadata.
    """
    _DOMAIN_FILE_MAP = {
        "coding": ".pi/skills/plan/assets/prompts/piper.md",
        "planning": ".pi/skills/plan/assets/prompts/piper.md",
        "exploration": ".pi/skills/plan/assets/prompts/echo.md",
        "critique": ".pi/skills/plan/assets/prompts/carren.md",
        "testing": ".pi/skills/plan/assets/prompts/carren.md",
        "taskify": ".pi/skills/plan/assets/prompts/tabitha.md",
    }
    return _DOMAIN_FILE_MAP.get(domain.lower(), ".pi/skills/plan/assets/prompts/piper.md")


def run_compression_loop(
    outcomes: List[Dict[str, Any]],
    previous_amendments: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Run the full compression loop on a set of outcomes.

    Returns a list of proposed amendment dicts.
    """
    patterns = identify_patterns(outcomes)
    if not patterns:
        return []

    amendments = []
    for pattern in patterns:
        # The records that share this grouping key (exact match on the key, not a
        # substring-in-reason scan — the key may be a categorical failure_mode
        # that never appears literally in the free-text reason).
        matched = [
            o
            for o in outcomes
            if o.get("outcome") in ("MISMATCH", "PARTIAL") and _grouping_key(o) == pattern
        ]

        # Evidence keeps the human-readable reasons so the amendment cites the
        # concrete instances behind the categorical pattern.
        evidence = [
            f"{o.get('decision_id', 'unknown')} ({o.get('outcome')}): {o.get('reason', '')}"
            for o in matched
        ]

        # Fallback must be a value the outcome writer actually emits
        # ("other", not "general") — otherwise the efficacy eval filters this
        # amendment against a permanently empty outcome pool and its impact
        # is never measured.
        domain = Counter(str(o.get("domain", "")).lower() for o in matched if o.get("domain"))
        domain = domain.most_common(1)
        domain = domain[0][0] if domain else "other"

        # Classification and guidance run on natural language — a failure-mode
        # enum is rendered to its phrase; a reason string passes through.
        learning = _describe(pattern)
        target = classify_target(learning, evidence)

        # Determine target file
        if target == TargetLayer.DOMAIN_GUIDANCE:
            target_file = _map_domain_to_target_file(domain)
        elif target == TargetLayer.MEMPALACE_PREF:
            target_file = "penny/preferences"
        elif target == TargetLayer.CONFIG:
            target_file = ".env"
        else:
            target_file = "REJECTED_UNIVERSAL"

        # Generate amendment with real, applicable guidance text
        amendment = generate_amendment(
            learning=learning,
            evidence=evidence[:5],  # cap evidence list
            target_layer=target.value,
            target_file=target_file,
            proposed_text=build_guidance_text(learning, evidence, len(matched)),
            domain=domain,
        )
        amendments.append(amendment)

    return _deduplicate(amendments, previous_amendments)
