"""A labelled corpus of grounding defects — the measurement half of research's
registered SAME_MODEL exception (``orchestration/independence.py``).

WHY THIS EXISTS
---------------
research's citation gate (vera) runs sonnet over synthia's sonnet synthesis, so the
final verdict in quick/standard mode is a same-model judgement over the generator's
own work. P5 shipped the opt-in cross-model hook (``constraints['validate_model']``);
this is the substrate for deciding whether cross-model should become the DEFAULT,
which costs latency on every single run.

The deciding question is NOT "are two models better than one?" in the abstract. It is:
**how many real grounding defects are still settled by model judgement at all?** Every
defect a deterministic floor catches is one for which a second model's opinion is
irrelevant — the floor caught it before either model spoke. prd measured exactly this
and found its floor already decided 50% of its corpus.

So each case is labelled with the tier that SHOULD catch it:

* ``rules``     — objective; ``research.grounding_floor`` must catch it by arithmetic
                  (no citation at all, a citation to a source not in the findings, a
                  citation to a source with no captured content). A second model adds
                  nothing here.
* ``judgement`` — the claim IS cited, the source DOES exist and DOES have content, and
                  only a reader can tell that the source does not actually support the
                  claim. This is the residual — the only population that could justify
                  paying for cross-model validation on every run.

ON ``observed``
---------------
Every case here is currently SYNTHETIC and that is stated honestly rather than papered
over. research runs could not previously be mined for real failures: the playbook never
populated ``ctx.verify_gaps``, so the run recorded an empty gap list for
every run and a report shipped with unsupported claims was indistinguishable from a
fully grounded one. P1 fixed that. As real runs accumulate, replace synthetic cases with
observed ones and set ``observed=True`` — a corpus grounded in real failure modes is
worth more than one grounded in an author's imagination, which is the whole point of
preferring measurement to intuition.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GroundingCase:
    id: str
    description: str
    tier: str  # "rules" | "judgement"
    claims: tuple  # [{"id", "text", "cites": [source_id, ...]}, ...]
    sources: tuple  # [{"id", "content"}, ...]
    unsupported: tuple  # ground truth: claim ids that are NOT genuinely grounded
    observed: bool = False  # seen in a real recorded run? (see module docstring)


# A well-formed, genuinely grounded baseline the defect cases mutate.
_SRC_BENCH = {
    "id": "S1",
    "content": (
        "In our benchmark on a two-node test cluster, median query latency fell from "
        "120ms to 72ms after enabling the read cache. We did not measure p99."
    ),
}
_SRC_SURVEY = {
    "id": "S2",
    "content": (
        "A 2019 survey of 400 operators found that 61% of respondents reported using "
        "connection pooling. Teams reporting pooling also reported fewer timeouts; the "
        "survey design cannot establish whether pooling caused the reduction."
    ),
}
_SRC_DOCS = {
    "id": "S3",
    "content": (
        "The driver exposes a poolSize option. The default is 10. Setting it above 100 "
        "is not recommended."
    ),
}


CORPUS: tuple[GroundingCase, ...] = (
    # ---- rules tier: the floor must decide these; a second model is irrelevant -----
    GroundingCase(
        "claim_with_no_citation",
        "a material claim carries no citation marker at all",
        "rules",
        claims=(
            {"id": "C1", "text": "Read caching cut median latency by ~40%.", "cites": ["S1"]},
            {"id": "C2", "text": "Most teams see the same benefit in production.", "cites": []},
        ),
        sources=(_SRC_BENCH,),
        unsupported=("C2",),
    ),
    GroundingCase(
        "dangling_citation",
        "a claim cites S9, which does not exist in the findings",
        "rules",
        claims=({"id": "C1", "text": "p99 latency improved by 40%.", "cites": ["S9"]},),
        sources=(_SRC_BENCH,),
        unsupported=("C1",),
    ),
    GroundingCase(
        "citation_to_empty_source",
        "the cited source is in the findings but has no captured content to check against",
        "rules",
        claims=({"id": "C1", "text": "Pooling reduces timeouts.", "cites": ["S4"]},),
        sources=(_SRC_SURVEY, {"id": "S4", "content": "   "}),
        unsupported=("C1",),
    ),
    GroundingCase(
        "every_claim_uncited",
        "a synthesis that cites nothing anywhere — the degenerate ungrounded report",
        "rules",
        claims=(
            {"id": "C1", "text": "Caching is the biggest win.", "cites": []},
            {"id": "C2", "text": "Pooling is second.", "cites": []},
        ),
        sources=(_SRC_BENCH, _SRC_SURVEY),
        unsupported=("C1", "C2"),
    ),
    # ---- judgement tier: cited, resolvable, content present — only a reader knows --
    GroundingCase(
        "figure_absent_from_cited_source",
        "claims a p99 improvement citing a source that explicitly did NOT measure p99",
        "judgement",
        claims=({"id": "C1", "text": "p99 latency fell by 40%.", "cites": ["S1"]},),
        sources=(_SRC_BENCH,),
        unsupported=("C1",),
    ),
    GroundingCase(
        "overgeneralized_scope",
        "source measured a two-node TEST cluster; the claim asserts production at scale",
        "judgement",
        claims=(
            {
                "id": "C1",
                "text": "In production at scale, read caching cuts median latency by 40%.",
                "cites": ["S1"],
            },
        ),
        sources=(_SRC_BENCH,),
        unsupported=("C1",),
    ),
    GroundingCase(
        "causal_claim_from_correlational_source",
        "source explicitly disclaims causation; the claim asserts it",
        "judgement",
        claims=(
            {"id": "C1", "text": "Connection pooling causes fewer timeouts.", "cites": ["S2"]},
        ),
        sources=(_SRC_SURVEY,),
        unsupported=("C1",),
    ),
    GroundingCase(
        "temporal_overreach",
        "a 2019 survey figure is restated as a present-tense current fact",
        "judgement",
        claims=(
            {"id": "C1", "text": "61% of operators currently use pooling.", "cites": ["S2"]},
        ),
        sources=(_SRC_SURVEY,),
        unsupported=("C1",),
    ),
    GroundingCase(
        "stitched_conjunction",
        "each half is supported by a different source; the conjunction is supported by neither",
        "judgement",
        claims=(
            {
                "id": "C1",
                "text": "Raising poolSize above 100 cuts median latency by 40%.",
                "cites": ["S1", "S3"],
            },
        ),
        sources=(_SRC_BENCH, _SRC_DOCS),
        unsupported=("C1",),
    ),
    GroundingCase(
        "plausible_but_source_silent",
        "topically relevant source that simply says nothing about the claim",
        "judgement",
        claims=(
            {"id": "C1", "text": "The default poolSize is tuned for SSD storage.", "cites": ["S3"]},
        ),
        sources=(_SRC_DOCS,),
        unsupported=("C1",),
    ),
    # ---- a clean case: the floor must NOT fire on genuinely grounded work ----------
    GroundingCase(
        "genuinely_grounded",
        "every claim cited to a real source that actually supports it",
        "judgement",  # no defect; graded as residual because only a reader confirms it
        claims=(
            {
                "id": "C1",
                "text": "On a two-node test cluster, median latency fell from 120ms to 72ms.",
                "cites": ["S1"],
            },
            {"id": "C2", "text": "The driver's default poolSize is 10.", "cites": ["S3"]},
        ),
        sources=(_SRC_BENCH, _SRC_DOCS),
        unsupported=(),
    ),
)


def by_tier(tier: str) -> tuple[GroundingCase, ...]:
    return tuple(c for c in CORPUS if c.tier == tier)


def defective() -> tuple[GroundingCase, ...]:
    """Cases that actually carry a defect (excludes the clean control)."""
    return tuple(c for c in CORPUS if c.unsupported)
