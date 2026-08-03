"""Drift guard: every skill's ``resources/flow.html`` MUST stay an edge-for-edge
mirror of its FSM playbook.

``flow.html`` (the interactive HTML diagram) is the CANONICAL, ENFORCED pipeline
diagram for each orchestration skill — it replaced the old Mermaid ``flow.mmd``.
This test parses the diagram's ``N`` (nodes) + ``E`` (edges) data out of the HTML
and cross-checks it against the live state machine, so adding / removing /
rewiring a state in ``orchestration/playbooks/<skill>.py`` without updating
``flow.html`` (or vice-versa) fails CI.

Conventions the parser relies on (kept simple + regex-parseable):
  * ``const N = { <state_id>:{...}, ... };`` — one node per line, keyed by the
    VERBATIM FSM state id.
  * ``const E = [ {from:'<id>',to:'<id>', ...}, ... ];`` — ``from`` precedes
    ``to`` in each edge object.

Deliberate, documented exceptions: the two UNIFORM seams — ``* -> error`` (abort,
from every non-final state) and ``* -> unknown`` (escalation, from every agent
state) — MAY be collapsed into a textual note instead of drawn per-source. The
test requires both omissions to be documented and excludes ``-> error`` /
``-> unknown`` edges from the "must be drawn" set; a diagram is still free to draw
them (they must then be REAL transitions — the no-invented-edges check applies).
Everything else — the pipeline, gates, loops, and resume targets — must be drawn.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from orchestration.playbooks.code import CodeMachine
from orchestration.playbooks.derivation import DerivationMachine
from orchestration.playbooks.imagegen import ImagegenMachine
from orchestration.playbooks.jsa import JSAMachine
from orchestration.playbooks.learn import LearnMachine
from orchestration.playbooks.plan import PlanMachine
from orchestration.playbooks.prd import PrdMachine
from orchestration.playbooks.research import ResearchMachine
from orchestration.playbooks.rez import RezMachine
from orchestration.playbooks.sca import SCAMachine
from orchestration.playbooks.videogen import VideogenMachine

# (skill dir name, FSM class). Every HTML-diagram skill is enforced here.
CASES = [
    ("jsa", JSAMachine),
    ("sca", SCAMachine),
    ("code", CodeMachine),
    ("plan", PlanMachine),
    ("prd", PrdMachine),
    ("learn", LearnMachine),
    ("research", ResearchMachine),
    ("derivation", DerivationMachine),
    ("imagegen", ImagegenMachine),
    ("videogen", VideogenMachine),
    ("rez", RezMachine),
]


def _skill_resources(skill: str) -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / ".pi" / "skills" / skill / "resources"
        if cand.exists():
            return cand
    raise FileNotFoundError(f"resources dir not found for skill '{skill}'")


def _flow_html(skill: str) -> str:
    return (_skill_resources(skill) / "flow.html").read_text(encoding="utf-8")


def _fsm_states(machine) -> set[str]:
    return {s.id for s in machine().states}


def _fsm_transitions(machine) -> set[tuple[str, str]]:
    m = machine()
    return {(t.source.id, t.target.id) for s in m.states for t in s.transitions}


def _parse_html_flow(text: str) -> tuple[set[str], set[tuple[str, str]]]:
    """Return (node_ids, drawn_edges) from the diagram's ``N``/``E`` script data."""
    n_seg = text.split("const N", 1)[1].split("const E", 1)[0]
    nodes = set(re.findall(r"^\s{2,}([A-Za-z_]\w*)\s*:\s*\{", n_seg, re.M))
    e_seg = text.split("const E", 1)[1].split("];", 1)[0]
    froms = re.findall(r"\bfrom\s*:\s*'([A-Za-z_]\w*)'", e_seg)
    tos = re.findall(r"\bto\s*:\s*'([A-Za-z_]\w*)'", e_seg)
    assert len(froms) == len(tos), "each edge must have exactly one from and one to"
    return nodes, set(zip(froms, tos))


@pytest.mark.parametrize("skill,machine", CASES)
def test_every_fsm_state_is_declared(skill, machine):
    nodes, _ = _parse_html_flow(_flow_html(skill))
    missing = _fsm_states(machine) - nodes
    assert not missing, f"{skill}/flow.html is missing node(s) for FSM state(s): {sorted(missing)}"


@pytest.mark.parametrize("skill,machine", CASES)
def test_no_phantom_nodes(skill, machine):
    nodes, _ = _parse_html_flow(_flow_html(skill))
    phantom = nodes - _fsm_states(machine)
    assert not phantom, f"{skill}/flow.html declares node(s) not in the FSM: {sorted(phantom)}"


# The two uniform seams that may be collapsed into a note instead of drawn.
_COLLAPSIBLE_TARGETS = {"error", "unknown"}


@pytest.mark.parametrize("skill,machine", CASES)
def test_every_pipeline_edge_is_drawn(skill, machine):
    _, edges = _parse_html_flow(_flow_html(skill))
    expected = {(s, t) for (s, t) in _fsm_transitions(machine) if t not in _COLLAPSIBLE_TARGETS}
    missing = expected - edges
    assert not missing, (
        f"{skill}/flow.html is missing edges present in the FSM (drift): {sorted(missing)}. "
        "Update resources/flow.html to mirror the state machine."
    )


@pytest.mark.parametrize("skill,machine", CASES)
def test_no_invented_edges(skill, machine):
    _, edges = _parse_html_flow(_flow_html(skill))
    invented = edges - _fsm_transitions(machine)
    assert not invented, (
        f"{skill}/flow.html draws edges that are not real FSM transitions: {sorted(invented)}"
    )


@pytest.mark.parametrize("skill,machine", CASES)
def test_collapsible_seams_are_documented(skill, machine):
    text = _flow_html(skill).lower()
    assert "abort" in text and "error" in text, (
        f"{skill}/flow.html must document the omitted abort -> error transitions"
    )
    assert "escalat" in text and "unknown" in text, (
        f"{skill}/flow.html must document the escalation -> unknown seam"
    )


@pytest.mark.parametrize("skill", [c[0] for c in CASES])
def test_mermaid_mmd_is_retired(skill):
    # flow.html is the standard; the old Mermaid source must not linger and drift.
    assert not (_skill_resources(skill) / "flow.mmd").exists(), (
        f"{skill}/resources/flow.mmd still exists — flow.html is the standard; remove the .mmd"
    )
