"""Integration tests for the migrated code skill (CodePlaybook) on the engine.

Each step() constructs a FRESH playbook instance pointed at the same checkpointer
(subprocess-per-invocation reality), so these exercise the run_id/checkpointer
contract, the two planned gates, the Ralph-Wiggum retry loop, and the PRD hard
dependency — with NO --state and NO /tmp.
"""

import json
from pathlib import Path
from copy import deepcopy

import pytest

import orchestration.playbooks.code as code_mod
from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.context import RunContext
from orchestration.playbooks.code import (
    CodePlaybook,
    _build_verify,
    _discover_repo_commands,
    _trusted_disposition_from_draft,
    _ideal_state_validation_errors,
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


def _head_synthesized_ideal(*, runtime_overlay: bool = True) -> dict:
    """Exact standalone shape emitted by HEAD before the revision ledger existed."""
    verification = {}
    if runtime_overlay:
        verification = {
            "server_startup": True,
            "server_framework": "fastapi",
            "server_entry_points": ["app.py"],
            "server_evidence": "fastapi in the persisted pre-patch project",
        }
    return {
        "success_criteria": [
            f"The goal is fully implemented as stated: {IDEAL['goal']}",
            "New and changed behavior is covered by tests that pass at the applicable tiers.",
            "The change follows the repository's coding standards and introduces no regressions.",
        ],
        "deliverables": [],
        "verification": verification,
        "_synthesized_from_goal": True,
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


def test_build_verify_uses_selected_profile_not_ambient_repo_commands(tmp_path):
    (tmp_path / "Makefile").write_text("test:\n\tmalicious-unselected-hook\n")
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.project_root = str(tmp_path)
    directive = _build_verify(
        ctx,
        {"target_profile": {"verification_commands": ["make test"]}},
        {"verification": {"unit_tests": True}},
    )
    assert "make test" in directive
    assert "malicious-unselected-hook" not in directive
    assert "selected target profile" in directive


def test_p0_build_verify_uses_only_selected_profile_and_manifest_commands(tmp_path):
    (tmp_path / "Makefile").write_text("test:\n\tmalicious-unselected-hook\n")
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.project_root = str(tmp_path)
    directive = _build_verify(
        ctx,
        {
            "p0_enabled": True,
            "language": "Go",
            "target_profile": {"verification_commands": ["go test ./..."]},
            "p0_verification_commands": ["go vet ./..."],
        },
        {"verification": {"unit_tests": True}},
    )
    assert "go test ./..." in directive and "go vet ./..." in directive
    assert "malicious-unselected-hook" not in directive
    assert "pytest tests/" not in directive and "bun vitest" not in directive
    assert "do not substitute a language fallback" in directive


def test_p0_learning_routes_to_a_model_distinct_from_the_implementation_actor(cp, monkeypatch):
    monkeypatch.setattr(code_mod, "agent_model", lambda agent: "sol")
    monkeypatch.setattr(code_mod, "distinct_models", lambda: ("sol", "terra"))
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.extras["code"] = {"p0_enabled": True}

    assert CodePlaybook(cp).model_for_state("learning", ctx) == "terra"
    assert CodePlaybook(cp).model_for_state("verifying", ctx) is None


def test_independent_disposition_authority_is_injected_from_trusted_invocations(cp):
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.extras["trusted_invocations"] = {
        "implementing": {
            "invocation_id": "implement-1",
            "agent_identity": "agent:skribble",
            "model": "openai-codex/sol",
            "ended_at": "2026-08-02T00:00:01+00:00",
        },
        "verifying": {
            "invocation_id": "verify-1",
            "agent_identity": "agent:skribble",
            "model": "openai-codex/sol",
            "ended_at": "2026-08-02T00:00:02+00:00",
        },
        "learning": {
            "invocation_id": "learn-1",
            "agent_identity": "agent:carren",
            "model": "openai-codex/terra",
            "ended_at": "2026-08-02T00:00:03+00:00",
        },
    }
    draft = {
        "obligation_id": "quality:unnecessary_complexity_avoidance",
        "finding_id": None,
        "evidence_refs": ["implementation-1"],
        "rationale": "No unnecessary abstraction remains.",
        "final_disposition": "satisfied",
        "reviewer_identity": "agent:forged",
        "reviewer_model": "forged-model",
    }

    CodePlaybook(cp)._update_p0_evidence(
        ctx, {"dispositions": [draft]}, allow_independent_dispositions=True
    )

    artifacts = cp.list_artifacts("r", "security_disposition")
    assert len(artifacts) == 1
    payload = artifacts[0]["payload"]
    assert payload["reviewer_identity"] == "agent:carren"
    assert payload["reviewer_model"] == "terra"
    assert payload["evidence_author_identity"] == "agent:skribble"
    assert artifacts[0]["authority"] == "trusted-invocation-provenance"
    assert ctx.extras["code"].get("p0_disposition_errors", []) == []


def test_trusted_disposition_fails_closed_without_invocation_provenance():
    disposition, reason = _trusted_disposition_from_draft(
        {
            "obligation_id": "quality:security",
            "evidence_refs": ["implementation-1"],
            "rationale": "review",
            "final_disposition": "satisfied",
        },
        run_id="r",
        reviewer={},
        evidence_author={},
        execution_actor={},
    )
    assert disposition is None
    assert "trusted reviewer invocation provenance" in reason


def test_p0_implementation_actor_cannot_import_independent_disposition(cp):
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    disposition = {
        "schema_version": 1,
        "run_id": "r",
        "obligation_id": "quality:security",
    }

    CodePlaybook(cp)._update_p0_evidence(ctx, {"dispositions": [disposition]})

    assert ctx.extras["code"]["p0_disposition_errors"] == [
        "the implementation/execution actor cannot author an independent disposition"
    ]
    assert cp.list_artifacts("r", "security_disposition") == []


def test_build_verify_without_selected_profile_stops_without_language_fallback(tmp_path):
    ctx = RunContext(session_id="s", run_id="r", playbook="code", goal="g")
    ctx.project_root = str(tmp_path)  # empty repo -> nothing declared
    directive = _build_verify(
        ctx, {"language": "python"}, {"verification": {"lint": True, "unit_tests": True}}
    )
    assert "No selected target-profile verification commands" in directive
    assert "request clarification" in directive
    assert "ruff check ." not in directive and "pytest tests/" not in directive


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


def test_iteration_budget_scales_with_model_tier(cp, monkeypatch):
    """Bitter-Lesson audit BL-6/PLAN-8: the default budget is an OPERATING POINT that
    rides PI_MODEL_TIER, not a frozen constant. The ceiling stays a hard safety max."""
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    CodePlaybook(cp).start(session_id=SID, run_id=RID, goal="x", constraints={})
    assert cp.load(RID).context.max_iterations == 6  # tier_budget(3, ceiling=6)

    monkeypatch.setenv("PI_MODEL_TIER", "cheap")
    CodePlaybook(cp).start(session_id=SID, run_id=RID + "-cheap", goal="x", constraints={})
    assert cp.load(RID + "-cheap").context.max_iterations == 2


def test_explicit_iteration_constraint_always_wins(cp, monkeypatch):
    """A caller's explicit budget outranks the tier-scaled default."""
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    CodePlaybook(cp).start(
        session_id=SID, run_id=RID, goal="x", constraints={"max_iterations": 1}
    )
    assert cp.load(RID).context.max_iterations == 1


def test_iteration_budget_loan_ablates_to_engine_default(cp, monkeypatch):
    """Ablated (scaffold-OFF), the engine's generic default stands, so an ablation run
    measures whether the tier bump buys anything."""
    monkeypatch.setenv("PI_MODEL_TIER", "strong")
    monkeypatch.setenv("PENNY_ABLATE_CODE_ITERATION_BUDGET", "1")
    CodePlaybook(cp).start(session_id=SID, run_id=RID, goal="x", constraints={})
    assert cp.load(RID).context.max_iterations == 3


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
    assert d["result"]["selected_ideal_state_version"] == 1
    assert d["result"]["success_criteria"] == IDEAL["success_criteria"]


# ---------------------------------------------------------------------------
# Criteria gate path
# ---------------------------------------------------------------------------


def _advance_to_checking(cp):
    _start(cp)
    _step(cp, "echo", {"findings_count": 1, "confidence": "PROBABLE"})
    _step(cp, "annie", {"risks_identified": 1, "confidence": "PROBABLE"})


@pytest.mark.parametrize("response", ["accept", "skip"])
def test_criteria_gap_accept_or_skip_resumes_planning_for_valid_ledger(cp, response):
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
    assert _step(cp, "user", {"user_response": response})["state_id"] == "planning"


def test_criteria_gap_refine_dispatches_piper_with_complete_structured_context(cp):
    _advance_to_checking(cp)
    findings = ["criterion 2 is vague"]
    issues = {"2": ["not measurable"]}
    _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": findings,
            "criteria_issues": issues,
        },
    )
    instruction = "  Make criterion 2 measurable.\nPreserve API casing.  "

    directive = _step(cp, "user", {"user_response": instruction})

    assert directive["state_id"] == "refining_criteria"
    assert directive["agent"] == "piper"
    task = directive["task_summary"]
    encoded = task.split("REFINEMENT_INPUT_JSON:", 1)[1].split("\n\nReturn", 1)[0]
    refinement_input = json.loads(encoded)
    assert refinement_input == {
        "selected_version": 1,
        "user_instruction": instruction,
        "current_success_criteria": IDEAL["success_criteria"],
        "current_ideal_state": IDEAL,
        "prior_carren": {"findings": findings, "criteria_issues": issues},
    }
    assert task.count(json.dumps(instruction)) == 1
    record = cp.load(RID)
    assert record.context.clarification_text == instruction
    assert (
        record.context.extras["code"]["pending_criteria_refinement"]["instruction"] == instruction
    )


