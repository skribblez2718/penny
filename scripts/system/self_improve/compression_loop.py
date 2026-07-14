"""Main self-improvement compression loop.

Orchestrates:
  1. Pattern detection from MISMATCH/PARTIAL outcomes
  2. Target classification (via target_classifier)
  3. Amendment generation (via amendment_generator)
  4. Deduplication against previously proposed amendments

Returns a list of amendment dicts ready for mempalace storage.
"""

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import List, Dict, Any, Optional

from target_classifier import classify_target, TargetLayer
from amendment_generator import generate_amendment, draft_change

REPO_ROOT = Path(__file__).resolve().parents[3]

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


# ── #20: semantic failure clustering (model-first, exact-string fallback) ─────
# The exact-string grouping above clusters only identical failure_mode tokens; the
# information-rich free-text `reason` never matches verbatim, so it goes unused.
# When PI_SELFIMPROVE_CLUSTER_MODEL is set, a model groups the recent failures by
# ROOT CAUSE (meaning) — unlocking the reason text and the #19 open-vocab tags.
# Unset (default) or ANY failure -> the exact-string path below (never raises).
_CLUSTER_MODEL_ENV = "PI_SELFIMPROVE_CLUSTER_MODEL"
_CLUSTER_SYSTEM = (
    "You group software-assistant FAILURE records by ROOT CAUSE (semantic meaning), "
    "not by exact wording: two records share a cluster iff fixing the same underlying "
    "problem would address both. Reply with EXACTLY one JSON object and nothing else: "
    '{"clusters": [{"label": "<short snake_case tag>", "members": [<record indices>]}]}. '
    "Each index appears in at most one cluster; a record matching nothing forms its "
    "own single-member cluster."
)


def _tag(text: str, cap: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).strip().lower()).strip("_")[:cap]


def _load_pi_json_call():
    """Lazy-import the shared headless-pi caller (scripts/system/lib, #8)."""
    lib = str(REPO_ROOT / "scripts" / "system" / "lib")
    if lib not in sys.path:
        sys.path.insert(0, lib)
    from detect import pi_json_call  # type: ignore[import-not-found]
    return pi_json_call


def _cluster_via_model(relevant, spec, *, runner=None):
    """Ask the model to group `relevant` failures; return [{label, members:[idx]}]
    or None on any failure (-> caller falls back to exact-string grouping)."""
    lines = []
    for i, o in enumerate(relevant):
        reason = _one_line(o.get("reason", ""))
        fm = str(o.get("failure_mode", "")).strip()
        lines.append(f"[{i}] {reason}" + (f"  (tag: {fm})" if fm else ""))
    prompt = ("FAILURE RECORDS:\n" + "\n".join(lines)
              + '\n\nReturn {"clusters":[...]} grouping them by root cause.')
    text = _load_pi_json_call()(prompt, model_spec=spec, system=_CLUSTER_SYSTEM,
                                runner=runner, timeout_s=60, cwd=str(REPO_ROOT))
    if not text:
        return None
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("clusters"), list):
        return None
    n = len(relevant)
    out, seen = [], set()
    for c in obj["clusters"]:
        if not isinstance(c, dict):
            continue
        members = [m for m in c.get("members", [])
                   if isinstance(m, int) and 0 <= m < n and m not in seen]
        if not members:
            continue
        seen.update(members)
        out.append({"label": _tag(c.get("label", "")) or "cluster", "members": members})
    return out or None


def cluster_outcomes(relevant, *, runner=None):
    """Group MISMATCH/PARTIAL failures into clusters ``{label, members:[outcome]}``
    meeting the recurrence threshold. Semantic (model) when
    PI_SELFIMPROVE_CLUSTER_MODEL is set; otherwise exact-string grouping on the
    categorical failure_mode/reason (the pre-#20 behavior). Never raises."""
    if not relevant:
        return []
    spec = os.environ.get(_CLUSTER_MODEL_ENV, "").strip()
    if spec:
        try:
            groups = _cluster_via_model(relevant, spec, runner=runner)
        except Exception:  # noqa: BLE001 - clustering must never break the loop
            groups = None
        if groups is not None:
            clusters = [
                {"label": g["label"], "members": [relevant[i] for i in g["members"]]}
                for g in groups
            ]
            return [c for c in clusters if len(c["members"]) >= _PATTERN_THRESHOLD]
    # Fallback: exact-string grouping (equivalent to identify_patterns + matched).
    by_key: Dict[str, List[Dict[str, Any]]] = {}
    for o in relevant:
        key = _grouping_key(o)
        if key:
            by_key.setdefault(key, []).append(o)
    return [
        {"label": key, "members": members}
        for key, members in by_key.items()
        if len(members) >= _PATTERN_THRESHOLD
    ]


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
    *,
    runner=None,
) -> List[Dict[str, Any]]:
    """Run the full compression loop on a set of outcomes.

    Failures are grouped by ``cluster_outcomes`` — semantic (model) when
    PI_SELFIMPROVE_CLUSTER_MODEL is set, else exact-string on the categorical
    failure_mode/reason. Returns a list of proposed amendment dicts.
    """
    relevant = [o for o in outcomes if o.get("outcome") in ("MISMATCH", "PARTIAL")]
    clusters = cluster_outcomes(relevant, runner=runner)
    if not clusters:
        return []

    amendments = []
    for cluster in clusters:
        matched = cluster["members"]
        label = cluster["label"]

        # Evidence keeps the human-readable reasons so the amendment cites the
        # concrete instances behind the cluster.
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
        # enum is rendered to its phrase; a cluster label / reason passes through.
        learning = _describe(label)
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

        # #23: prefer a model-drafted real old->new diff; fall back to the
        # template guidance block when the diff model is off or can't draft one.
        drafted = draft_change(learning, evidence, target_file, runner=runner)
        if drafted:
            amendment = generate_amendment(
                learning=learning,
                evidence=evidence[:5],
                target_layer=target.value,
                target_file=target_file,
                changes=[drafted],
                domain=domain,
            )
        else:
            amendment = generate_amendment(
                learning=learning,
                evidence=evidence[:5],
                target_layer=target.value,
                target_file=target_file,
                proposed_text=build_guidance_text(learning, evidence, len(matched)),
                domain=domain,
            )
        amendments.append(amendment)

    return _deduplicate(amendments, previous_amendments)
