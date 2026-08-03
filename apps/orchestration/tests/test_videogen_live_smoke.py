"""Opt-in live ``videogen`` integration smoke.

The test contains no service URL, voice, theme, profile, section, or output
value. The caller supplies one absolute JSON file through
``VIDEOGEN_LIVE_CONSTRAINTS_FILE``. Its exact wrapper is::

    {
      "goal": "<caller goal>",
      "constraints": {"<complete videogen constraint contract>": "..."},
      "agent_summaries": {
        "INGEST": {"...": "..."},
        "STORYBOARD": {"...": "..."},
        "NARRATION_SCRIPT:synthia": {"...": "..."},
        "NARRATION_SCRIPT:carren": {"...": "..."},
        "CODEGEN": {"...": "..."},
        "AUTO_QA": {"...": "..."}
      }
    }

Each summary value may instead be an absolute path to a JSON object. Agent
artifacts and hashes are caller-owned; deterministic phases use the real service
and media seams. The test stops at the durable operator-review pause.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.videogen import VideogenPlaybook

LIVE_ENABLED = os.environ.get("PENNY_VIDEOGEN_LIVE") == "1"
CONSTRAINTS_FILE = os.environ.get("VIDEOGEN_LIVE_CONSTRAINTS_FILE", "")
PROJECT_ROOT = Path(__file__).resolve().parents[3]

pytestmark = [
    pytest.mark.integration,
    pytest.mark.network,
    pytest.mark.slow,
    pytest.mark.skipif(
        not LIVE_ENABLED or not CONSTRAINTS_FILE,
        reason=(
            "live videogen smoke requires PENNY_VIDEOGEN_LIVE=1 and "
            "VIDEOGEN_LIVE_CONSTRAINTS_FILE"
        ),
    ),
]


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        pytest.fail(f"{label} must be a JSON object")
    return dict(value)


def _load_external_input() -> dict[str, Any]:
    path = Path(CONSTRAINTS_FILE)
    if not path.is_absolute() or not path.is_file():
        pytest.fail("VIDEOGEN_LIVE_CONSTRAINTS_FILE must name an existing absolute file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        pytest.fail(f"cannot load live constraints JSON: {exc}")
    payload = _object(value, "live input")
    if set(payload) != {"goal", "constraints", "agent_summaries"}:
        pytest.fail("live input must have exact goal/constraints/agent_summaries keys")
    if not isinstance(payload["goal"], str) or not payload["goal"].strip():
        pytest.fail("live input goal must be nonempty")
    _object(payload["constraints"], "live constraints")
    summaries = _object(payload["agent_summaries"], "live agent_summaries")
    required = {
        "INGEST",
        "STORYBOARD",
        "NARRATION_SCRIPT:synthia",
        "NARRATION_SCRIPT:carren",
        "CODEGEN",
        "AUTO_QA",
    }
    if set(summaries) != required:
        pytest.fail(f"live agent_summaries must have exact keys {sorted(required)}")
    return payload


def _summary(payload: Mapping[str, Any], key: str) -> dict[str, Any]:
    value = payload["agent_summaries"][key]
    if isinstance(value, str):
        path = Path(value)
        if not path.is_absolute() or not path.is_file():
            pytest.fail(f"agent summary {key} path must be an existing absolute file")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            pytest.fail(f"cannot load agent summary {key}: {exc}")
    return _object(value, f"agent summary {key}")


def _step(cp: Checkpointer, agent: str, result: Any) -> dict[str, Any]:
    return VideogenPlaybook(cp).step(
        session_id="videogen-live-smoke",
        run_id="videogen-live-smoke-run",
        agent=agent,
        result=result,
    )


def _parallel(cp: Checkpointer, branch: str, agent: str, summary: Mapping[str, Any]):
    return _step(
        cp,
        "__parallel__",
        [{"branch_id": branch, "agent": agent, "summary": dict(summary), "exitCode": 0}],
    )


def test_live_services_to_durable_operator_review(tmp_path: Path) -> None:
    payload = _load_external_input()
    cp = Checkpointer(db_path=tmp_path / "videogen-live.db")
    started = VideogenPlaybook(cp).start(
        session_id="videogen-live-smoke",
        run_id="videogen-live-smoke-run",
        goal=payload["goal"],
        constraints=_object(payload["constraints"], "live constraints"),
        project_root=str(PROJECT_ROOT),
    )
    if started["action"] == "error":
        pytest.fail(f"live readiness failed: {started['errors']}")
    assert started["state_id"] == "INGEST" and started["agent"] == "annie"

    rec = cp.load("videogen-live-smoke-run")
    vg = rec.context.extras["videogen"]
    readiness_ref = vg["phase_state"]["latest_summary_refs"]["state:readiness"]
    readiness = json.loads(Path(readiness_ref["path"]).read_text(encoding="utf-8"))
    assert readiness["superpose"]["health"]["ok"] is True
    assert readiness["schema_sha256"] == vg["hashes"]["schema"]
    assert Path(readiness["schema_snapshot_path"]).is_file()

    assert _step(cp, "annie", _summary(payload, "INGEST"))["state_id"] == "STORYBOARD"
    assert _step(cp, "synthia", _summary(payload, "STORYBOARD"))["state_id"] == "NARRATION_SCRIPT"
    assert _parallel(
        cp,
        "synthia",
        "synthia",
        _summary(payload, "NARRATION_SCRIPT:synthia"),
    )["state_id"] == "NARRATION_SCRIPT"
    codegen = _parallel(
        cp,
        "carren",
        "carren",
        _summary(payload, "NARRATION_SCRIPT:carren"),
    )
    assert codegen["state_id"] == "CODEGEN"
    auto_qa = _step(cp, "skribble", _summary(payload, "CODEGEN"))
    assert auto_qa["state_id"] == "AUTO_QA"
    gate = _step(cp, "vera", _summary(payload, "AUTO_QA"))

    rec = cp.load("videogen-live-smoke-run")
    vg = rec.context.extras["videogen"]
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "OPERATOR_REVIEW"
    assert gate["action"] == "escalate_to_user"
    assert gate["questions"][0]["packet"]["gate"] == "operator_review"

    journals = []
    for path in (Path(vg["paths"]["workspace_dir"]) / "operation-journal").glob("*.json"):
        value = json.loads(path.read_text(encoding="utf-8"))
        if "operation" in value:
            journals.append((path, value))
    operations = {value["operation"] for _, value in journals}
    assert {"create_narration", "submit_tts", "import_bundle", "render_project"} <= operations
    carren_ref = vg["phase_state"]["latest_summary_refs"]["NARRATION_SCRIPT:carren"]
    first_tts_mtime = min(
        path.stat().st_mtime_ns
        for path, value in journals
        if value["operation"] in {"create_narration", "submit_tts"}
    )
    assert Path(carren_ref["path"]).stat().st_mtime_ns <= first_tts_mtime
    assert all(
        value["state"] == "terminal" and value["disposition"] == "succeeded"
        for _, value in journals
        if value["operation"] in {"import_bundle", "render_project"}
    )
    assert vg["service_ledger"]["superpose_project_id"]
    assert (Path(vg["paths"]["bundle"]) / "manifest.json").is_file()
    assert Path(vg["paths"]["draft_video"]).is_file()
    assert Path(vg["paths"]["draft_captions"]).is_file()
    assert Path(vg["paths"]["draft_video"]).suffix == ".mp4"
    assert Path(vg["paths"]["draft_captions"]).suffix == ".vtt"
    assert vg["qa"]["verdict"] == "PASS"
    assert Path(vg["qa"]["report_path"]).is_file()
    assert Path(vg["review"]["packet_path"]).is_file()
    assert vg["review"]["packet_sha256"]
