"""Playbook registry — maps ``--playbook`` names to BasePlaybook subclasses.

Domain skills (``code``, …) register here, one entry per skill. ``reference-cycle``
is the engine's smoke-test fixture, kept registered so the engine/CLI/recovery
tests can drive a full run — it is not a user-facing skill.
"""

from ..engine import BasePlaybook
from .code import CodePlaybook
from .derivation import DerivationPlaybook
from .imagegen import ImagegenPlaybook
from .videogen import VideogenPlaybook
from .jsa import JSAPlaybook
from .learn import LearnPlaybook
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
    ResearchPlaybook.NAME: ResearchPlaybook,  # domain skill
    ScaPlaybook.NAME: ScaPlaybook,  # domain skill (secure code analysis)
    JSAPlaybook.NAME: JSAPlaybook,  # domain skill (JS security analysis)
    RezPlaybook.NAME: RezPlaybook,  # domain skill (resume tailoring)
    LearnPlaybook.NAME: LearnPlaybook,  # domain skill (study-material generation)
    ImagegenPlaybook.NAME: ImagegenPlaybook,  # domain skill (local image generation)
    VideogenPlaybook.NAME: VideogenPlaybook,  # domain skill (instructional video generation)
    DerivationPlaybook.NAME: DerivationPlaybook,  # domain skill (derivation/independence gate)
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
    "ResearchPlaybook",
    "ScaPlaybook",
    "JSAPlaybook",
    "LearnPlaybook",
    "RezPlaybook",
    "ImagegenPlaybook",
    "VideogenPlaybook",
    "DerivationPlaybook",
    "ReferenceCycle",
    "ReferenceCycleMachine",
]