def test_criteria_refinement_versions_selects_and_persists_mutated_ideal_state(cp):
    _advance_to_checking(cp)
    _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": ["criterion 2 is vague"],
            "criteria_issues": {"2": ["not measurable"]},
        },
    )
    _step(cp, "user", {"user_response": "require a numeric page-size boundary"})

    revised = [
        "Every response contains at most the requested page size.",
        "Page size accepts integers from 1 through 100 and rejects values outside that range.",
    ]
    directive = _step(
        cp,
        "piper",
        {
            "confidence": "CERTAIN",
            "revised_success_criteria": revised,
            "change_rationale": "Made the page-size criterion objectively testable.",
        },
    )

    assert directive["state_id"] == "checking_criteria"
    assert directive["agent"] == "carren"
    assert "Selected IDEAL_STATE version: 2" in directive["task_summary"]
    assert revised[1] in directive["task_summary"]

    record = cp.load(RID)
    code = record.context.extras["code"]
    ledger = code["ideal_state_revision_ledger"]
    assert ledger["revision_schema_version"] == 1
    assert ledger["selected_version"] == 2
    assert len(ledger["revisions"]) == 2
    assert ledger["revisions"][0]["ideal_state"] == IDEAL
    assert ledger["revisions"][1]["parent_version"] == 1
    assert ledger["revisions"][1]["ideal_state"] == code["ideal_state"]
    assert ledger["revisions"][1]["ideal_state"]["success_criteria"] == revised
    assert record.context.success_criteria == revised
    assert "ideal_state_versions" not in code and "selected_ideal_state_version" not in code

    # A fresh playbook process consumes the persisted selected version.
    assert _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})["state_id"] == "planning"


