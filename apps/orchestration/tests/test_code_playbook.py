"""Integration tests for the migrated code skill (CodePlaybook) on the engine.

Each step() constructs a FRESH playbook instance pointed at the same checkpointer
(subprocess-per-invocation reality), so these exercise the run_id/checkpointer
contract, the two planned gates, the Ralph-Wiggum retry loop, and the PRD hard
dependency — with NO --state and NO /tmp.
"""

import json

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.code import (
    CodePlaybook,
    _build_verify,
    _discover_repo_commands,
    _latest_ideal_state,
    _try_ideal_state,
)

SID, RID = "sess-code", "run-code"

IDEAL = {
    "goal": "add pagination to the search API",
    "language": "python",
    "success_criteria": ["results are paginated", "page size is configurable"],
    "anti_criteria": ["no breaking API changes"],
    "deliverables": ["search endpoint"],
    "build_order": ["add page params", "wire into query"],
    "verification": {"unit_tests": True},
    "security_review": [],
}


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


# ---------------------------------------------------------------------------
# #10: discover the repo's own verify commands (Makefile / package.json)
# ---------------------------------------------------------------------------


def test_discover_repo_commands_reads_makefile_and_package_json(tmp_path):
    (tmp_path / "Makefile").write_text(
        "test:\n\tpytest -q\n\nlint:\n\truff check .\n\ninstall:\n\tuv sync\n"
    )
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest run", "typecheck": "tsc --noEmit", "dev": "vite"}})
    )
    names = {d["name"] for d in _discover_repo_commands(str(tmp_path))}
    assert "make test" in names and "make lint" in names
    assert "make install" not in names  # not verify-ish -> filtered out
    assert "test" in names and "typecheck" in names
    assert "dev" not in names  # not verify-ish -> filtered out


def test_discover_repo_commands_missing_or_empty_is_empty(tmp_path):
    assert _discover_repo_commands("") == []
    assert _discover_repo_commands(str(tmp_path / "nope")) == []
    assert _discover_repo_commands(str(tmp_path)) == []  # empty dir


def test_build_verify_prefers_discovered_repo_commands(tmp_path):
    (tmp_path / "Makefile").write_text("test:\n\tpytest -q\n")
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.project_root = str(tmp_path)
    directive = _build_verify(ctx, {"language": "python"}, {"verification": {"unit_tests": True}})
    assert "PREFER" in directive and "make test" in directive


def test_build_verify_falls_back_to_language_defaults_when_no_repo_commands(tmp_path):
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.project_root = str(tmp_path)  # empty repo -> nothing declared
    directive = _build_verify(
        ctx, {"language": "python"}, {"verification": {"lint": True, "unit_tests": True}}
    )
    assert "PREFER" not in directive
    assert "ruff check ." in directive and "pytest" in directive


def _start(cp, constraints=None):
    return CodePlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal=IDEAL["goal"],
        constraints=constraints if constraints is not None else {"ideal_state": IDEAL},
    )


def _step(cp, agent, result):
    return CodePlaybook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


# ---------------------------------------------------------------------------
# PRD / IDEAL_STATE (optional)
# ---------------------------------------------------------------------------


def test_start_without_ideal_state_synthesizes_from_goal(cp):
    # PRD is OPTIONAL: with no IDEAL_STATE the run proceeds in goal-driven mode
    # (success criteria synthesized from the goal) rather than hard-erroring.
    d = CodePlaybook(cp).start(session_id=SID, run_id=RID, goal="x", constraints={})
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "echo" and d["state_id"] == "exploring"
    assert not any("PRD dependency not satisfied" in e for e in d.get("errors", []))


