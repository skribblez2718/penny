"""Drift guard: a skill's ``resources/reference.md`` State + Transition tables
MUST stay an exact mirror of its FSM playbook.

``resources/reference.md`` is checker-REQUIRED for every skill
(``scripts/system/checks/check_compliance.py``) and is read by agents at runtime —
the engine appends the absolute skill root to every directive and tells the agent
to read its skill-relative guidance by that path
(``BasePlaybook._skill_root_line``). That makes a stale reference.md worse than
useless: it actively misinforms the agents executing the run.

This is exactly what happened to ``research``. Its reference.md described a
``detect_mode`` keyword router that had been DELETED, called ``researching`` a
"single agent" after it became a dynamic fan, and omitted the ``validating``
state and all four of its transitions entirely — i.e. it documented away the
skill's central quality gate. ``flow.html`` was correct throughout, because
``test_flow_diagrams.py`` enforces it. Prose that is not enforced drifts; prose
that is enforced does not. This test extends that enforcement to reference.md.

Parser conventions (kept simple + regex-parseable, mirroring the flow-diagram
guard):
  * a ``## States`` section containing a markdown table whose FIRST cell per row
    is the VERBATIM backticked FSM state id;
  * a ``## Transitions`` section containing a markdown table with columns
    ``Event | From | To | ...``, where From/To cells carry backticked state ids.
    A From cell may list alternatives separated by an escaped pipe (``\\|``).

Deliberate, documented exceptions (identical to ``test_flow_diagrams.py``): the
two UNIFORM seams — ``* -> error`` (abort, from every non-final state) and
``* -> unknown`` (escalation, from every agent state) — MAY be collapsed into a
textual note ("any non-final state") instead of enumerated per-source. They are
excluded from the "must be declared" set; a file is still free to enumerate them,
and if it does, they must be REAL transitions (the no-invented-edges check
applies to everything).

Scope note: enabled per skill via ``CASES``. Only ``research`` is enrolled today
— it is the skill whose reference.md was audited and rewritten to this format.
Other skills' reference.md files use varying table shapes and are out of scope;
enrolling one is a one-line addition here plus whatever formatting that file
needs. Do NOT enroll a skill without checking its file parses, or this guard
becomes noise.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from orchestration.playbooks.research import ResearchMachine

# (skill dir name, FSM class). Add a skill only after confirming its
# reference.md's State/Transition tables parse under the conventions above.
CASES = [
    ("research", ResearchMachine),
]

# The two uniform seams that may be collapsed into a textual note.
_COLLAPSIBLE_TARGETS = {"error", "unknown"}

_PIPE_SENTINEL = "\x00ESCPIPE\x00"
_TOKEN_RE = re.compile(r"`([a-z_][a-z0-9_]*)`")


def _skill_resources(skill: str) -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / ".pi" / "skills" / skill / "resources"
        if cand.exists():
            return cand
    raise FileNotFoundError(f"resources dir not found for skill '{skill}'")


def _reference_md(skill: str) -> str:
    return (_skill_resources(skill) / "reference.md").read_text(encoding="utf-8")


def _section(text: str, heading: str) -> str:
    """The body of a ``## <heading>`` section, up to the next ``##`` heading."""
    match = re.search(rf"(?m)^##\s+{re.escape(heading)}\s*$", text)
    if not match:
        raise AssertionError(f"reference.md has no '## {heading}' section")
    rest = text[match.end() :]
    nxt = re.search(r"(?m)^##\s+", rest)
    return rest[: nxt.start()] if nxt else rest


def _table_rows(section: str) -> list[list[str]]:
    """Data rows of the first markdown table in ``section``, as cell lists.

    Header and separator rows are dropped. Escaped pipes (``\\|``) inside a cell
    are preserved rather than treated as column delimiters.
    """
    rows: list[list[str]] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        if set(stripped) <= set("|-: "):  # separator row
            continue
        protected = stripped.replace("\\|", _PIPE_SENTINEL)
        cells = [c.replace(_PIPE_SENTINEL, "|").strip() for c in protected.strip("|").split("|")]
        rows.append(cells)
    return rows[1:] if rows else []  # drop the header row


def _fsm_states(machine) -> set[str]:
    return {s.id for s in machine().states}


def _fsm_transitions(machine) -> set[tuple[str, str]]:
    m = machine()
    return {(t.source.id, t.target.id) for s in m.states for t in s.transitions}


