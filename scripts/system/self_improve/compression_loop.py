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


# Minimum occurrences of a reason to trigger a pattern
_PATTERN_THRESHOLD = 2


def identify_patterns(outcomes: List[Dict[str, Any]]) -> List[str]:
    """Extract recurring patterns from outcome records.

    Groups by normalized reason text across MISMATCH and PARTIAL outcomes.
    Returns pattern descriptions for items meeting threshold.
    """
    # Filter to suboptimal outcomes only
    relevant = [o for o in outcomes if o.get("outcome") in ("MISMATCH", "PARTIAL")]
    if not relevant:
        return []

    # Normalize reasons (lowercase, strip)
    reasons = [str(o.get("reason", "")).strip().lower() for o in relevant]
    reasons = [r for r in reasons if r]

    # Count occurrences
    counts = Counter(reasons)

    # Filter to recurring patterns
    patterns = [reason for reason, count in counts.items() if count >= _PATTERN_THRESHOLD]

    # Return human-readable pattern descriptions (capitalize first letter)
    return [p.capitalize() if p else "" for p in patterns if p]


def _deduplicate(new_amendments: List[Dict[str, Any]], previous: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Remove amendments whose trigger is already in previous proposals."""
    if not previous:
        return new_amendments

    existing_triggers = {a.get("trigger", "").strip().lower() for a in previous}
    return [a for a in new_amendments if a.get("trigger", "").strip().lower() not in existing_triggers]


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
        # Collect evidence for this pattern
        evidence = [
            f"{o.get('decision_id', 'unknown')} ({o.get('outcome')}): {o.get('reason', '')}"
            for o in outcomes
            if o.get("outcome") in ("MISMATCH", "PARTIAL") and pattern.lower() in str(o.get("reason", "")).lower()
        ]

        # Infer domain from outcomes
        domains = [o.get("domain", "") for o in outcomes if pattern.lower() in str(o.get("reason", "")).lower()]
        domain = Counter(d.lower() for d in domains if d).most_common(1)
        domain = domain[0][0] if domain else "general"

        # Classify target
        target = classify_target(pattern, evidence)

        # Determine target file
        if target == TargetLayer.DOMAIN_GUIDANCE:
            target_file = _map_domain_to_target_file(domain)
        elif target == TargetLayer.MEMPALACE_PREF:
            target_file = "penny/preferences"
        elif target == TargetLayer.CONFIG:
            target_file = ".env"
        else:
            target_file = "REJECTED_UNIVERSAL"

        # Generate amendment
        amendment = generate_amendment(
            learning=pattern,
            evidence=evidence[:5],  # cap evidence list
            target_layer=target.value,
            target_file=target_file,
            proposed_text=f"<!-- TODO: Generated amendment for '{pattern}' -->",
        )
        amendments.append(amendment)

    return _deduplicate(amendments, previous_amendments)