def test_start_with_ideal_state_emits_explore(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent"
    assert d["agent"] == "echo" and d["state_id"] == "exploring"
    assert d["run_id"] == RID and "orchestrator_state" not in d


# ---------------------------------------------------------------------------
# Full happy path (both gates, final verify)
# ---------------------------------------------------------------------------


def test_full_walk_with_gates_to_complete(cp):
    _start(cp)
    assert (
        _step(cp, "echo", {"findings_count": 3, "confidence": "PROBABLE"})["state_id"]
        == "analyzing"
    )
    assert (
        _step(cp, "annie", {"risks_identified": 2, "confidence": "PROBABLE"})["state_id"]
        == "checking_criteria"
    )
    # criteria are fine -> straight to planning (no gate)
    assert _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})["state_id"] == "planning"
    # planning routes into the plan-approval gate
    d_gate = _step(cp, "piper", {"plan_complete": True, "confidence": "PROBABLE"})
    assert d_gate["action"] == "escalate_to_user" and d_gate["previous_state"] == "plan_gate"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "plan_gate"
    # approve -> implementing
    assert _step(cp, "user", {"user_response": "approve"})["state_id"] == "implementing"
    assert _step(cp, "skribble", {"confidence": "PROBABLE"})["state_id"] == "verifying"
    # verify passes (with captured evidence) -> learning
    assert (
        _step(
            cp,
            "skribble",
            {"passed": True, "confidence": "PROBABLE", "evidence": ["pytest: 12 passed"]},
        )["state_id"]
        == "learning"
    )
    # learn: no gap -> a final verification battery
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    # final verify passes -> complete, met=True
    d = _step(
        cp,
        "skribble",
        {"passed": True, "confidence": "CERTAIN", "evidence": ["pytest: 12 passed"]},
    )
    assert d["action"] == "complete" and d["result"]["met"] is True
    assert d["result"]["verify_passed"] is True


# ---------------------------------------------------------------------------
# Criteria gate path
# ---------------------------------------------------------------------------


def _advance_to_checking(cp):
    _start(cp)
    _step(cp, "echo", {"findings_count": 1, "confidence": "PROBABLE"})
    _step(cp, "annie", {"risks_identified": 1, "confidence": "PROBABLE"})


def test_criteria_gap_opens_gate_then_accept_resumes_planning(cp):
    _advance_to_checking(cp)
    d = _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": ["criterion 2 is vague"],
            "criteria_issues": {"2": ["not measurable"]},
        },
    )
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "criteria_gate"
    # accept-as-is -> planning
    assert _step(cp, "user", {"user_response": "accept"})["state_id"] == "planning"


def test_criteria_gap_refine_re_runs_carren(cp):
    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    # refine -> back to checking_criteria (re-run carren)
    assert (
        _step(cp, "user", {"user_response": "make criterion 2 measurable"})["state_id"]
        == "checking_criteria"
    )


# ---------------------------------------------------------------------------
# Plan deny -> error (deliberate fix vs. legacy false-complete)
# ---------------------------------------------------------------------------


def _advance_to_plan_gate(cp):
    _start(cp)
    _step(cp, "echo", {"findings_count": 1, "confidence": "PROBABLE"})
    _step(cp, "annie", {"risks_identified": 1, "confidence": "PROBABLE"})
    _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})
    _step(cp, "piper", {"plan_complete": True, "confidence": "PROBABLE"})


def test_plan_deny_terminates_in_error(cp):
    _advance_to_plan_gate(cp)
    d = _step(cp, "user", {"user_response": "deny"})
    assert d["action"] == "error"
    assert any("denied" in e for e in d["errors"])


def test_plan_refine_routes_back_to_planning(cp):
    _advance_to_plan_gate(cp)
    assert _step(cp, "user", {"user_response": "use cursor-based paging"})["state_id"] == "planning"


# ---------------------------------------------------------------------------
# Ralph-Wiggum retry loop + budget exhaustion
# ---------------------------------------------------------------------------


_VERIFY_PASS = {"passed": True, "confidence": "PROBABLE", "evidence": ["pytest: 12 passed"]}


def _verify_fail(tag):
    """A contract-compliant FAILING verify SUMMARY (evidence-bearing)."""
    return {
        "passed": False,
        "confidence": "PROBABLE",
        "evidence": [f"pytest: {tag} failed"],
        "failures": [f"unresolved: {tag}"],
    }


def _advance_to_learning(cp):
    _advance_to_plan_gate(cp)
    _step(cp, "user", {"user_response": "approve"})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing
    _step(cp, "skribble", _VERIFY_PASS)  # verifying -> learning


def _back_to_learning(cp, findings, strategy_change):
    """implementing -> verifying -> learning again, carrying a LEARN retry."""
    _step(cp, "carren", {"gap": True, "findings": findings, "strategy_change": strategy_change})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    _step(cp, "skribble", _VERIFY_PASS)  # verifying -> learning


