"""Tests for Recall (atom F2) — run-start lesson retrieval and first-directive
injection: best-effort contract (failures return []), opt-outs, pytest guard on
the default MemPalace path, checkpointer round-trip, and advisory-only wiring
(lessons ride ONLY the first directive and never touch routing).
"""

from statemachine import State, StateMachine

from orchestration.checkpointer import Checkpointer
from orchestration.context import RunContext
from orchestration.engine import BasePlaybook
from orchestration.primitives.spec import PrimitiveSpec
from orchestration.recall import MAX_LESSONS, recall_lessons

SID, RID = "sess-recall", "run-recall"


def _ctx(constraints=None):
    return RunContext(
        session_id=SID,
        run_id=RID,
        playbook="tiny",
        goal="do a thing",
        constraints=constraints or {},
    )


# ---------------------------------------------------------------------------
# recall_lessons unit behavior
# ---------------------------------------------------------------------------


def test_injected_search_fn_returns_capped_lessons():
    lessons = recall_lessons(_ctx(), search_fn=lambda q, n: ["lesson A", "  lesson B  ", ""])
    assert lessons == ["lesson A", "lesson B"]


def test_lesson_count_is_bounded():
    lessons = recall_lessons(_ctx(), search_fn=lambda q, n: [f"l{i}" for i in range(10)])
    assert len(lessons) == MAX_LESSONS


def test_lesson_length_is_bounded_and_single_line():
    lessons = recall_lessons(_ctx(), search_fn=lambda q, n: ["x" * 1000 + "\nmultiline"])
    assert len(lessons) == 1
    assert "\n" not in lessons[0]
    assert lessons[0].endswith("…[truncated]")


def test_search_failure_returns_empty():
    def boom(q, n):
        raise RuntimeError("bridge down")

    assert recall_lessons(_ctx(), search_fn=boom) == []


def test_env_opt_out(monkeypatch):
    monkeypatch.setenv("PENNY_RECALL", "0")
    assert recall_lessons(_ctx(), search_fn=lambda q, n: ["lesson"]) == []


def test_constraint_opt_out():
    ctx = _ctx(constraints={"recall": False})
    assert recall_lessons(ctx, search_fn=lambda q, n: ["lesson"]) == []


def test_default_path_is_inert_under_pytest():
    """With no injected search_fn, the MemPalace-backed default is skipped under
    pytest — a unit test can never touch the real palace by accident."""
    assert recall_lessons(_ctx()) == []


def test_query_names_playbook_and_goal():
    seen = {}

    def spy(query, limit):
        seen["query"] = query
        return []

    recall_lessons(_ctx(), search_fn=spy)
    assert "tiny" in seen["query"] and "do a thing" in seen["query"]


# ---------------------------------------------------------------------------
# Engine wiring: first-directive injection + durability + advisory-only
# ---------------------------------------------------------------------------


class RecallMachine(StateMachine):
    intake = State(initial=True)
    working = State()
    reviewing = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(working)
    work_done = working.to(reviewing)
    review_done = reviewing.to(complete)
    to_unknown = working.to(unknown) | reviewing.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(working)
    abort = (
        working.to(error)
        | reviewing.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


C = {"required": {"done": bool, "confidence": str}, "optional": {}}


class RecallPlaybook(BasePlaybook):
    NAME = "recall-test"
    machine_cls = RecallMachine
    PRIMITIVE_BY_STATE = {
        "working": PrimitiveSpec("WORK", "skribble", C, "work"),
        "reviewing": PrimitiveSpec("REVIEW", "vera", C, "review"),
    }
    ESCALATABLE_STATES = frozenset({"working", "reviewing"})

    def initial_transition(self, ctx):
        # Simulate the engine's recall seeding for tests (the real seam is
        # recall_lessons() in start(), inert under pytest by design).
        ctx.recall_lessons = list(ctx.constraints.get("_test_lessons", []))
        self.sm.send("start")
        return "working"

    def route_after(self, state, ctx, summary):
        self.sm.send("work_done" if state == "working" else "review_done")


def test_lessons_ride_only_the_first_directive(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    d = RecallPlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal="g",
        constraints={"_test_lessons": ["prefer smaller diffs"]},
    )
    assert d["action"] == "invoke_agent"
    assert "Lessons from prior runs (advisory" in d["task_summary"]
    assert "prefer smaller diffs" in d["task_summary"]
    # Second directive (after the first result) carries NO lessons.
    d2 = RecallPlaybook(cp).step(
        session_id=SID, run_id=RID, agent="skribble", result={"done": True, "confidence": "CERTAIN"}
    )
    assert d2["action"] == "invoke_agent"
    assert "Lessons from prior runs" not in d2["task_summary"]


def test_lessons_survive_the_checkpointer(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    RecallPlaybook(cp).start(
        session_id=SID, run_id=RID, goal="g", constraints={"_test_lessons": ["lesson X"]}
    )
    rec = cp.load(RID)
    assert rec.context.recall_lessons == ["lesson X"]


def test_no_lessons_no_injection(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    d = RecallPlaybook(cp).start(session_id=SID, run_id=RID, goal="g")
    assert "Lessons from prior runs" not in d["task_summary"]