def test_invalid_criteria_revision_fails_loud_without_selecting_it(cp):
    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    _step(cp, "user", {"user_response": "make the criteria measurable"})

    directive = _step(
        cp,
        "piper",
        {
            "confidence": "CERTAIN",
            "revised_success_criteria": [],
            "change_rationale": "Removed everything.",
        },
    )

    assert directive["action"] == "escalate_to_user"
    prompt = directive["questions"][0]["prompt"]
    assert "Revision Validation Errors" in prompt
    assert "success_criteria must be a non-empty list" in prompt
    code = cp.load(RID).context.extras["code"]
    ledger = code["ideal_state_revision_ledger"]
    assert ledger["selected_version"] == 1
    assert len(ledger["revisions"]) == 1


def test_unchanged_criteria_revision_returns_to_gate_without_dispatching_carren(cp):
    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    _step(cp, "user", {"user_response": "make the criteria more precise"})

    directive = _step(
        cp,
        "piper",
        {
            "confidence": "CERTAIN",
            "revised_success_criteria": deepcopy(IDEAL["success_criteria"]),
            "change_rationale": "No effective change.",
        },
    )

    assert directive["action"] == "escalate_to_user"
    assert directive["previous_state"] == "criteria_gate"
    assert "revision did not change success_criteria" in directive["questions"][0]["prompt"]
    code = cp.load(RID).context.extras["code"]
    assert code["ideal_state_revision_ledger"]["selected_version"] == 1
    assert len(code["ideal_state_revision_ledger"]["revisions"]) == 1


def test_refine_option_without_text_reasks_instead_of_looping_on_unchanged_criteria(cp):
    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})

    directive = _step(cp, "user", {"user_response": "refine"})

    assert directive["action"] == "escalate_to_user"
    assert directive["previous_state"] == "criteria_gate"
    assert "No refinement text was supplied" in directive["questions"][0]["prompt"]
    assert cp.load(RID).context.extras["code"].get("pending_criteria_refinement") is None


def test_runtime_verification_overlay_projects_to_canonical_validation_boundary():
    enriched = deepcopy(IDEAL)
    enriched["source"] = "test"
    enriched["verification"] = {
        "unit_tests": True,
        "server_startup": True,
        "server_framework": "fastapi",
        "server_entry_points": ["/repo/app.py"],
        "server_evidence": "fastapi in pyproject.toml",
        "multi_server": True,
        "multi_server_services": [
            {
                "name": "backend",
                "kind": "python-fastapi",
                "command": "uvicorn app:app",
                "evidence": "manifest",
            }
        ],
        "multi_server_evidence": "backend + frontend",
    }

    assert _ideal_state_validation_errors(enriched) == []

    malformed_overlay = deepcopy(enriched)
    malformed_overlay["verification"]["multi_server_services"][0]["extra"] = "not produced"
    assert any(
        "multi_server_services[0] must contain exactly" in error
        for error in _ideal_state_validation_errors(malformed_overlay)
    )


def test_revision_validation_rejects_arbitrary_non_bool_verification_and_canonical_type_errors():
    arbitrary = deepcopy(IDEAL)
    arbitrary["verification"]["custom_tier"] = "fastapi"
    assert "verification.custom_tier must be a boolean" in _ideal_state_validation_errors(arbitrary)

    bad_source = deepcopy(IDEAL)
    bad_source["source"] = 123
    assert any("source" in error for error in _ideal_state_validation_errors(bad_source))

    bad_language = deepcopy(IDEAL)
    bad_language["language"] = 123
    assert any("language" in error for error in _ideal_state_validation_errors(bad_language))


def test_fresh_start_captures_v1_after_server_detection(cp, tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "server"\ndependencies = ["fastapi"]\n', encoding="utf-8"
    )
    CodePlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal=IDEAL["goal"],
        project_root=str(tmp_path),
        constraints={"ideal_state": IDEAL},
    )

    code = cp.load(RID).context.extras["code"]
    active = code["ideal_state"]
    ledger = code["ideal_state_revision_ledger"]
    assert active["verification"]["server_startup"] is True
    assert active["verification"]["server_framework"] == "fastapi"
    assert ledger["selected_version"] == 1
    assert ledger["revisions"][0]["ideal_state"] == active


def test_criteria_revision_does_not_refresh_detection_or_change_parent_fields(cp, tmp_path):
    CodePlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal=IDEAL["goal"],
        project_root=str(tmp_path),
        constraints={"ideal_state": IDEAL},
    )
    parent = deepcopy(
        cp.load(RID).context.extras["code"]["ideal_state_revision_ledger"]["revisions"][0][
            "ideal_state"
        ]
    )
    assert "server_startup" not in parent["verification"]

    _step(cp, "echo", {"findings_count": 1, "confidence": "PROBABLE"})
    _step(cp, "annie", {"risks_identified": 1, "confidence": "PROBABLE"})
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    _step(cp, "user", {"user_response": "add a numeric page-size boundary"})

    # Change repo detectability only after v1 was selected. Criteria authoring must
    # not smuggle a runtime-detection migration into v2.
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "server"\ndependencies = ["fastapi"]\n', encoding="utf-8"
    )
    revised = ["results are paginated", "page size accepts integers from 1 through 100"]
    _step(
        cp,
        "piper",
        {
            "revised_success_criteria": revised,
            "change_rationale": "Added the numeric boundary.",
            "confidence": "CERTAIN",
        },
    )

    code = cp.load(RID).context.extras["code"]
    child = code["ideal_state_revision_ledger"]["revisions"][1]["ideal_state"]
    assert child == code["ideal_state"]
    parent_non_criteria = {key: value for key, value in parent.items() if key != "success_criteria"}
    child_non_criteria = {key: value for key, value in child.items() if key != "success_criteria"}
    assert child_non_criteria == parent_non_criteria
    assert child["success_criteria"] == revised
    assert "server_startup" not in child["verification"]