def test_learn_gap_loops_back_to_implement(cp):
    _advance_to_learning(cp)
    d = _step(
        cp, "carren", {"gap": True, "findings": ["criterion 2 unmet"], "strategy_change": "add x"}
    )
    assert d["state_id"] == "implementing"
    # the gap findings are injected into the next implement task
    assert "criterion 2 unmet" in d["task_summary"]


def test_verify_missing_passed_field_is_contract_violation(cp):
    _advance_to_plan_gate(cp)
    _step(cp, "user", {"user_response": "approve"})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    # verify SUMMARY missing required 'passed' -> bounded retry re-issues verifying
    d = _step(cp, "skribble", {"confidence": "PROBABLE", "evidence": ["x"]})
    assert d["action"] == "invoke_agent" and d["state_id"] == "verifying"


def test_verify_without_evidence_is_contract_violation(cp):
    # Externally-grounded VERIFY (Rec 4): a PASS with no captured evidence is a
    # contract violation and re-issues the verify step rather than advancing.
    _advance_to_plan_gate(cp)
    _step(cp, "user", {"user_response": "approve"})
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    d = _step(cp, "skribble", {"passed": True, "confidence": "PROBABLE", "evidence": []})
    assert d["action"] == "invoke_agent" and d["state_id"] == "verifying"


def test_final_verify_loop_exhausts_honestly(cp):
    # DEFECT 1 (loop honesty): learn keeps reporting no gap while the FINAL
    # verify keeps failing (on DIFFERENT issues, so the no-progress stall guard
    # does not fire). The battery is BOUNDED — after FINAL_VERIFY_CAP attempts it
    # completes HONESTLY (met=False) with the unresolved failures reported,
    # rather than spinning to the global STEP_CAP with a generic error.
    _advance_to_learning(cp)
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    assert _step(cp, "skribble", _verify_fail("alpha"))["state_id"] == "learning"
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    assert _step(cp, "skribble", _verify_fail("beta"))["state_id"] == "learning"
    assert _step(cp, "carren", {"gap": False})["state_id"] == "verifying"
    assert _step(cp, "skribble", _verify_fail("gamma"))["state_id"] == "learning"
    # The battery is spent: the next no-gap learn does NOT request another final
    # verify — it completes honestly.
    d = _step(cp, "carren", {"gap": False})
    assert d["action"] == "complete"
    assert d["result"]["met"] is False
    assert d["result"]["verify_passed"] is False
    assert d["result"]["learn_gap"] is False
    assert d["result"]["final_verify_exhausted"] is True
    assert d["result"]["unresolved_failures"] == ["unresolved: gamma"]


def test_final_verify_stall_escalates_on_repeated_failures(cp):
    # DEFECT 1 (loop honesty): when the FINAL verify keeps failing on the SAME
    # issue while learn keeps reporting no gap, progress_check escalates the
    # learn/verify disagreement to the user — stall detection is NOT gated behind
    # gap truthiness. The run never spins to the global STEP_CAP.
    _advance_to_learning(cp)
    same = _verify_fail("same")
    d = None
    for _ in range(6):
        d = _step(cp, "carren", {"gap": False})
        if d["action"] == "escalate_to_user":
            break
        assert d["state_id"] == "verifying"
        assert _step(cp, "skribble", same)["state_id"] == "learning"
    assert d["action"] == "escalate_to_user"
    assert "disagreement" in d["unknown_reason"]


def test_repeated_retry_strategy_escalates(cp):
    # Anti-paralysis (Rec 1): a second retry that repeats the same strategy
    # escalates to the user instead of spinning through the budget.
    _advance_to_learning(cp)
    # iteration 0: gap with a strategy -> loops back to implementing
    assert (
        _step(cp, "carren", {"gap": True, "findings": ["slow"], "strategy_change": "add an index"})[
            "state_id"
        ]
        == "implementing"
    )
    _step(cp, "skribble", {"confidence": "PROBABLE"})  # implementing -> verifying
    _step(cp, "skribble", _VERIFY_PASS)  # verifying -> learning
    # iteration 1: same strategy -> escalate
    d = _step(
        cp, "carren", {"gap": True, "findings": ["still slow"], "strategy_change": "add an INDEX"}
    )
    assert d["action"] == "escalate_to_user"


# ---------------------------------------------------------------------------
# Recovery re-presents a pending gate
# ---------------------------------------------------------------------------


