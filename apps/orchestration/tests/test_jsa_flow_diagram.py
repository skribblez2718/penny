"""Drift guard: resources/flow.mmd MUST stay an edge-for-edge mirror of JSAMachine.

flow.mmd is declared the *canonical* pipeline diagram (SKILL.md and README point at
it). Nothing enforced that claim before — the skill-structure checker only asserts
the file EXISTS. This test parses the Mermaid state diagram and cross-checks it
against the live FSM so that adding/removing/rewiring a state in
``orchestration/playbooks/jsa.py`` without updating ``flow.mmd`` (or vice-versa)
fails CI.

Deliberate, documented exception: the ``abort -> error`` transitions exist from
every non-final state but are NOT drawn in flow.mmd (they are collapsed into a
textual note for readability). The test enforces that the note documents the
omission, and excludes ``-> error`` edges from the "must be drawn" check.
"""

from __future__ import annotations

import re
from pathlib import Path

from orchestration.playbooks.jsa import JSAMachine


def _find_flow_mmd() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / ".pi" / "skills" / "jsa" / "resources" / "flow.mmd"
        if cand.exists():
            return cand
    raise FileNotFoundError("flow.mmd not found ascending from the test file")


def _fsm_states() -> set[str]:
    m = JSAMachine()
    return {s.id for s in m.states}


def _fsm_transitions() -> set[tuple[str, str]]:
    m = JSAMachine()
    return {(t.source.id, t.target.id) for s in m.states for t in s.transitions}


def _parse_flow(text: str) -> tuple[set[str], set[tuple[str, str]]]:
    """Return (declared_state_ids, drawn_edges). Ignores ``%%`` comments, the
    ``[*]`` start/end pseudo-states, and note blocks (which are not edges)."""
    declared: set[str] = set()
    edges: set[tuple[str, str]] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("%%"):
            continue
        # State declaration: state "label" as id
        m_decl = re.match(r'state\s+".*"\s+as\s+(\w+)\s*$', line)
        if m_decl:
            declared.add(m_decl.group(1))
            continue
        # A bare ``state "x" as x`` for complete/error is caught above; also accept
        # the short form ``state "complete" as complete`` already handled.
        # Edge: src --> tgt  (optionally ``: event [guard]``). \w+ excludes [*].
        m_edge = re.match(r"(\w+)\s*-->\s*(\w+)", line)
        if m_edge:
            edges.add((m_edge.group(1), m_edge.group(2)))
    return declared, edges


def test_every_fsm_state_is_declared_in_flow():
    declared, _ = _parse_flow(_find_flow_mmd().read_text(encoding="utf-8"))
    missing = _fsm_states() - declared
    assert not missing, f"flow.mmd is missing state declarations for: {sorted(missing)}"


def test_flow_declares_no_phantom_states():
    declared, _ = _parse_flow(_find_flow_mmd().read_text(encoding="utf-8"))
    phantom = declared - _fsm_states()
    assert not phantom, f"flow.mmd declares states that do not exist in JSAMachine: {sorted(phantom)}"


def test_every_non_abort_transition_is_drawn():
    _, edges = _parse_flow(_find_flow_mmd().read_text(encoding="utf-8"))
    # abort -> error edges are intentionally collapsed into a note (see module docstring).
    expected = {(s, t) for (s, t) in _fsm_transitions() if t != "error"}
    missing = expected - edges
    assert not missing, (
        "flow.mmd is missing edges present in JSAMachine (drift): "
        f"{sorted(missing)}. Update resources/flow.mmd to mirror the FSM."
    )


def test_flow_draws_no_invented_edges():
    _, edges = _parse_flow(_find_flow_mmd().read_text(encoding="utf-8"))
    real = _fsm_transitions()
    invented = edges - real
    assert not invented, (
        f"flow.mmd draws edges that are not real JSAMachine transitions: {sorted(invented)}"
    )


def test_abort_omission_is_documented():
    # The abort->error edges are omitted for readability; the note MUST say so, so a
    # reader is not misled into thinking abort is unreachable.
    text = _find_flow_mmd().read_text(encoding="utf-8").lower()
    assert "abort" in text and "error" in text, "flow.mmd must document the abort -> error omission"