def test_fresh_process_recovery_reissues_refiner_then_committed_carren(cp):
    from orchestration.recovery import recover_pending

    _advance_to_checking(cp)
    _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": ["vague"],
            "criteria_issues": {"2": ["not measurable"]},
        },
    )
    instruction = "  add a numeric boundary  "
    _step(cp, "user", {"user_response": instruction})

    recovered = recover_pending(cp, session_id=SID, playbook="code")
    assert len(recovered) == 1
    assert recovered[0]["state_id"] == "refining_criteria"
    assert recovered[0]["agent"] == "piper"
    assert recovered[0]["task_summary"].count(json.dumps(instruction)) == 1
    before = cp.load(RID).context.extras["code"]["ideal_state_revision_ledger"]
    assert len(before["revisions"]) == 1

    revised = ["results are paginated", "page size is an integer from 1 through 100"]
    _step(
        cp,
        "piper",
        {
            "revised_success_criteria": revised,
            "change_rationale": "Added the exact numeric boundary.",
            "confidence": "CERTAIN",
        },
    )
    committed = deepcopy(cp.load(RID).context.extras["code"]["ideal_state_revision_ledger"])
    assert committed["selected_version"] == 2 and len(committed["revisions"]) == 2

    recovered_again = recover_pending(cp, session_id=SID, playbook="code")
    assert len(recovered_again) == 1
    assert recovered_again[0]["state_id"] == "checking_criteria"
    assert recovered_again[0]["agent"] == "carren"
    assert "Selected IDEAL_STATE version: 2" in recovered_again[0]["task_summary"]
    assert cp.load(RID).context.extras["code"]["ideal_state_revision_ledger"] == committed


def _replace_checkpoint(cp, record) -> None:
    cp.save(
        run_id=record.run_id,
        session_id=record.session_id,
        playbook=record.playbook,
        current_state_id=record.current_state_id,
        context=record.context,
        status=record.status,
    )


def _install_ledgerless_at_checking(cp, checkpoint_kind: str) -> dict:
    _advance_to_checking(cp)
    if checkpoint_kind == "true_old":
        ideal = _head_synthesized_ideal()
    elif checkpoint_kind == "canonical":
        ideal = deepcopy(IDEAL)
    else:  # pragma: no cover - parameter tables are exhaustive
        raise AssertionError(f"unknown ledger-less checkpoint kind {checkpoint_kind}")
    record = cp.load(RID)
    code = record.context.extras["code"]
    code["ideal_state"] = deepcopy(ideal)
    code.pop("ideal_state_revision_ledger")
    record.context.success_criteria = deepcopy(ideal["success_criteria"])
    _replace_checkpoint(cp, record)
    return ideal


def _install_head_legacy_at_checking(cp) -> dict:
    return _install_ledgerless_at_checking(cp, "true_old")


def test_head_legacy_shape_recovers_every_pending_boundary_and_migrates_exactly(cp):
    from orchestration.recovery import recover_pending

    legacy_ideal = _install_head_legacy_at_checking(cp)

    checking = recover_pending(cp, session_id=SID, playbook="code")
    assert len(checking) == 1
    assert checking[0]["run_id"] == RID
    assert checking[0]["state_id"] == "checking_criteria"
    assert checking[0]["agent"] == "carren"
    assert json.dumps(legacy_ideal) in checking[0]["task_summary"]
    assert "ideal_state_revision_ledger" not in cp.load(RID).context.extras["code"]

    gate = _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": ["vague"],
            "criteria_issues": {"2": ["not measurable"]},
        },
    )
    assert gate["action"] == "escalate_to_user"
    gate_recovery = recover_pending(cp, session_id=SID, playbook="code")
    assert len(gate_recovery) == 1
    assert gate_recovery[0]["previous_state"] == "criteria_gate"
    assert "Integrity Error" not in gate_recovery[0]["questions"][0]["prompt"]
    assert "ideal_state_revision_ledger" not in cp.load(RID).context.extras["code"]

    instruction = "add an exact numeric limit"
    refining = _step(cp, "user", {"user_response": instruction})
    assert refining["state_id"] == "refining_criteria" and refining["agent"] == "piper"
    refiner_recovery = recover_pending(cp, session_id=SID, playbook="code")
    assert len(refiner_recovery) == 1
    assert refiner_recovery[0]["state_id"] == "refining_criteria"
    assert refiner_recovery[0]["task_summary"].count(json.dumps(instruction)) == 1
    assert "ideal_state_revision_ledger" not in cp.load(RID).context.extras["code"]

    revised = [
        "The pagination goal is implemented end-to-end.",
        "Page size accepts integers from 1 through 100 and rejects all other values.",
    ]
    committed = _step(
        cp,
        "piper",
        {
            "revised_success_criteria": revised,
            "change_rationale": "Added a numeric limit.",
            "confidence": "CERTAIN",
        },
    )
    assert committed["state_id"] == "checking_criteria" and committed["agent"] == "carren"

    record = cp.load(RID)
    assert record.run_id == RID and record.session_id == SID
    code = record.context.extras["code"]
    ledger = code["ideal_state_revision_ledger"]
    assert ledger["selected_version"] == 2 and len(ledger["revisions"]) == 2
    assert ledger["revisions"][0]["ideal_state"] == legacy_ideal
    expected_v2 = deepcopy(legacy_ideal)
    expected_v2.update(
        {
            "goal": IDEAL["goal"],
            "source": "code_skill_goal",
            "schema_version": 2,
            "success_criteria": revised,
        }
    )
    assert ledger["revisions"][1]["ideal_state"] == expected_v2
    assert code["ideal_state"] == expected_v2
    assert record.context.success_criteria == revised
    assert (
        "Compatibility migration from the pre-ledger synthesized IDEAL_STATE"
        in ledger["revisions"][1]["change_rationale"]
    )
    assert (
        "source='code_skill_goal', schema_version=2" in ledger["revisions"][1]["change_rationale"]
    )
    assert _ideal_state_validation_errors(expected_v2) == []

    committed_recovery = recover_pending(cp, session_id=SID, playbook="code")
    assert len(committed_recovery) == 1
    assert committed_recovery[0]["state_id"] == "checking_criteria"
    assert committed_recovery[0]["agent"] == "carren"
    assert "Selected IDEAL_STATE version: 2" in committed_recovery[0]["task_summary"]
    assert cp.load(RID).context.extras["code"]["ideal_state_revision_ledger"] == ledger


