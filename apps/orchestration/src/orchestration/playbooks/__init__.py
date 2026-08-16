"""Playbook registry for the retained research workflow and engine fixture.

``reference-cycle`` remains registered so engine, CLI, and recovery tests can
exercise a complete run. It is internal and has no user-facing skill.
"""

from ..engine import BasePlaybook
from .reference_cycle import ReferenceCycle, ReferenceCycleMachine
from .research import ResearchPlaybook

PLAYBOOKS: dict[str, type[BasePlaybook]] = {
    ResearchPlaybook.NAME: ResearchPlaybook,
    ReferenceCycle.NAME: ReferenceCycle,
}


def get_playbook(name: str) -> type[BasePlaybook] | None:
    return PLAYBOOKS.get(name)


__all__ = [
    "PLAYBOOKS",
    "get_playbook",
    "ResearchPlaybook",
    "ReferenceCycle",
    "ReferenceCycleMachine",
]
