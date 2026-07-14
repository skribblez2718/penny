"""Opt-in LIVE smoke test for the imagegen skill against a real ComfyUI.

Skipped unless ``PENNY_IMAGEGEN_LIVE=1`` — the default CI / ``make test`` run
never touches the GPU service. When enabled, it drives the REAL seams
(``_check_readiness`` + ``_comfy_generate``) against ``http://127.0.0.1:8188``,
routing to the safe ``general-flux`` preset, generating a single candidate, and
asserting a PNG + manifest were produced. This is the only test with a live
dependency; it exists so a human can prove the wiring end-to-end on demand.

Run it explicitly:

    PENNY_IMAGEGEN_LIVE=1 pytest apps/orchestration/tests/test_imagegen_live_smoke.py -q
"""

import os
from pathlib import Path

import pytest
from orchestration.checkpointer import Checkpointer
from orchestration.playbooks.imagegen import ImagegenPlaybook

pytestmark = pytest.mark.skipif(
    os.environ.get("PENNY_IMAGEGEN_LIVE") != "1",
    reason="live ComfyUI smoke test — set PENNY_IMAGEGEN_LIVE=1 to enable",
)

PROJECT_ROOT = str(Path(__file__).resolve().parents[3])


@pytest.mark.integration
def test_live_general_flux_single_candidate(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    pb = ImagegenPlaybook(cp)
    directive = pb.start(
        session_id="live-smoke",
        run_id="live-smoke-run",
        goal="a simple red circle on a dark background, no text",
        project_root=PROJECT_ROOT,
        constraints={"count": 1, "output_dir": str(tmp_path / "out")},
    )
    # If ComfyUI is down, start() fails fast with an actionable error — surface it.
    if directive["action"] == "error":
        pytest.fail(f"readiness failed: {directive['errors']}")
    assert directive["action"] == "invoke_agent" and directive["state_id"] == "framing"

    # Drive the interpretive agent states with minimal canned SUMMARYs; the TOOL
    # states (generating/presenting) run the REAL comfy_http client.
    pb2 = ImagegenPlaybook(cp)
    pb2.step(
        session_id="live-smoke",
        run_id="live-smoke-run",
        agent="annie",
        result={"frame_complete": True, "confidence": "CERTAIN"},
    )
    crit = ImagegenPlaybook(cp).step(
        session_id="live-smoke",
        run_id="live-smoke-run",
        agent="synthia",
        result={
            "compose_complete": True,
            "confidence": "CERTAIN",
            "positive_prompt": "a simple red circle on a dark background",
            "negative_prompt": "text, words, letters, watermark",
        },
    )
    assert crit["action"] == "invoke_agents_parallel"

    done = ImagegenPlaybook(cp).step(
        session_id="live-smoke",
        run_id="live-smoke-run",
        agent="__parallel__",
        result=[
            {
                "branch_id": "vera",
                "agent": "vera",
                "summary": {"verdict": "APPROVE", "confidence": "CERTAIN", "valid_candidates": [0]},
                "exitCode": 0,
            },
            {
                "branch_id": "carren",
                "agent": "carren",
                "summary": {"verdict": "APPROVE", "confidence": "CERTAIN"},
                "exitCode": 0,
            },
        ],
    )
    assert done["action"] == "complete"
    best = done["result"]["best_candidate"]
    assert best and best["files"], "expected at least one rendered PNG file"
    assert Path(best["files"][0]).exists()
    assert Path(done["result"]["manifest_path"]).exists()
