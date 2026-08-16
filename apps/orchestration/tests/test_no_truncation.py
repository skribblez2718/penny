"""Invariant: agents receive their FULL input, and their full output is recorded.

WHY THIS EXISTS
---------------
The engine used to bound every value embedded in an agent task message at 600 chars
(``BasePlaybook._cap``, LOAN ``task_digest_cap``), justified by "directives stay
digests… full data lives in MemPalace".

That premise was false for the single most important value it truncated: ``ctx.goal``.
A prior run sent a 1,967-character goal and the agent received only 613 characters —
69% of the specification was silently discarded with no recovery path. Similar caps
also clipped evidence and other agent-facing context.

THE RULE (operator-set): no truncation of agent input or output, anywhere, in any skill.
A fixed character threshold is scaffolding for small-context models; it destroys primary
data and gets *worse* as goals get richer.

The one permitted bound is a hard EXTERNAL limit (an image model's prompt ceiling, a
storage chunk threshold) — and it must be explicit and marked, never silent.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src" / "orchestration"


def _sources() -> list[Path]:
    return [p for p in _SRC.rglob("*.py") if "__pycache__" not in p.parts]


# ---------------------------------------------------------------------------
# the mechanism is gone
# ---------------------------------------------------------------------------


def test_cap_helper_no_longer_exists():
    from orchestration.engine import BasePlaybook

    assert not hasattr(BasePlaybook, "_cap")


def test_task_digest_cap_loan_is_retired():
    from orchestration.loans import LOANS

    assert "task_digest_cap" not in LOANS


@pytest.mark.parametrize("path", _sources(), ids=lambda p: p.name)
def test_no_source_reintroduces_the_cap_helper(path):
    text = path.read_text(encoding="utf-8")
    assert "_cap(" not in text.replace(
        "_augment_cap(", ""
    ), f"{path.name} reintroduces a task-value cap. Agents must receive full input."


# ---------------------------------------------------------------------------
# behavioural: a full goal reaches the agent intact
# ---------------------------------------------------------------------------


def test_a_long_goal_reaches_the_agent_verbatim(tmp_path):
    from orchestration.checkpointer import Checkpointer
    from orchestration.playbooks.research import ResearchPlaybook

    goal = (
        "Research a topic. " + "CONTEXT: " + ("x" * 1500) + " FINAL REQUIREMENT: the last "
        "sentence must survive, because a truncated goal silently drops the acceptance bar."
    )
    cp = Checkpointer(db_path=tmp_path / "o.db")
    d = ResearchPlaybook(cp).start(
        session_id="s", run_id="r", goal=goal, project_root=str(tmp_path)
    )
    task = d["task_summary"]
    assert goal in task, "the goal must reach the agent verbatim"
    assert "FINAL REQUIREMENT" in task, "the tail of the goal was dropped"
    assert "[truncated]" not in task


def test_clarification_text_is_not_truncated(tmp_path):
    from orchestration.checkpointer import Checkpointer
    from orchestration.playbooks.research import ResearchPlaybook

    cp = Checkpointer(db_path=tmp_path / "o.db")
    ResearchPlaybook(cp).start(session_id="s", run_id="r", goal="g", project_root=str(tmp_path))
    ResearchPlaybook(cp).step(
        session_id="s",
        run_id="r",
        agent="piper",
        result={
            "plan_steps": [],
            "plan_complete": False,
            "needs_clarification": True,
            "clarifying_questions": ["q?"],
        },
    )
    answer = "ANSWER-START " + ("y" * 1200) + " ANSWER-END"
    d = ResearchPlaybook(cp).step(
        session_id="s", run_id="r", agent="user", result={"answer": answer}
    )
    assert "ANSWER-START" in d["task_summary"] and "ANSWER-END" in d["task_summary"]
    assert "[truncated]" not in d["task_summary"]


# ---------------------------------------------------------------------------
# evidence: captured complete, recorded complete
# ---------------------------------------------------------------------------


def test_evidence_is_captured_complete(tmp_path):
    from orchestration.checkpointer import Checkpointer
    from orchestration.playbooks.research import ResearchPlaybook

    cp = Checkpointer(db_path=tmp_path / "o.db")
    pb = ResearchPlaybook(cp)
    pb.start(session_id="s", run_id="r", goal="g", project_root=str(tmp_path))
    long_item = "captured tool output: " + ("z" * 900)
    pb._capture_evidence({"evidence": [long_item] + [f"item {i}" for i in range(9)]})
    ev = pb.ctx.verify_evidence
    assert len(ev) == 10, "every evidence item must be kept"
    assert ev[0] == long_item, "evidence must be verbatim"