def test_recovery_re_presents_plan_gate(cp):
    from orchestration.recovery import recover_pending

    _advance_to_plan_gate(cp)
    directives = recover_pending(cp, session_id=SID, playbook="code")
    assert len(directives) == 1 and directives[0]["action"] == "escalate_to_user"
    assert directives[0]["previous_state"] == "plan_gate"


# ---------------------------------------------------------------------------
# Chunked IDEAL_STATE reassembly (prd_room chain-fallback)
#
# The memory bridge splits content > 4000 chars into NON-overlapping 2000-char
# sibling chunks sharing a drawer_key, ordered by chunk_index. A chunked
# IDEAL_STATE is invalid JSON per-chunk, so the loader must reassemble it.
# ---------------------------------------------------------------------------

_BRIDGE_CHUNK_SIZE = 2000  # mirrors scripts/system/bridge/memory_bridge.py::_CHUNK_SIZE


def _bridge_chunk(text: str, size: int = _BRIDGE_CHUNK_SIZE) -> list:
    """Clean, non-overlapping split identical to the memory bridge's _chunk_text."""
    return [text[i : i + size] for i in range(0, len(text), size)]


def _drawer_docs(ideal: dict, drawer_key: str, filed_at: str):
    """Return (documents, metadatas) exactly as MemPalace stores a chunked drawer."""
    chunks = _bridge_chunk(json.dumps(ideal))
    metas = [
        {
            "drawer_key": drawer_key,
            "chunk_index": i,
            "filed_at": filed_at,
            "room": "skills/prd-x",
            "wing": "penny",
        }
        for i in range(len(chunks))
    ]
    return list(chunks), metas


def test_latest_ideal_state_reassembles_chunked_drawer():
    ideal = {
        "goal": "g",
        # long enough to force a multi-chunk split (> 4000 chars)
        "success_criteria": ["a" * 1500, "b" * 1500, "c" * 1500],
        "build_order": ["step 1"],
    }
    docs, metas = _drawer_docs(ideal, "drawer_penny_skills/prd-x_hash", "2026-07-09T00:00:00")
    assert len(docs) >= 2  # genuinely chunked
    # sanity: a lone chunk is NOT valid JSON, so per-chunk parsing (the old bug) fails
    with pytest.raises(json.JSONDecodeError):
        json.loads(docs[0])
    got = _latest_ideal_state(docs, metas)
    assert got is not None
    assert got["success_criteria"] == ideal["success_criteria"]
    assert got["build_order"] == ["step 1"]


def test_latest_ideal_state_reassembles_out_of_order_chunks():
    ideal = {"success_criteria": ["x" * 1500, "y" * 1500], "goal": "g"}
    docs, metas = _drawer_docs(ideal, "k", "2026-07-09T00:00:00")
    assert len(docs) >= 2
    # reverse the on-the-wire order; chunk_index metadata must still order them
    docs_rev = list(reversed(docs))
    metas_rev = list(reversed(metas))
    got = _latest_ideal_state(docs_rev, metas_rev)
    assert got is not None and got["success_criteria"] == ideal["success_criteria"]


def test_latest_ideal_state_prefers_newest_filed_at():
    v1 = {"version": "v1", "success_criteria": ["old" * 700]}
    v2 = {"version": "v2", "success_criteria": ["new" * 700]}
    d1, m1 = _drawer_docs(v1, "key-v1", "2026-07-09T10:00:00")
    d2, m2 = _drawer_docs(v2, "key-v2", "2026-07-09T15:00:00")  # newer
    got = _latest_ideal_state(d1 + d2, m1 + m2)
    assert got is not None and got["version"] == "v2"


def test_latest_ideal_state_unchunked_single_drawer():
    ideal = {"success_criteria": ["small"], "goal": "y"}
    text = json.dumps(ideal)
    assert len(text) < 4000  # single, unchunked drawer
    got = _latest_ideal_state([text], [{"drawer_key": "k", "chunk_index": 0}])
    assert got == ideal


def test_latest_ideal_state_none_for_non_ideal_documents():
    docs = ["# PRD narrative section 1 ...", json.dumps({"requirements": ["FR-1"]})]
    metas = [{"drawer_key": "n", "chunk_index": 0}, {"drawer_key": "r", "chunk_index": 0}]
    assert _latest_ideal_state(docs, metas) is None