@pytest.mark.parametrize(
    "candidate,expected_error",
    [
        ([], "success_criteria must be a non-empty list"),
        (None, "revision did not change success_criteria"),
    ],
)
def test_head_legacy_invalid_or_noop_refinement_creates_no_ledger(cp, candidate, expected_error):
    legacy_ideal = _install_head_legacy_at_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    _step(cp, "user", {"user_response": "make it measurable"})
    proposed = legacy_ideal["success_criteria"] if candidate is None else candidate

    directive = _step(
        cp,
        "piper",
        {
            "revised_success_criteria": deepcopy(proposed),
            "change_rationale": "Candidate output.",
            "confidence": "CERTAIN",
        },
    )

    assert directive["action"] == "escalate_to_user"
    assert expected_error in directive["questions"][0]["prompt"]
    code = cp.load(RID).context.extras["code"]
    assert "ideal_state_revision_ledger" not in code
    assert code["ideal_state"] == legacy_ideal


def test_legacy_marker_does_not_weaken_arbitrary_malformed_payloads(cp):
    from orchestration.recovery import recover_pending

    legacy_ideal = _install_head_legacy_at_checking(cp)
    record = cp.load(RID)
    malformed = deepcopy(legacy_ideal)
    malformed["verification"]["arbitrary_tier"] = True
    record.context.extras["code"]["ideal_state"] = malformed
    _replace_checkpoint(cp, record)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})

    recovered = recover_pending(cp, session_id=SID, playbook="code")
    assert len(recovered) == 1
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in recovered[0]["questions"][0]["prompt"]
    directive = _step(cp, "user", {"user_response": "accept"})
    assert directive["action"] == "escalate_to_user"
    assert directive["previous_state"] == "criteria_gate"
    code = cp.load(RID).context.extras["code"]
    assert "ideal_state_revision_ledger" not in code
    assert code["ideal_state"] == malformed


_LEDGERLESS_CRITERIA_MISMATCH = ["different ledger-less context criterion"]
_LEDGERLESS_CRITERIA_MISMATCH_ERROR = (
    "ctx.success_criteria must exactly equal ledger-less code.ideal_state.success_criteria"
)


def _canonical_json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )


@pytest.mark.parametrize("checkpoint_kind", ["true_old", "canonical"])
@pytest.mark.parametrize("response", ["accept", "skip", "make criterion 2 measurable"])
def test_ledgerless_context_mismatch_is_non_overridable_across_full_fsm(
    cp, checkpoint_kind, response
):
    from orchestration.recovery import recover_pending

    ideal = _install_ledgerless_at_checking(cp, checkpoint_kind)
    record = cp.load(RID)
    record.context.success_criteria = deepcopy(_LEDGERLESS_CRITERIA_MISMATCH)
    _replace_checkpoint(cp, record)

    gate = _step(
        cp,
        "carren",
        {"gap": True, "confidence": "POSSIBLE", "findings": ["criterion is vague"]},
    )

    assert gate["action"] == "escalate_to_user"
    assert gate["previous_state"] == "criteria_gate"
    gate_prompt = gate["questions"][0]["prompt"]
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in gate_prompt
    assert _LEDGERLESS_CRITERIA_MISMATCH_ERROR in gate_prompt
    at_gate = cp.load(RID)
    assert at_gate.context.extras["code"]["ideal_state"] == ideal
    assert "ideal_state_revision_ledger" not in at_gate.context.extras["code"]
    code_snapshot = deepcopy(at_gate.context.extras["code"])
    context_snapshot = deepcopy(at_gate.context.to_dict())
    code_bytes = _canonical_json_bytes(code_snapshot)
    context_bytes = _canonical_json_bytes(context_snapshot)

    recovered = recover_pending(cp, session_id=SID, playbook="code")

    assert len(recovered) == 1 and recovered[0]["action"] == "escalate_to_user"
    recovery_prompt = recovered[0]["questions"][0]["prompt"]
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in recovery_prompt
    assert _LEDGERLESS_CRITERIA_MISMATCH_ERROR in recovery_prompt
    recovered_record = cp.load(RID)
    assert recovered_record.context.extras["code"] == code_snapshot
    assert recovered_record.context.to_dict() == context_snapshot
    assert _canonical_json_bytes(recovered_record.context.extras["code"]) == code_bytes
    assert _canonical_json_bytes(recovered_record.context.to_dict()) == context_bytes

    directive = _step(cp, "user", {"user_response": response})

    assert directive["action"] == "escalate_to_user"
    assert directive["previous_state"] == "criteria_gate"
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in directive["questions"][0]["prompt"]
    assert _LEDGERLESS_CRITERIA_MISMATCH_ERROR in directive["questions"][0]["prompt"]
    after = cp.load(RID)
    assert after.current_state_id == "criteria_gate"
    assert after.context.extras["code"] == code_snapshot
    assert after.context.to_dict() == context_snapshot
    assert _canonical_json_bytes(after.context.extras["code"]) == code_bytes
    assert _canonical_json_bytes(after.context.to_dict()) == context_bytes


