"""Playbook registry — maps ``--playbook`` names to BasePlaybook subclasses.

Domain skills (``code``, …) register here, one entry per skill. ``reference-cycle``
is the engine's smoke-test fixture, kept registered so the engine/CLI/recovery
tests can drive a full run — it is not a user-facing skill.
"""

from ..engine import BasePlaybook
from .agent import AgentPlaybook
from .code import CodePlaybook
from .derivation import DerivationPlaybook
from .imagegen import ImagegenPlaybook
from .jsa import JSAPlaybook
from .learn import LearnPlaybook
from .manim import ManimPlaybook
from .plan import PlanPlaybook
from .prd import PrdPlaybook
from .reference_cycle import ReferenceCycle, ReferenceCycleMachine
from .research import ResearchPlaybook
from .rez import RezPlaybook
from .sca import ScaPlaybook

PLAYBOOKS: dict[str, type[BasePlaybook]] = {
    CodePlaybook.NAME: CodePlaybook,  # domain skill (pilot migration)
    PlanPlaybook.NAME: PlanPlaybook,  # domain skill
    PrdPlaybook.NAME: PrdPlaybook,  # domain skill
    AgentPlaybook.NAME: AgentPlaybook,  # domain skill
    ResearchPlaybook.NAME: ResearchPlaybook,  # domain skill
    ScaPlaybook.NAME: ScaPlaybook,  # domain skill (secure code analysis)
    JSAPlaybook.NAME: JSAPlaybook,  # domain skill (JS security analysis)
    RezPlaybook.NAME: RezPlaybook,  # domain skill (resume tailoring)
    LearnPlaybook.NAME: LearnPlaybook,  # domain skill (study-material generation)
    ImagegenPlaybook.NAME: ImagegenPlaybook,  # domain skill (local image generation)
    DerivationPlaybook.NAME: DerivationPlaybook,  # domain skill (derivation/independence gate)
    ManimPlaybook.NAME: ManimPlaybook,  # domain skill (educational-video render bundles)
    ReferenceCycle.NAME: ReferenceCycle,  # engine smoke-test fixture only
}


def get_playbook(name: str) -> type[BasePlaybook] | None:
    return PLAYBOOKS.get(name)


__all__ = [
    "PLAYBOOKS",
    "get_playbook",
    "CodePlaybook",
    "PlanPlaybook",
    "PrdPlaybook",
    "AgentPlaybook",
    "ResearchPlaybook",
    "ScaPlaybook",
    "JSAPlaybook",
    "LearnPlaybook",
    "RezPlaybook",
    "ImagegenPlaybook",
    "DerivationPlaybook",
    "ManimPlaybook",
    "ReferenceCycle",
    "ReferenceCycleMachine",
]
