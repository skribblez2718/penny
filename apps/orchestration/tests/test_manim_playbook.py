"""Integration tests for the manim skill (ManimPlaybook) on the engine.

Each step() constructs a FRESH playbook instance pointed at the same
checkpointer (subprocess-per-invocation reality). The three external-effect
seams (``_load_primitive_schema``, ``_ensure_output_dir``, ``_narrate``) are
stubbed, so no Voice Studio, no schema file, and no filesystem coupling beyond
tmp_path — the suite is hermetic.

Coverage: start() contract enforcement (lesson_path / output_dir /
primitive_schema required), caller-supplied ingest topology skipping scoping,
model-emitted scoping topology, the canon gate's three routes
(approve/refine/deny), scene-count clamping to max_scenes, narration via the
seam + the estimation fallback (allow_estimated_durations) + the actionable
failure without it, the per-scene authoring self-loop, the verify ⇄ fix loop
with honest exhaustion (met=False, never a fabricated pass), critique-driven
fixes re-entering verification, needs-clarification escalation, and the
dual-format result payload.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks import get_playbook
from orchestration.playbooks.manim import ManimPlaybook, _estimate_duration

SID, RID = "sess-manim", "run-manim"

FAKE_SCHEMA = {
    "schema": "superpose/primitives",
    "version": "0.1.0",
    "themes": {"quantum-dark": {}, "quantum-light": {}},
    "primitives": [
        {"name": "TitleCard", "params": {"title": {"type": "string", "required": True}}},
        {"name": "BlochSphere", "params": {"state": {"type": "string", "required": False}}},
    ],
}

SCOPE_OK = {
    "scope_complete": True,
    "ingest_branches": {"concepts": "the ideas taught", "equations": "the math"},
    "confidence": "CERTAIN",
}
CANON_OK = {
    "canon_complete": True,
    "scene_count": 3,
    "confidence": "CERTAIN",
    "video_title": "Superposition",
    "theme": "quantum-dark",
    "open_questions": [],
}
STORYBOARD_OK = {
    "storyboard_complete": True,
    "scene_ids": ["s01-intro", "s02-bloch", "s03-hadamard"],
    "confidence": "CERTAIN",
}
AUTHOR_OK = lambda i, sid: {  # noqa: E731
    "scene_complete": True,
    "scene_id": sid,
    "scene_index": i,
    "confidence": "CERTAIN",
    "file_written": f"scenes/{sid.replace('-', '_')}.py",
}
VERIFY_PASS = {
    "verdict": "PASS",
    "violations": [],
    "evidence": ["validate_bundle.py: ok=true, 3 scenes, 0 violations"],
    "confidence": "CERTAIN",
}
CRITIQUE_OK = {
    "verdict": "APPROVE",
    "evidence": ["s01: title matches canon register; pacing covers narration"],
    "confidence": "CERTAIN",
}
PACKAGE_OK = {
    "package_complete": True,
    "bundle_path": "/tmp/manim-test/video",
    "confidence": "CERTAIN",
    "degraded_scenes": [],
}
FIX_OK = {"fixes_complete": True, "confidence": "CERTAIN", "fixed": ["x"]}


def _verify_fail(*violations):
    return {
        "verdict": "FAIL",
        "violations": list(violations),
        "evidence": ["validate_bundle.py: ok=false"],
        "confidence": "CERTAIN",
    }


class FakeManim(ManimPlaybook):
    NAME = "manim"
    narrate_error: Exception | None = None

    def _load_primitive_schema(self, ctx, schema_path):
        return dict(FAKE_SCHEMA)

    def _ensure_output_dir(self, ctx, requested):
        Path(requested).mkdir(parents=True, exist_ok=True)
        return requested

    def _narrate(self, ctx, scenes, voice_id):
        if self.narrate_error is not None:
            raise self.narrate_error
        return {str(s.get("scene_id")): 10.0 for s in scenes}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


@pytest.fixture
def constraints(tmp_path):
    lesson = tmp_path / "lesson"
    lesson.mkdir()
    (lesson / "lesson.md").write_text("# Superposition\n$$|+\\rangle$$")
    out = tmp_path / "bundles"
    return {
        "lesson_path": str(lesson),
        "output_dir": str(out),
        "primitive_schema": str(tmp_path / "primitives.json"),
        "video_id": "qc-demo",
    }


def _write_storyboard(constraints):
    """The storyboarding agent writes storyboard.json; tests do it for it."""
    bundle = Path(constraints["output_dir"]) / "qc-demo"
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "storyboard.json").write_text(
        json.dumps(
            {
                "video_id": "qc-demo",
                "title": "Superposition",
                "theme": "quantum-dark",
                "scenes": [
                    {"scene_id": sid, "narration": f"narration {sid}", "visuals": []}
                    for sid in ("s01-intro", "s02-bloch", "s03-hadamard")
                ],
            }
        )
    )
    return bundle


def _start(cp, constraints, goal="Produce the superposition video bundle", cls=FakeManim):
    return cls(cp).start(session_id=SID, run_id=RID, goal=goal, constraints=dict(constraints))


def _step(cp, agent, result, cls=FakeManim):
    return cls(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _ingest_batch(branches=("concepts", "equations"), complete=True):
    return [
        {
            "branch_id": b,
            "agent": "echo",
            "exitCode": 0,
            "summary": {"ingest_complete": complete, "confidence": "CERTAIN"},
        }
        for b in branches
    ]


def _to_gate(cp, constraints):
    _start(cp, constraints)
    _step(cp, "echo", SCOPE_OK)
    _step(cp, "__parallel__", _ingest_batch())
    return _step(cp, "annie", CANON_OK)


def _to_authoring(cp, constraints, cls=FakeManim):
    _to_gate(cp, constraints)
    _step(cp, "user", {"user_response": "approve"})
    _write_storyboard(constraints)
    # storyboarding agent -> narrating TOOL runs inline -> authoring
    return _step(cp, "piper", STORYBOARD_OK, cls=cls)


def _author_all(cp, constraints):
    directive = _to_authoring(cp, constraints)
    for i, sid in enumerate(STORYBOARD_OK["scene_ids"]):
        directive = _step(cp, "skribble", AUTHOR_OK(i, sid))
    return directive


# ---------------------------------------------------------------------------
# start() contract
# ---------------------------------------------------------------------------


def test_registered():
    assert get_playbook("manim") is ManimPlaybook


@pytest.mark.parametrize("missing", ["lesson_path", "output_dir", "primitive_schema"])
def test_start_requires_constraints(cp, constraints, missing):
    bad = dict(constraints)
    del bad[missing]
    directive = _start(cp, bad)
    assert directive["action"] == "error"
    assert any(missing in str(e) for e in directive["errors"])


def test_start_routes_to_scoping(cp, constraints):
    directive = _start(cp, constraints)
    assert directive["action"] == "invoke_agent"
    assert directive["agent"] == "echo"
    assert directive["state_id"] == "scoping"
    assert "echo-scope" in (directive.get("skillContext") or "")


def test_caller_topology_skips_scoping(cp, constraints):
    directive = _start(
        cp, {**constraints, "ingest_branches": {"all": "everything in one pass"}}
    )
    assert directive["action"] == "invoke_agents_parallel"
    assert directive["state_id"] == "ingesting"
    assert [t["agent"] for t in directive["tasks"]] == ["echo"]


def test_scoping_emits_topology(cp, constraints):
    _start(cp, constraints)
    directive = _step(cp, "echo", SCOPE_OK)
    assert directive["action"] == "invoke_agents_parallel"
    assert {t["branch_id"] for t in directive["tasks"]} == {"concepts", "equations"}
    assert all(t["agent"] == "echo" for t in directive["tasks"])


# ---------------------------------------------------------------------------
# canon gate
# ---------------------------------------------------------------------------


def test_gate_pauses_for_user(cp, constraints):
    directive = _to_gate(cp, constraints)
    assert directive["action"] == "escalate_to_user"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "canon_gate"


def test_gate_approve_routes_to_storyboarding(cp, constraints):
    _to_gate(cp, constraints)
    directive = _step(cp, "user", {"user_response": "approve"})
    assert directive["action"] == "invoke_agent"
    assert directive["state_id"] == "storyboarding"
    assert directive["agent"] == "piper"


def test_gate_refine_returns_to_design_with_note(cp, constraints):
    _to_gate(cp, constraints)
    directive = _step(cp, "user", {"user_response": "fewer scenes, focus on the H gate"})
    assert directive["action"] == "invoke_agent"
    assert directive["state_id"] == "designing_canon"
    assert "fewer scenes" in directive["task_summary"]


def test_gate_deny_terminates(cp, constraints):
    _to_gate(cp, constraints)
    directive = _step(cp, "user", {"user_response": "deny"})
    assert directive["action"] == "error"


def test_scene_count_clamped_to_max_scenes(cp, constraints):
    _start(cp, {**constraints, "max_scenes": 2})
    _step(cp, "echo", SCOPE_OK)
    _step(cp, "__parallel__", _ingest_batch())
    _step(cp, "annie", {**CANON_OK, "scene_count": 15})
    rec = cp.load(RID)
    assert rec.context.extras["manim"]["scene_count"] == 2


# ---------------------------------------------------------------------------
# narrating (TOOL) — audio-first
# ---------------------------------------------------------------------------


def test_narration_measures_and_attaches_durations(cp, constraints):
    directive = _to_authoring(cp, constraints)
    # narration ran inline; authoring is next with scene 0
    assert directive["state_id"] == "authoring"
    assert "s01-intro" in directive["task_summary"]
    bundle = Path(constraints["output_dir"]) / "qc-demo"
    sb = json.loads((bundle / "storyboard.json").read_text())
    assert all(s["measured_duration"] == 10.0 for s in sb["scenes"])


def test_voice_studio_down_is_actionable_error(cp, constraints):
    class Down(FakeManim):
        narrate_error = RuntimeError("Voice Studio unreachable at http://127.0.0.1:8001")

    _to_gate(cp, constraints)
    _step(cp, "user", {"user_response": "approve"})
    _write_storyboard(constraints)
    directive = _step(cp, "piper", STORYBOARD_OK, cls=Down)
    assert directive["action"] == "error"
    assert any("allow_estimated_durations" in str(e) for e in directive["errors"])


def test_estimation_fallback_flags_degraded(cp, constraints):
    class Down(FakeManim):
        narrate_error = RuntimeError("unreachable")

    _start(cp, {**constraints, "allow_estimated_durations": True})
    _step(cp, "echo", SCOPE_OK)
    _step(cp, "__parallel__", _ingest_batch())
    _step(cp, "annie", CANON_OK)
    _step(cp, "user", {"user_response": "approve"})
    _write_storyboard(constraints)
    directive = _step(cp, "piper", STORYBOARD_OK, cls=Down)
    assert directive["action"] == "invoke_agent"  # proceeded to authoring
    bundle = Path(constraints["output_dir"]) / "qc-demo"
    sb = json.loads((bundle / "storyboard.json").read_text())
    assert all(s.get("narration_estimated") for s in sb["scenes"])
    assert all(s["measured_duration"] >= 3.0 for s in sb["scenes"])


def test_estimate_duration_floor():
    assert _estimate_duration("") == 3.0
    assert _estimate_duration("word " * 100) > 30.0


# ---------------------------------------------------------------------------
# authoring self-loop
# ---------------------------------------------------------------------------


def test_authoring_loops_per_scene_then_verifies(cp, constraints):
    directive = _to_authoring(cp, constraints)
    assert "scene index 0" in directive["task_summary"]
    directive = _step(cp, "skribble", AUTHOR_OK(0, "s01-intro"))
    assert directive["state_id"] == "authoring"
    assert "scene index 1" in directive["task_summary"]
    directive = _step(cp, "skribble", AUTHOR_OK(1, "s02-bloch"))
    assert "scene index 2" in directive["task_summary"]
    directive = _step(cp, "skribble", AUTHOR_OK(2, "s03-hadamard"))
    assert directive["state_id"] == "verifying"
    assert directive["agent"] == "vera"
    assert "validate_bundle.py" in directive["task_summary"]


# ---------------------------------------------------------------------------
# verify ⇄ fix, critique, packaging
# ---------------------------------------------------------------------------


def test_happy_path_to_complete_met_true(cp, constraints):
    _author_all(cp, constraints)
    _step(cp, "vera", VERIFY_PASS)
    _step(cp, "carren", CRITIQUE_OK)
    directive = _step(cp, "synthia", PACKAGE_OK)
    assert directive["action"] == "complete"
    assert directive["result"]["met"] is True
    assert directive["result"]["bundle_path"] == PACKAGE_OK["bundle_path"]
    assert "READY" in directive["result"]["human"]


def test_verify_fail_routes_to_fixing_and_back(cp, constraints):
    _author_all(cp, constraints)
    directive = _step(
        cp, "vera", _verify_fail("scenes/s01_intro.py: TitleCard missing required 'title'")
    )
    assert directive["state_id"] == "fixing"
    assert "missing required" in directive["task_summary"]
    directive = _step(cp, "skribble", FIX_OK)
    assert directive["state_id"] == "verifying"  # fixes ALWAYS re-verify


def test_verify_exhaustion_packages_met_false(cp, constraints):
    _author_all(cp, constraints)
    # distinct violations per round so the stall guard doesn't fire first
    for i in range(2):
        _step(cp, "vera", _verify_fail(f"scenes/s02_bloch.py: distinct violation {i}"))
        _step(cp, "skribble", {**FIX_OK, "strategy_change": f"attempt {i}"})
    directive = _step(cp, "vera", _verify_fail("scenes/s02_bloch.py: final violation"))
    assert directive["state_id"] == "packaging"
    directive = _step(cp, "synthia", {**PACKAGE_OK, "degraded_scenes": ["s02-bloch"]})
    assert directive["action"] == "complete"
    assert directive["result"]["met"] is False
    assert directive["result"]["unresolved"] == ["scenes/s02_bloch.py: final violation"]
    assert "s02-bloch" in directive["result"]["degraded_scenes"]


def test_critique_revision_reenters_fix_then_verify(cp, constraints):
    _author_all(cp, constraints)
    _step(cp, "vera", VERIFY_PASS)
    directive = _step(
        cp,
        "carren",
        {
            "verdict": "NEEDS_REVISION",
            "evidence": ["s03: bars appear before the gate is explained"],
            "rework": ["s03-hadamard: reorder beats — gate before bars"],
            "confidence": "CERTAIN",
        },
    )
    assert directive["state_id"] == "fixing"
    directive = _step(cp, "skribble", FIX_OK)
    assert directive["state_id"] == "verifying"


def test_unknown_verdict_is_parseable_error(cp, constraints):
    _author_all(cp, constraints)
    directive = _step(cp, "vera", {**VERIFY_PASS, "verdict": "MAYBE"})
    assert directive["action"] == "error"


# ---------------------------------------------------------------------------
# escalation
# ---------------------------------------------------------------------------


def test_needs_clarification_escalates(cp, constraints):
    _start(cp, constraints)
    _step(cp, "echo", SCOPE_OK)
    _step(cp, "__parallel__", _ingest_batch())
    directive = _step(
        cp,
        "annie",
        {
            **CANON_OK,
            "needs_clarification": True,
            "clarifying_questions": ["Which audience level?"],
        },
    )
    assert directive["action"] == "escalate_to_user"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
