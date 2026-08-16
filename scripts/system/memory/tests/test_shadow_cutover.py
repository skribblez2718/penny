from __future__ import annotations

import json
from pathlib import Path

import pytest
from statemachine.exceptions import TransitionNotAllowed

from memory.canary_cutover import CanaryCutoverMachine
from memory.cutover_cli import main as cutover_main
from memory.cutover_config import CutoverConfig
from memory.shadow_compare import run_shadow_comparison
from memory.tests.fake_hub import FakeHub
from memory.tests.test_cutover_faults import _write_json, build_cutover_config


def _authority_receipt(path: Path, config_sha: str, config: CutoverConfig) -> Path:
    cutover = config
    return _write_json(
        path,
        {
            "schema_version": 1,
            "receipt_type": "memory-authority-approval",
            "cutover_id": cutover.cutover_id,
            "authority_role": "source",
            "palace_id": cutover.source.palace_id,
            "hub_config_sha256": config_sha,
            "sole_writer": True,
            "no_fallback": True,
            "approved": True,
            "approved_by": "synthetic-owner",
            "approved_at": "2026-08-15T12:00:00Z",
        },
    )


def test_shadow_compares_exact_ids_content_ranking_and_fixture_latency(
    tmp_path: Path,
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        source.state.search_results = [
            {"id": "drawer-a", "content": "alpha"},
            {"id": "drawer-b", "content": "beta"},
        ]
        candidate.state.search_results = [
            {"id": "drawer-b", "content": "beta"},
            {"id": "drawer-a", "content": "alpha"},
        ]
        authority = _authority_receipt(
            tmp_path / "source-authority.json",
            config.source.config_sha256,
            config,
        )

        passed = run_shadow_comparison(
            config,
            authority,
            tmp_path / "shadow-pass.json",
        )
        candidate.state.search_results[1]["content"] = "changed"
        refused = run_shadow_comparison(
            config,
            authority,
            tmp_path / "shadow-refused.json",
        )

        assert passed["passed"] is True
        assert passed["candidate_write_count"] == 0
        assert passed["comparisons"][0]["id_set_equal"] is True
        assert passed["comparisons"][0]["content_equal"] is True
        assert passed["comparisons"][0]["max_rank_displacement"] == 1
        assert passed["comparisons"][0]["ranking_within_tolerance"] is True
        assert refused["passed"] is False
        assert refused["mismatch_count"] == 1
        assert refused["comparisons"][0]["content_equal"] is False
        assert source.state.write_calls == 0
        assert candidate.state.write_calls == 0


def test_canary_state_machine_cannot_skip_qualification_drain_or_final_delta() -> None:
    machine = CanaryCutoverMachine()

    with pytest.raises(TransitionNotAllowed):
        machine.send("start_canary")
    machine.send("qualify")
    with pytest.raises(TransitionNotAllowed):
        machine.send("start_canary")
    machine.send("drain")
    with pytest.raises(TransitionNotAllowed):
        machine.send("start_canary")
    machine.send("final_delta")
    machine.send("start_canary")
    assert machine.current_state_value == "canary"
    machine.send("rollback_before_write")

    assert machine.current_state_value == "rolled_back"


def test_plan_and_status_are_local_only_and_keep_live_cycles_not_run(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
    assert cutover_main(["--config", str(config.config_path), "plan"]) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["commands_are_non_mutating_by_default"] is True
    assert plan["live_peak_cycle"] == "NOT RUN"
    assert plan["maintenance_cycle"] == "NOT RUN"

    assert cutover_main(["--config", str(config.config_path), "status"]) == 0
    status = json.loads(capsys.readouterr().out)
    assert status["state"] == "draft"
    assert status["authority_role"] == "none"
    assert status["accepted_write_count"] == 0


def test_shadow_fixture_cannot_declare_configured_write_tool(tmp_path: Path) -> None:
    with FakeHub() as source, FakeHub() as candidate:
        config = build_cutover_config(tmp_path, source, candidate)
        document = json.loads(config.shadow_fixtures_path.read_text(encoding="utf-8"))
        document["read_tools"] = ["fixture_write"]
        document["fixtures"][0]["tool"] = "fixture_write"
        config.shadow_fixtures_path.write_text(json.dumps(document), encoding="utf-8")
        authority = _authority_receipt(
            tmp_path / "source-authority.json",
            config.source.config_sha256,
            config,
        )

        with pytest.raises(ValueError, match="write tools"):
            run_shadow_comparison(config, authority, tmp_path / "must-not-exist.json")
