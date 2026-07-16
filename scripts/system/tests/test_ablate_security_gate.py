"""Tests for the security-gate ablation (plan-1784127395250 T8, LOAN disposal).

Proves the ablation's core: with the jsa_poc_artifact_capture harness ON the engine demotes exactly
the claimed-verified findings that have NO captured browser screenshot (the fabrications), and with
it OFF every claim is confirmed — so ON >= OFF and the keep decision is earned by measurement, not
taste. Deterministic + hermetic (no live model).
"""
import os
import sys
from pathlib import Path

ABLATION = Path(__file__).resolve().parent.parent / "ablation"
sys.path.insert(0, str(ABLATION))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps" / "orchestration" / "src"))

import run_security_gate_ablation as sg  # noqa: E402

from orchestration.checkpointer import Checkpointer  # noqa: E402
from orchestration.playbooks.jsa import JSAPlaybook  # noqa: E402


def _run(tmp_path):
    cp = Checkpointer(db_path=tmp_path / "orch.db")
    pb = JSAPlaybook(cp)
    pb._poc_force_real = True  # bypass the pytest hermetic guard -> exercise the REAL artifact check
    return sg.run(tmp_path, pb)


def test_harness_on_catches_every_fabrication(tmp_path):
    on = _run(tmp_path)["summary"]["harness_on"]
    assert on["cases_correct"] == on["n"]
    assert on["fabrications_missed"] == 0


def test_harness_off_lets_fabrications_through(tmp_path):
    off = _run(tmp_path)["summary"]["harness_off"]
    assert off["fabrications_missed"] > 0
    assert off["cases_correct"] < off["n"]


def test_decision_is_keep_default_on(tmp_path):
    data = _run(tmp_path)
    assert data["decision"].startswith("KEEP")
    assert data["knob"] == "jsa_poc_artifact_capture"
    assert data["summary"]["harness_on"]["case_accuracy"] >= data["summary"]["harness_off"]["case_accuracy"]


def test_on_demotes_exactly_the_artifactless_findings_per_case(tmp_path):
    for row in _run(tmp_path)["per_case"]:
        assert row["harness_on"]["demoted"] == row["truth_demoted"]
        assert row["harness_on"]["correct"] is True


def test_arm_toggling_restores_the_env_and_renders(tmp_path):
    before = os.environ.get(sg.ENV)
    data = _run(tmp_path)
    assert os.environ.get(sg.ENV) == before  # each arm restores the LOAN toggle it flipped
    assert "jsa_poc_artifact_capture" in sg.render(data)