@pytest.mark.parametrize("checkpoint_kind", ["true_old", "canonical"])
def test_ledgerless_context_mismatch_injected_after_pending_piper_rejects_commit(
    cp, checkpoint_kind
):
    from orchestration.recovery import recover_pending

    ideal = _install_ledgerless_at_checking(cp, checkpoint_kind)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    pending = _step(cp, "user", {"user_response": "add an exact numeric boundary"})
    assert pending["state_id"] == "refining_criteria" and pending["agent"] == "piper"

    record = cp.load(RID)
    record.context.success_criteria = deepcopy(_LEDGERLESS_CRITERIA_MISMATCH)
    ideal_bytes = _canonical_json_bytes(record.context.extras["code"]["ideal_state"])
    criteria_bytes = _canonical_json_bytes(record.context.success_criteria)
    pending_snapshot = deepcopy(record.context.extras["code"]["pending_criteria_refinement"])
    checkpoint_snapshot = deepcopy(record.context.to_dict())
    _replace_checkpoint(cp, record)

    recovered = recover_pending(cp, session_id=SID, playbook="code")

    assert len(recovered) == 1 and recovered[0]["action"] == "error"
    assert (
        "criteria refinement blocked by non-overridable IDEAL_STATE integrity errors"
        in recovered[0]["errors"][0]
    )
    assert _LEDGERLESS_CRITERIA_MISMATCH_ERROR in recovered[0]["errors"][0]
    after_recovery = cp.load(RID)
    assert after_recovery.current_state_id == "refining_criteria"
    assert after_recovery.context.to_dict() == checkpoint_snapshot
    assert "ideal_state_revision_ledger" not in after_recovery.context.extras["code"]

    directive = _step(
        cp,
        "piper",
        {
            "revised_success_criteria": [
                "Every successful response contains a pagination cursor.",
                "Page size accepts integers from 1 through 100.",
            ],
            "change_rationale": "Added observable pagination boundaries.",
            "confidence": "CERTAIN",
        },
    )

    assert directive["action"] == "escalate_to_user"
    assert directive["previous_state"] == "criteria_gate"
    prompt = directive["questions"][0]["prompt"]
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in prompt
    assert _LEDGERLESS_CRITERIA_MISMATCH_ERROR in prompt
    after = cp.load(RID)
    code = after.context.extras["code"]
    assert after.current_state_id == "criteria_gate"
    assert "ideal_state_revision_ledger" not in code
    assert code["ideal_state"] == ideal
    assert _canonical_json_bytes(code["ideal_state"]) == ideal_bytes
    assert code["pending_criteria_refinement"] == pending_snapshot
    assert code["criteria_refinement_errors"] == [_LEDGERLESS_CRITERIA_MISMATCH_ERROR]
    assert after.context.success_criteria == _LEDGERLESS_CRITERIA_MISMATCH
    assert _canonical_json_bytes(after.context.success_criteria) == criteria_bytes


def test_stale_refinement_base_is_rejected_without_overwriting_newer_selection(cp):
    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    _step(cp, "user", {"user_response": "make it measurable"})

    stale_record = cp.load(RID)
    stale_code = stale_record.context.extras["code"]
    ledger = stale_code["ideal_state_revision_ledger"]
    external_ideal = deepcopy(stale_code["ideal_state"])
    external_ideal["success_criteria"] = ["externally selected criterion"]
    ledger["revisions"].append(
        {
            "version": 2,
            "parent_version": 1,
            "created_at": ledger["revisions"][0]["created_at"],
            "change_rationale": "Concurrent valid selection.",
            "ideal_state": deepcopy(external_ideal),
        }
    )
    ledger["selected_version"] = 2
    stale_code["ideal_state"] = deepcopy(external_ideal)
    stale_record.context.success_criteria = deepcopy(external_ideal["success_criteria"])
    _replace_checkpoint(cp, stale_record)

    directive = _step(
        cp,
        "piper",
        {
            "revised_success_criteria": ["a different proposed criterion"],
            "change_rationale": "Based on stale v1.",
            "confidence": "CERTAIN",
        },
    )

    assert directive["action"] == "escalate_to_user"
    assert "stale criteria refinement base version 1" in directive["questions"][0]["prompt"]
    code = cp.load(RID).context.extras["code"]
    assert code["ideal_state_revision_ledger"]["selected_version"] == 2
    assert len(code["ideal_state_revision_ledger"]["revisions"]) == 2
    assert code["ideal_state"] == external_ideal


