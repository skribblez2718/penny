"""A labelled corpus of defective PRDs — the measurement half of V12 repayment.

WHY THIS EXISTS
---------------
``independence.py`` registers prd's synthia->vera edge as a SAME_MODEL exception and
states the repayment terms: *"adopt jsa's cross-model hook AND measure same- vs
cross-model catch rate"*. Item 10 shipped the hook. This is the measurement substrate.

The question that decides whether cross-model validation should become the DEFAULT
(paying real cost and latency on every run) is not "is a second model better?" in the
abstract. It is: **how many real PRD defects are still decided by model judgement at
all?** Every defect that deterministic code already catches is a defect for which a
second model adds nothing — the floor caught it before either model spoke.

So each case is labelled with the tier that SHOULD catch it:

* ``rules``     — objective; the IDEAL_STATE schema validator or item 11's
                  ``hard_contradictions`` must catch it. A second model is irrelevant here.
* ``judgement`` — cannot be settled by counting; only a reader can. This is the
                  population where an independent second model could plausibly help,
                  and therefore the only population that can justify the cost.

``observed=True`` marks a defect actually seen in a recorded run rather than invented,
so the corpus stays grounded in real failure modes.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class DefectCase:
    id: str
    description: str
    tier: str  # "rules" | "judgement"
    ideal: dict
    narrative: str = ""
    catalog: list = field(default_factory=list)
    matrix: dict = field(default_factory=dict)
    observed: bool = False  # seen in a real recorded run?


def _ok_ideal(**over) -> dict:
    base = {
        "goal": "Add per-IP rate limiting to the login endpoint",
        "success_criteria": ["429 returned after 10 failed attempts per IP per 15 min"],
        "security_review": ["input-validation"],
        "language": "typescript",
        "verification": {"unit_tests": True},
    }
    base.update(over)
    return base


_CAT_OK = [
    {"id": "REQ-001", "priority": "P0", "title": "counter", "acceptance_criteria": ["a", "b"]},
    {"id": "REQ-002", "priority": "P0", "title": "429 response", "acceptance_criteria": ["c"]},
]
_MAT_OK = {"REQ-001": {"unit_tests": ["t1"]}, "REQ-002": {"unit_tests": ["t2"]}}
_NARR_OK = "\n".join(f"## {i}. Section {i}\ncontent" for i in range(1, 13))


CORPUS: tuple[DefectCase, ...] = (
    # ---- rules tier: code must catch these; a second model is irrelevant ----------
    DefectCase(
        "schema_security_review_string",
        "security_review is a bare string where the canonical schema requires list[str]",
        "rules",
        ideal=_ok_ideal(security_review="injection and xss"),
        narrative=_NARR_OK, catalog=_CAT_OK, matrix=_MAT_OK,
        observed=True,  # probe 2 (plan-1785416836915), caught at iteration 0
    ),
    DefectCase(
        "ideal_missing_success_criteria",
        "IDEAL_STATE has no success_criteria at all — nothing to verify against",
        "rules",
        ideal={"goal": "do the thing"},
        narrative=_NARR_OK, catalog=_CAT_OK, matrix=_MAT_OK,
    ),
    DefectCase(
        "matrix_omits_requirement",
        "REQ-002 exists in the catalog but has no verification-matrix entry",
        "rules",
        ideal=_ok_ideal(), narrative=_NARR_OK, catalog=_CAT_OK,
        matrix={"REQ-001": {"unit_tests": ["t1"]}},
    ),
    DefectCase(
        "duplicate_requirement_ids",
        "two catalog entries share REQ-001, so traceability is ambiguous",
        "rules",
        ideal=_ok_ideal(), narrative=_NARR_OK,
        catalog=_CAT_OK + [{"id": "REQ-001", "acceptance_criteria": ["dupe"]}],
        matrix=_MAT_OK,
    ),
    DefectCase(
        "requirement_without_strategy",
        "REQ-002 is in the matrix but every strategy list is empty — uncheckable",
        "rules",
        ideal=_ok_ideal(), narrative=_NARR_OK, catalog=_CAT_OK,
        matrix={"REQ-001": {"unit_tests": ["t1"]}, "REQ-002": {"unit_tests": [], "e2e_tests": []}},
    ),
    DefectCase(
        "matrix_references_unknown_id",
        "matrix keys a REQ-999 that does not exist in the catalog",
        "rules",
        ideal=_ok_ideal(), narrative=_NARR_OK, catalog=_CAT_OK,
        matrix={**_MAT_OK, "REQ-999": {"unit_tests": ["ghost"]}},
    ),
    # ---- judgement tier: only a reader can settle these ---------------------------
    DefectCase(
        "unmeasurable_success_criterion",
        "criterion says 'the endpoint should be fast' — an adjective, not a threshold",
        "judgement",
        ideal=_ok_ideal(success_criteria=["the endpoint should be fast and reliable"]),
        narrative=_NARR_OK, catalog=_CAT_OK, matrix=_MAT_OK,
    ),
    DefectCase(
        "cross_artifact_contradiction",
        "narrative specifies a TypeScript/Express service, IDEAL_STATE says language python",
        "judgement",
        ideal=_ok_ideal(language="python"),
        narrative=_NARR_OK + "\nThe service is TypeScript on Express 4.",
        catalog=_CAT_OK, matrix=_MAT_OK,
    ),
    DefectCase(
        "criteria_metric_mapping_misstated",
        "5 success_criteria vs 6 narrative Success Metrics, asserted as a 1:1 mapping",
        "judgement",
        ideal=_ok_ideal(success_criteria=[f"c{i}" for i in range(5)]),
        narrative=_NARR_OK + "\n" + "\n".join(f"- **SM{i}**: metric {i}" for i in range(1, 7)),
        catalog=_CAT_OK, matrix=_MAT_OK,
        observed=True,  # probe 1 (plan-1785347609778) — vera's own evidence line
    ),
    DefectCase(
        "unsourced_threshold",
        "a P99 latency target appears with no provenance (not user-stated, not measured, "
        "not cited, not labelled '(project default, unverified)')",
        "judgement",
        ideal=_ok_ideal(success_criteria=["P99 added latency under 15ms"]),
        narrative=_NARR_OK, catalog=_CAT_OK, matrix=_MAT_OK,
    ),
    DefectCase(
        "goal_is_an_unrefined_stub",
        "IDEAL_STATE.goal is a verbatim copy of the raw request, not a refined statement",
        "judgement",
        ideal=_ok_ideal(goal="do the rate limiting thing"),
        narrative=_NARR_OK, catalog=_CAT_OK, matrix=_MAT_OK,
    ),
    DefectCase(
        "requirement_not_atomic",
        "REQ-001 bundles three behaviours, so a partial pass is indistinguishable from a pass",
        "judgement",
        ideal=_ok_ideal(), narrative=_NARR_OK,
        catalog=[
            {
                "id": "REQ-001", "priority": "P0",
                "title": "counter, 429 response, and Datadog alerting",
                "acceptance_criteria": ["counter works, 429 returned, and alert fires"],
            },
            _CAT_OK[1],
        ],
        matrix=_MAT_OK,
    ),
)


def by_tier(tier: str) -> tuple[DefectCase, ...]:
    return tuple(c for c in CORPUS if c.tier == tier)
