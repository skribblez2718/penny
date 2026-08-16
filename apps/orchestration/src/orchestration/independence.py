"""Verification-independence ledger for the retained research workflow.

The ledger resolves agent models live from frontmatter and classifies each
producer-to-verifier edge. A same-model bare-judgement edge must have a dated,
rationalized exception; stale or unregistered entries fail loud in tests.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .roster import roster_changed, roster_hash

_AGENTS_DIR = Path(__file__).resolve().parents[4] / ".pi" / "agents"

CROSS_MODEL = "CROSS_MODEL"
INDEPENDENT_CHECK = "INDEPENDENT_CHECK"
SAME_MODEL = "SAME_MODEL"


def agent_model(agent: str, agents_dir: Path | str = _AGENTS_DIR) -> str:
    """Read an agent's model live from its frontmatter; missing data fails loud."""
    path = Path(agents_dir) / f"{agent}.md"
    text = path.read_text(encoding="utf-8")
    match = re.search(r"(?m)^model:[ \t]*(\S+)[ \t]*$", text)
    if not match:
        raise ValueError(f"no 'model:' frontmatter in {path}")
    return match.group(1).strip()


@dataclass(frozen=True)
class VerifyEdge:
    """One primary producer-to-verifier edge and any independent check on it."""

    skill: str
    actor: str
    verifier: str
    independent_check: str


VERIFY_EDGES: tuple[VerifyEdge, ...] = (VerifyEdge("research", "synthia", "vera", ""),)

# Fleet baseline for the retained exception. This is a change tripwire, not
# evidence that the exception was freshly measured on this fleet.
BASELINE_ROSTER = "4e55bff3547d"


@dataclass(frozen=True)
class IndependenceException:
    """A dated acceptance of a same-model bare-judgement verification edge."""

    skill: str
    rationale: str
    review_by: str
    roster_at_review: str = BASELINE_ROSTER


SAME_MODEL_EXCEPTIONS: dict[str, IndependenceException] = {
    "research": IndependenceException(
        "research",
        "The final citation-grounding gate is evidence-based, but the producer and "
        "verifier currently resolve to the same model. A caller can select a distinct "
        "validation model. Keep the default exception only until residual grounding "
        "defects are measured against that cross-model option.",
        "2026-10-01",
    )
}


def classify(edge: VerifyEdge, model_of: Callable[[str], str] = agent_model) -> str:
    """Classify an edge as cross-model, independently checked, or same-model."""
    if model_of(edge.actor) != model_of(edge.verifier):
        return CROSS_MODEL
    return INDEPENDENT_CHECK if edge.independent_check else SAME_MODEL


def check_independence(model_of: Callable[[str], str] = agent_model) -> list[str]:
    """Return unregistered same-model bare-judgement edges."""
    return [
        edge.skill
        for edge in VERIFY_EDGES
        if classify(edge, model_of) == SAME_MODEL and edge.skill not in SAME_MODEL_EXCEPTIONS
    ]


def stale_exceptions(model_of: Callable[[str], str] = agent_model) -> list[str]:
    """Return exceptions whose edge is gone or no longer same-model."""
    by_skill = {edge.skill: edge for edge in VERIFY_EDGES}
    stale: list[str] = []
    for skill in SAME_MODEL_EXCEPTIONS:
        edge = by_skill.get(skill)
        if edge is None or classify(edge, model_of) != SAME_MODEL:
            stale.append(skill)
    return stale


def exceptions_needing_roster_review() -> list[str]:
    """Return exceptions whose fleet-change review tripwire has fired."""
    return [
        skill
        for skill, exception in SAME_MODEL_EXCEPTIONS.items()
        if roster_changed(exception.roster_at_review)
    ]


def current_roster() -> str:
    """Return the current fleet digest for a completed exception review."""
    return roster_hash()