def _corrupt_criteria_gate_ledger(record, corruption: str) -> None:  # noqa: C901
    code = record.context.extras["code"]
    ledger = code["ideal_state_revision_ledger"]
    if corruption == "envelope":
        code["ideal_state_revision_ledger"] = []
    elif corruption == "revisions":
        ledger["revisions"] = {}
    elif corruption == "record":
        ledger["revisions"][0] = []
    elif corruption == "selected_payload":
        ledger["revisions"][0]["ideal_state"] = []
    elif corruption == "duplicate_versions":
        duplicate = deepcopy(ledger["revisions"][0])
        duplicate["parent_version"] = 1
        duplicate["change_rationale"] = "Duplicate v1."
        ledger["revisions"].append(duplicate)
    elif corruption == "broken_parent":
        child = deepcopy(ledger["revisions"][0])
        child.update(
            {
                "version": 2,
                "parent_version": 999,
                "change_rationale": "Broken parent.",
            }
        )
        ledger["revisions"].append(child)
        ledger["selected_version"] = 2
    elif corruption == "active_mismatch":
        code["ideal_state"] = deepcopy(code["ideal_state"])
        code["ideal_state"]["goal"] = "different active goal"
    elif corruption == "criteria_mismatch":
        record.context.success_criteria = ["different context criterion"]
    elif corruption == "missing_pointer":
        ledger["selected_version"] = 999
    elif corruption == "future_schema":
        ledger["revision_schema_version"] = 2
    else:  # pragma: no cover - the parameter table is exhaustive
        raise AssertionError(f"unknown corruption {corruption}")


@pytest.mark.parametrize(
    "corruption,expected_error",
    [
        ("envelope", "ideal_state_revision_ledger must be an object"),
        ("revisions", "revisions must be a non-empty list"),
        ("record", "revisions[0] must be an object"),
        ("selected_payload", "selected ideal_state payload must be an object"),
        ("duplicate_versions", "version must be strictly increasing and unique"),
        ("broken_parent", "parent_version must reference an earlier record"),
        ("active_mismatch", "active code.ideal_state must exactly equal"),
        ("criteria_mismatch", "ctx.success_criteria must exactly equal"),
        ("missing_pointer", "selected_version must resolve to exactly one record"),
        ("future_schema", "unsupported future ideal_state_revision_ledger schema version 2"),
    ],
)
@pytest.mark.parametrize("response", ["accept", "skip", "make criterion 2 measurable"])
def test_arbitrary_json_ledger_integrity_is_non_overridable_across_full_fsm(
    cp, corruption, expected_error, response
):
    from orchestration.recovery import recover_pending

    _advance_to_checking(cp)
    _step(cp, "carren", {"gap": True, "confidence": "POSSIBLE", "findings": ["vague"]})
    record = cp.load(RID)
    _corrupt_criteria_gate_ledger(record, corruption)
    code_snapshot = deepcopy(record.context.extras["code"])
    criteria_snapshot = deepcopy(record.context.success_criteria)
    _replace_checkpoint(cp, record)

    recovered = recover_pending(cp, session_id=SID, playbook="code")

    assert len(recovered) == 1 and recovered[0]["action"] == "escalate_to_user"
    recovery_prompt = recovered[0]["questions"][0]["prompt"]
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in recovery_prompt
    assert expected_error in recovery_prompt
    recovered_record = cp.load(RID)
    assert recovered_record.context.extras["code"] == code_snapshot
    assert recovered_record.context.success_criteria == criteria_snapshot

    directive = _step(cp, "user", {"user_response": response})

    assert directive["action"] == "escalate_to_user"
    assert directive["previous_state"] == "criteria_gate"
    assert "IDEAL_STATE Integrity Error (Non-overridable)" in directive["questions"][0]["prompt"]
    assert expected_error in directive["questions"][0]["prompt"]
    after = cp.load(RID)
    assert after.current_state_id == "criteria_gate"
    assert after.context.extras["code"] == code_snapshot
    assert after.context.success_criteria == criteria_snapshot


def test_selected_v2_and_revised_criteria_reach_carren_plan_implementation_and_result(cp):
    _advance_to_checking(cp)
    _step(
        cp,
        "carren",
        {
            "gap": True,
            "confidence": "POSSIBLE",
            "findings": ["criterion 2 is vague"],
            "criteria_issues": {"2": ["not measurable"]},
        },
    )
    _step(cp, "user", {"user_response": "add an exact page-size boundary"})
    revised = [
        "Every successful response contains a pagination cursor.",
        "Page size accepts integers from 1 through 100 and rejects all other values.",
    ]

    criteria = _step(
        cp,
        "piper",
        {
            "revised_success_criteria": revised,
            "change_rationale": "Added observable cursor and numeric boundary outcomes.",
            "confidence": "CERTAIN",
        },
    )
    assert criteria["agent"] == "carren"
    assert "Selected IDEAL_STATE version: 2" in criteria["task_summary"]
    assert json.dumps(revised) in criteria["task_summary"]

    plan = _step(cp, "carren", {"gap": False, "confidence": "CERTAIN"})
    assert "Selected IDEAL_STATE version: 2" in plan["task_summary"]
    assert json.dumps(revised) in plan["task_summary"]

    _step(cp, "piper", {"plan_complete": True, "confidence": "PROBABLE"})
    implement = _step(cp, "user", {"user_response": "approve"})
    assert "Selected IDEAL_STATE version: 2" in implement["task_summary"]
    assert json.dumps(revised) in implement["task_summary"]

    _step(cp, "skribble", {"confidence": "PROBABLE"})
    _step(cp, "skribble", _VERIFY_PASS)
    _step(cp, "carren", {"gap": False})
    result = _step(cp, "skribble", _VERIFY_PASS)
    assert result["action"] == "complete"
    assert result["result"]["selected_ideal_state_version"] == 2
    assert result["result"]["success_criteria"] == revised


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