def test_latest_ideal_state_handles_missing_metadata():
    ideal = {"success_criteria": ["z"], "goal": "q"}
    text = json.dumps(ideal)
    assert _latest_ideal_state([text], [{}]) == ideal  # no drawer_key -> solo group
    assert _latest_ideal_state([text], []) == ideal  # metadatas absent entirely


def test_latest_ideal_state_empty_inputs():
    assert _latest_ideal_state([], []) is None
    assert _latest_ideal_state(None, None) is None


# ---------------------------------------------------------------------------
# Header/preface tolerance: the prd skill stores each artifact drawer with a
# title line ("<sid> IDEAL_STATE\n\n{json}") and, for revised artifacts, a
# prose CHANGE-LOG preface before the JSON. The whole drawer is therefore NOT
# valid JSON, so a strict json.loads (the old behaviour) failed to resolve a
# perfectly valid IDEAL_STATE. _try_ideal_state must tolerate the wrapper.
# ---------------------------------------------------------------------------

_IDEAL = {
    "goal": "ship the thing",
    "success_criteria": ["c1 is measurable", "c2 is testable"],
    "build_order": ["step 1"],
}


def _wrap(ideal: dict, header: str) -> str:
    """Reproduce how the prd skill stores an artifact drawer: a title/preface
    line, a blank line, then the JSON body."""
    return f"{header}\n\n{json.dumps(ideal)}"


def test_try_ideal_state_pure_json_fast_path():
    # Backwards compatibility: a pure-JSON drawer still resolves unchanged.
    assert _try_ideal_state(json.dumps(_IDEAL)) == _IDEAL


def test_try_ideal_state_title_wrapped():
    text = _wrap(_IDEAL, "plan-abc123 IDEAL_STATE")
    assert _try_ideal_state(text) == _IDEAL


def test_try_ideal_state_change_log_preface_wrapped():
    header = (
        "plan-abc123 IDEAL_STATE\n\nCHANGE LOG PREFACE (read this before the JSON "
        "below): the deliverables array now enumerates all fifteen paths; every "
        "other field carries forward unchanged."
    )
    text = _wrap(_IDEAL, header)
    assert _try_ideal_state(text) == _IDEAL


def test_try_ideal_state_preface_with_braces_is_tolerated():
    # A brace in the prose that does not open valid JSON must be stepped over.
    header = "plan-x IDEAL_STATE\n\nUse the {placeholder} token; see notes {here}."
    text = _wrap(_IDEAL, header)
    assert _try_ideal_state(text) == _IDEAL


def test_try_ideal_state_rejects_wrapped_requirement_catalog():
    # A Requirement Catalog is a JSON ARRAY of REQ dicts (no success_criteria).
    catalog = [{"id": "REQ-001", "priority": "P0", "acceptance_criteria": ["x"]}]
    text = f"plan-x Requirement Catalog\n\n{json.dumps(catalog)}"
    assert _try_ideal_state(text) is None


def test_try_ideal_state_rejects_wrapped_verification_matrix():
    # A Verification Matrix is a JSON MAP keyed by REQ id (no success_criteria).
    matrix = {"REQ-001": {"unit_tests": ["t"]}}
    text = f"plan-x Verification Matrix\n\n{json.dumps(matrix)}"
    assert _try_ideal_state(text) is None


def test_try_ideal_state_rejects_pure_prose():
    assert _try_ideal_state("# PRD Narrative\n\nThis is prose with no JSON body.") is None


def test_latest_ideal_state_resolves_title_wrapped_chunked_drawer():
    # End-to-end: a wrapped IDEAL_STATE large enough to be chunked by the bridge
    # must reassemble AND tolerate the title/preface wrapper.
    big = {
        "goal": "g",
        "success_criteria": ["a" * 1500, "b" * 1500, "c" * 1500],
        "build_order": ["step 1"],
    }
    header = "plan-abc IDEAL_STATE\n\nCHANGE LOG PREFACE: revised."
    wrapped = _wrap(big, header)
    chunks = _bridge_chunk(wrapped)
    assert len(chunks) >= 2  # genuinely chunked
    metas = [
        {"drawer_key": "dk", "chunk_index": i, "filed_at": "2026-07-10T00:00:00"}
        for i in range(len(chunks))
    ]
    got = _latest_ideal_state(list(chunks), metas)
    assert got is not None
    assert got["success_criteria"] == big["success_criteria"]
    assert got["build_order"] == ["step 1"]