def _declared_states(skill: str) -> set[str]:
    """State ids declared in the States table (first cell of each row)."""
    declared: set[str] = set()
    for cells in _table_rows(_section(_reference_md(skill), "States")):
        if not cells:
            continue
        declared.update(_TOKEN_RE.findall(cells[0]))
    return declared


def _declared_transitions(skill: str) -> set[tuple[str, str]]:
    """(from, to) pairs declared in the Transitions table.

    A From cell listing alternatives yields one pair per alternative. Cells with
    no backticked id (e.g. "any non-final state") yield nothing.
    """
    pairs: set[tuple[str, str]] = set()
    for cells in _table_rows(_section(_reference_md(skill), "Transitions")):
        if len(cells) < 3:
            continue
        sources = _TOKEN_RE.findall(cells[1])
        targets = _TOKEN_RE.findall(cells[2])
        for src in sources:
            for tgt in targets:
                pairs.add((src, tgt))
    return pairs


@pytest.mark.parametrize("skill,machine", CASES)
def test_every_fsm_state_is_documented(skill, machine):
    missing = _fsm_states(machine) - _declared_states(skill)
    assert not missing, (
        f"{skill}/resources/reference.md States table is missing FSM state(s): "
        f"{sorted(missing)}. This is the failure that hid the `validating` gate."
    )


@pytest.mark.parametrize("skill,machine", CASES)
def test_no_phantom_states_documented(skill, machine):
    phantom = _declared_states(skill) - _fsm_states(machine)
    assert not phantom, (
        f"{skill}/resources/reference.md States table documents state(s) that do not "
        f"exist in the FSM: {sorted(phantom)}"
    )


@pytest.mark.parametrize("skill,machine", CASES)
def test_every_pipeline_transition_is_documented(skill, machine):
    declared = _declared_transitions(skill)
    expected = {(s, t) for (s, t) in _fsm_transitions(machine) if t not in _COLLAPSIBLE_TARGETS}
    missing = expected - declared
    assert not missing, (
        f"{skill}/resources/reference.md is missing transition(s) present in the FSM "
        f"(drift): {sorted(missing)}. Update the Transitions table to mirror the machine."
    )


@pytest.mark.parametrize("skill,machine", CASES)
def test_no_invented_transitions(skill, machine):
    declared = _declared_transitions(skill)
    invented = declared - _fsm_transitions(machine)
    assert not invented, (
        f"{skill}/resources/reference.md documents transition(s) that are not real FSM "
        f"transitions: {sorted(invented)}"
    )


@pytest.mark.parametrize("skill,machine", CASES)
def test_collapsible_seams_are_documented(skill, machine):
    text = _reference_md(skill).lower()
    assert (
        "abort" in text and "error" in text
    ), f"{skill}/resources/reference.md must document the abort -> error seam"
    assert (
        "escalat" in text and "unknown" in text
    ), f"{skill}/resources/reference.md must document the escalation -> unknown seam"


@pytest.mark.parametrize("skill,machine", CASES)
def test_no_retired_mechanisms_referenced(skill, machine):
    """A named mechanism that no longer exists in the playbook must not be
    described as current.

    Checked against DEFINITION SITES, not mentions. A plain substring search over
    the module source is useless here: ``research.py``'s docstring explains that
    the ``detect_mode`` router *was deleted*, so the retired name appears in the
    source and a naive check passes while the stale doc still presents it as live
    machinery (verified: that is exactly what happened).
    """
    import importlib

    module = importlib.import_module(f"orchestration.playbooks.{skill}")
    source = Path(module.__file__).read_text(encoding="utf-8")
    text = _reference_md(skill)
    # Identifiers the doc presents as live machinery (routers / per-mode tables).
    named = set(re.findall(r"`(detect_[a-z_]+|[A-Z][A-Z0-9_]*_BY_[A-Z0-9_]+)`", text))
    dangling = set()
    for name in named:
        defined = re.search(
            rf"(?m)^\s*(?:def\s+{re.escape(name)}\b|class\s+{re.escape(name)}\b"
            rf"|{re.escape(name)}\s*(?::[^=\n]+)?=)",
            source,
        )
        if not defined:
            dangling.add(name)
    assert not dangling, (
        f"{skill}/resources/reference.md presents mechanism(s) as live that have no "
        f"definition in playbooks/{skill}.py: {sorted(dangling)}"
    )