# ---------------------------------------------------------------------------
# item 16 (cross-skill half): the verification taxonomy is OPEN.
# Previously `enabled` filtered to six hardcoded tiers, so any other required
# tier vanished from the agent's obligations — including multi_server, which
# code_detection itself sets. IDEAL_STATE schema_version 2 records the intent.
# ---------------------------------------------------------------------------


def test_unknown_required_tiers_are_not_silently_dropped():
    from orchestration.context import RunContext
    from orchestration.playbooks.code import _build_verify

    ctx = RunContext(session_id="s", run_id="r", playbook="code", project_root="/tmp")
    ideal = {
        "verification": {
            "lint": True,
            "property_tests": True,
            "fuzz_tests": True,
            "accessibility_audit": True,
            "e2e_tests": False,  # falsy tiers stay excluded
        }
    }
    task = _build_verify(ctx, {"language": "python"}, ideal)
    tiers = task.split("Enabled verification tiers:", 1)[1].split(".")[0]
    for required in ("lint", "property_tests", "fuzz_tests", "accessibility_audit"):
        assert required in tiers, f"{required} dropped from the enabled tiers"
    assert "e2e_tests" not in tiers
    # and they must come with an explicit obligation, not just be listed
    assert "ADDITIONAL REQUIRED TIERS" in task
    assert "failing, unverified obligation" in task


def test_multi_server_tier_set_by_detection_survives():
    # code_detection writes verification["multi_server"]; it used to be dropped.
    from orchestration.context import RunContext
    from orchestration.playbooks.code import _build_verify

    ctx = RunContext(session_id="s", run_id="r", playbook="code", project_root="/tmp")
    task = _build_verify(ctx, {"language": "python"}, {"verification": {"multi_server": True}})
    assert "multi_server" in task.split("Enabled verification tiers:", 1)[1].split(".")[0]


def test_known_tiers_still_require_selected_profile_commands():
    from orchestration.context import RunContext
    from orchestration.playbooks.code import _build_verify

    ctx = RunContext(session_id="s", run_id="r", playbook="code", project_root="/tmp")
    task = _build_verify(
        ctx, {"language": "python"}, {"verification": {"lint": True, "unit_tests": True}}
    )
    assert "No selected target-profile verification commands" in task
    assert "ruff check ." not in task and "pytest tests/" not in task
    assert "ADDITIONAL REQUIRED TIERS" not in task  # nothing unknown -> no extra block


def test_ideal_state_schema_accepts_an_open_taxonomy_and_versions_it():
    import json as _json
    import subprocess
    import sys as _sys
    from pathlib import Path

    script = Path(__file__).resolve().parents[3] / "scripts" / "validate_ideal_state.py"
    spec = {
        "goal": "g",
        "success_criteria": ["c"],
        "verification": {"property_tests": True, "load_tests": True},
    }
    p = subprocess.run(
        [_sys.executable, str(script), "--stdin"],
        input=_json.dumps(spec),
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stdout + p.stderr

    # v1 documents (no schema_version) remain valid — backward compatible.
    legacy = {"goal": "g", "success_criteria": ["c"], "verification": {"lint": True}}
    p2 = subprocess.run(
        [_sys.executable, str(script), "--stdin"],
        input=_json.dumps(legacy),
        capture_output=True,
        text=True,
    )
    assert p2.returncode == 0, p2.stdout + p2.stderr


# ---------------------------------------------------------------------------
# Plan-gate prompt must stay READABLE (a prompt nobody can read is not oversight)
# ---------------------------------------------------------------------------


class _FakeRef:
    artifact_id = "run:piper_plan:v1:abcd"
    version = 1
    digest = "d" * 64


class _FakePlan:
    def __init__(self, content):
        self.payload = {"content": content, "content_status": "verified"}


def test_plan_gate_prompt_is_bounded_and_points_at_the_complete_plan(tmp_path):
    """A real Piper plan measured 83,511 chars and produced a 25,551-char / 260-line
    interactive prompt that corrupted the terminal, leaving the approver unable to read
    or approve it. The prompt now renders identity + a bounded excerpt + a path."""
    from orchestration.playbooks.code import _plan_gate_prompt, _spill_plan_artifact

    content = "\n".join(f"plan line {i} " + "x" * 120 for i in range(1200))
    assert len(content) > 80_000, "fixture must reproduce a realistically huge plan"
    code = {}
    spill = _spill_plan_artifact(code, _FakeRef(), content)
    prompt = _plan_gate_prompt(_FakeRef(), _FakePlan(content), "SUMMARY-BODY", spill)

    # Bounded: the old prompt was ~25.5k chars; this must be a small fraction of that.
    assert len(prompt) < 6000, f"plan gate prompt regrew to {len(prompt)} chars"
    assert max(len(line) for line in prompt.splitlines()) < 400
    # The full plan is NOT inlined ...
    assert content not in prompt
    # ... but identity, integrity, and the complete artifact remain reachable.
    assert _FakeRef.digest in prompt
    assert "COMPLETE plan written to:" in prompt
    assert "omitted from THIS PROMPT only" in prompt
    assert "SUMMARY-BODY" in prompt
    assert Path(spill).read_text(encoding="utf-8") == content
    # Owner-only, and outside any target tree.
    assert Path(spill).stat().st_mode & 0o077 == 0


def test_plan_spill_is_reused_across_gate_reasks():
    """A re-ask must not leak a new temp directory per attempt."""
    from orchestration.playbooks.code import _spill_plan_artifact

    code = {}
    first = _spill_plan_artifact(code, _FakeRef(), "plan body")
    second = _spill_plan_artifact(code, _FakeRef(), "plan body")
    assert first == second
