"""FLOW-01 exact-artifact and memory-absent conformance for active research."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from artifact_protocol_helpers import owner_result
from orchestration.artifacts import (
    ArtifactRef,
    ArtifactStore,
    InputArtifactsV1,
    OutputArtifactMetadata,
)
from orchestration.checkpointer import Checkpointer
from orchestration.playbooks.research import ResearchPlaybook
from orchestration.recovery import recover_pending

SID = "research-artifact-session"
RID = "research-artifact-run"
GOAL = "compare two evidence-backed deployment strategies"


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orchestration.sqlite3")


@pytest.fixture
def project_root(tmp_path):
    root = tmp_path / "target"
    root.mkdir()
    return str(root)


@pytest.fixture(autouse=True)
def _memory_endpoint_unavailable_and_extension_absent(monkeypatch, tmp_path):
    """Run production protocol-v2 paths with an unusable endpoint and no extension root."""
    monkeypatch.delenv("PENNY_ORCH_TEST_ALLOW_PROGRAMMATIC_RESULTS", raising=False)
    for key in list(os.environ):
        if key.startswith(("MEMPALACE_", "PENNY_MEMORY_")) or key == "PI_MEMORY_BRIDGE":
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("MEMPALACE_URL", "http://127.0.0.1:1/unavailable")
    absent = tmp_path / "extensions-without-memory"
    absent.mkdir()
    monkeypatch.setenv("PI_EXTENSIONS_DIR", str(absent))


def _start(cp, project_root, *, constraints=None):
    return ResearchPlaybook(cp).start(
        session_id=SID,
        run_id=RID,
        goal=GOAL,
        constraints=constraints or {},
        project_root=project_root,
    )


def _single(cp, directive, summary, *, output=None):
    assert directive["action"] == "invoke_agent"
    result = owner_result(directive, summary, output=output)
    return ResearchPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent=directive["agent"],
        result=result,
    )


def _parallel(cp, directive, summaries):
    assert directive["action"] == "invoke_agents_parallel"
    entries = [
        owner_result(directive, summaries[task["branch_id"]], branch_id=task["branch_id"])
        for task in directive["tasks"]
    ]
    return ResearchPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="__parallel__",
        result=entries,
    )


def _input_refs(directive):
    value = InputArtifactsV1.from_dict(directive["input_artifacts"])
    return tuple(binding.ref for binding in value.artifacts)


def _output_scopes(directive):
    values = (
        [directive["output_artifact"]]
        if directive["action"] == "invoke_agent"
        else [task["output_artifact"] for task in directive["tasks"]]
    )
    return {
        OutputArtifactMetadata.from_dict(value)
        .phase: OutputArtifactMetadata.from_dict(value)
        .consumer_scope
        for value in values
    }


def _assert_exact_task(directive):
    if directive["action"] == "invoke_agent":
        tasks = [directive]
    else:
        tasks = directive["tasks"]
    assert tasks
    assert all("artifact_read" in task["task_summary"] for task in tasks)
    assert all("SUMMARY is routing data only" in task["task_summary"] for task in tasks)


def test_memory_absent_start_emits_exact_empty_input_contract(cp, project_root):
    directive = _start(cp, project_root)
    assert directive["state_id"] == "planning"
    assert _input_refs(directive) == ()
    assert OutputArtifactMetadata.from_dict(directive["output_artifact"]).phase == "planning"
    assert _output_scopes(directive)["planning"] == (
        "state:critiquing_plan",
        "state:planning",
        "state:researching",
    )
    _assert_exact_task(directive)


def test_memory_absent_step_routes_owner_plan_artifact_to_parallel_research(cp, project_root):
    planning = _start(cp, project_root)
    research = _single(
        cp,
        planning,
        {"plan_steps": ["evidence A", "evidence B"], "plan_complete": True, "mode": "standard"},
    )
    assert research["action"] == "invoke_agents_parallel"
    refs = _input_refs(research)
    assert len(refs) == 1 and refs[0].phase == "planning"
    assert {task["branch_id"] for task in research["tasks"]} == {"sq1", "sq2"}
    assert _output_scopes(research)["researching"] == (
        "state:critiquing_report",
        "state:report_writing",
        "state:researching",
        "state:synthesizing",
        "state:validating",
    )
    _assert_exact_task(research)


def test_memory_absent_parallel_fan_maps_exact_branch_artifacts_by_id(cp, project_root):
    planning = _start(cp, project_root)
    research = _single(
        cp,
        planning,
        {"plan_steps": ["evidence A", "evidence B"], "plan_complete": True},
    )
    synthesis = _parallel(
        cp,
        research,
        {
            "sq1": {"explore_complete": True, "confidence": "PROBABLE"},
            "sq2": {"explore_complete": True, "confidence": "CERTAIN"},
        },
    )
    refs = _input_refs(synthesis)
    assert {(ref.phase, ref.branch_id) for ref in refs} == {
        ("researching", "sq1"),
        ("researching", "sq2"),
    }
    _assert_exact_task(synthesis)


def test_memory_absent_retry_versions_owner_output_without_semantic_fallback(cp, project_root):
    directive = _start(cp, project_root, constraints={"mode": "quick"})
    result = owner_result(directive, {}, summary_missing=True)
    retry = ResearchPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="echo",
        result=result,
    )
    first = ArtifactRef.from_dict(result["output_artifact_ref"])
    revised = OutputArtifactMetadata.from_dict(retry["output_artifact"])
    assert retry["state_id"] == "researching"
    assert revised.version == 2 and revised.parent_ref == first
    _assert_exact_task(retry)


def test_memory_absent_clarification_resumes_with_exact_selected_artifact(cp, project_root):
    directive = _start(cp, project_root, constraints={"mode": "quick"})
    result = owner_result(
        directive,
        {
            "explore_complete": False,
            "confidence": "UNCERTAIN",
            "needs_clarification": True,
            "clarifying_questions": ["Which region?"],
        },
    )
    paused = ResearchPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="echo",
        result=result,
    )
    assert paused["action"] == "escalate_to_user"

    resumed = ResearchPlaybook(cp).step(
        session_id=SID,
        run_id=RID,
        agent="user",
        result={"answer": "us-east only"},
    )
    refs = _input_refs(resumed)
    expected = ArtifactRef.from_dict(result["output_artifact_ref"])
    assert refs == (expected,)
    assert "state:researching" in expected.consumer_scope
    assert "state:planning" not in expected.consumer_scope
    assert "User clarification: us-east only" in resumed["task_summary"]
    _assert_exact_task(resumed)


def test_memory_absent_restart_reissues_same_exact_parallel_inputs(cp, project_root):
    planning = _start(cp, project_root)
    research = _single(
        cp,
        planning,
        {"plan_steps": ["evidence A", "evidence B"], "plan_complete": True},
    )
    expected = research["input_artifacts"]

    fresh = Checkpointer(db_path=cp.db_path)
    recovered = recover_pending(fresh, session_id=SID, playbook="research")
    assert len(recovered) == 1
    assert recovered[0]["state_id"] == "researching"
    assert recovered[0]["input_artifacts"] == expected
    _assert_exact_task(recovered[0])


def test_deep_artifact_handoff_keeps_plan_synthesis_evidence_and_critiques(cp, project_root):
    planning = _start(cp, project_root, constraints={"mode": "deep"})
    plan_critique = _single(
        cp,
        planning,
        {"plan_steps": ["evidence A", "evidence B"], "plan_complete": True},
    )
    assert {ref.phase for ref in _input_refs(plan_critique)} == {"planning"}

    research = _single(
        cp,
        plan_critique,
        {"verdict": "APPROVE", "issues": [], "evidence": ["checked exact plan"]},
    )
    assert {ref.phase for ref in _input_refs(research)} == {"planning", "critiquing_plan"}

    synthesis = _parallel(
        cp,
        research,
        {"sq1": {"explore_complete": True}, "sq2": {"explore_complete": True}},
    )
    report_critique = _single(cp, synthesis, {"synthesis_complete": True})
    validation = _single(
        cp,
        report_critique,
        {"verdict": "APPROVE", "issues": [], "evidence": ["checked exact synthesis"]},
    )
    assert {ref.phase for ref in _input_refs(validation)} == {
        "researching",
        "synthesizing",
        "critiquing_report",
    }
    assert _output_scopes(validation)["validating"] == (
        "state:report_writing",
        "state:researching",
        "state:synthesizing",
        "state:validating",
    )
    _assert_exact_task(validation)


def test_memory_absent_research_retry_refans_and_preserves_all_exact_evidence(cp, project_root):
    planning = _start(cp, project_root)
    research = _single(
        cp,
        planning,
        {"plan_steps": ["evidence A"], "plan_complete": True},
    )
    synthesis = _parallel(cp, research, {"sq1": {"explore_complete": True}})
    validation = _single(cp, synthesis, {"synthesis_complete": True})
    re_research = _single(
        cp,
        validation,
        {
            "verdict": "FAIL",
            "unsupported_claims": ["claim 2"],
            "evidence": ["claim 2 has no source"],
            "evidence_needed": ["primary evidence for claim 2"],
        },
    )
    assert re_research["state_id"] == "researching"
    assert {ref.phase for ref in _input_refs(re_research)} >= {"synthesizing", "validating"}
    validation_ref = next(ref for ref in _input_refs(re_research) if ref.phase == "validating")
    assert set(validation_ref.consumer_scope) == {
        "state:report_writing",
        "state:researching",
        "state:synthesizing",
        "state:validating",
    }

    revised_synthesis = _parallel(cp, re_research, {"sq2": {"explore_complete": True}})
    refs = _input_refs(revised_synthesis)
    assert {(ref.phase, ref.branch_id) for ref in refs if ref.phase == "researching"} == {
        ("researching", "sq1"),
        ("researching", "sq2"),
    }
    assert {ref.phase for ref in refs} >= {"synthesizing", "validating"}


def test_terminal_refuses_summary_only_output_as_the_registered_product(cp, project_root):
    research = _start(cp, project_root, constraints={"mode": "quick"})
    synthesis = _single(cp, research, {"explore_complete": True})
    validation = _single(cp, synthesis, {"synthesis_complete": True})
    report = _single(
        cp,
        validation,
        {"verdict": "PASS", "unsupported_claims": [], "evidence": ["all claims matched"]},
    )
    terminal = _single(cp, report, {"write_complete": True})
    assert terminal["action"] == "complete"
    assert terminal["result"]["met"] is False
    assert terminal["result"]["output_artifact_ref"] is not None


def test_memory_absent_terminal_exposes_exact_checkpointed_product_artifact(cp, project_root):
    research = _start(cp, project_root, constraints={"mode": "quick"})
    synthesis = _single(cp, research, {"explore_complete": True})
    validation = _single(cp, synthesis, {"synthesis_complete": True})
    report = _single(
        cp,
        validation,
        {"verdict": "PASS", "unsupported_claims": [], "evidence": ["all claims matched"]},
    )
    summary = {"write_complete": True}
    complete_output = (
        "# report.md\n\nComplete report with citation [1].\n\n"
        "# sources.md\n\n[1] Primary source.\n\n"
        "# README.md\n\nQuery and headline findings.\n\n"
        "SUMMARY:" + json.dumps(summary, separators=(",", ":"))
    )
    terminal = _single(cp, report, summary, output=complete_output)
    assert terminal["action"] == "complete" and terminal["result"]["met"] is True
    assert "room" not in terminal["result"] and "report_drawer_id" not in terminal["result"]

    terminal_ref = ArtifactRef.from_dict(terminal["result"]["output_artifact_ref"])
    selected = [
        ArtifactRef.from_dict(value)
        for value in cp.load(RID).context.extras["artifact_protocol"]["selected_refs"]
        if value["phase"] == "report_writing"
    ]
    assert selected == [terminal_ref]
    assert terminal_ref.phase == "report_writing" and terminal_ref.producer == "agent:skribble"
    assert terminal_ref.consumer_scope == ("state:complete", "state:report_writing")
    stored = (
        ArtifactStore()
        .read_bytes(
            terminal_ref,
            expected_run_id=RID,
            require_selected=True,
        )
        .decode("utf-8")
    )
    assert stored == complete_output
    assert all(name in stored for name in ("# report.md", "# sources.md", "# README.md"))
    assert terminal["result"]["report_files"] == [
        str(Path(terminal["result"]["report_dir"]) / name)
        for name in ("report.md", "sources.md", "README.md")
    ]
