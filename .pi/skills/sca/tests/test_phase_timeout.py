"""
Regression tests for operator-configurable per-phase timeouts (F6).

The scanners (P2/P7) and the Docker PoC sandbox (P10) already bound their own
subprocesses (a runaway scan/PoC times out and degrades rather than hanging).
These tests pin that those bounds are now CONFIGURABLE via run constraints
(carried on ``meta``), defaulting to the modules' own values when unset so an
unset constraint changes nothing.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sca_domain  # noqa: E402


class TestTimeoutHelpers:
    def test_scan_timeout_default_when_unset(self):
        assert sca_domain.scan_timeout({}) == sca_domain.SCAN_TIMEOUT_DEFAULT
        assert (
            sca_domain.scan_timeout({"scan_timeout": None})
            == sca_domain.SCAN_TIMEOUT_DEFAULT
        )

    def test_scan_timeout_honors_valid_constraint(self):
        assert sca_domain.scan_timeout({"scan_timeout": 120}) == 120
        assert sca_domain.scan_timeout({"scan_timeout": "90"}) == 90  # coerced

    def test_scan_timeout_rejects_invalid_and_nonpositive(self):
        d = sca_domain.SCAN_TIMEOUT_DEFAULT
        assert sca_domain.scan_timeout({"scan_timeout": 0}) == d
        assert sca_domain.scan_timeout({"scan_timeout": -5}) == d
        assert sca_domain.scan_timeout({"scan_timeout": "nope"}) == d

    def test_poc_timeout_default_and_override(self):
        assert sca_domain.poc_timeout({}) == sca_domain.POC_TIMEOUT_DEFAULT
        assert sca_domain.poc_timeout({"poc_timeout": 30}) == 30
        assert sca_domain.poc_timeout({"poc_timeout": -1}) == sca_domain.POC_TIMEOUT_DEFAULT


def _capturing_sandbox(captured):
    def fake_sandbox(script, target_path, *, timeout_s=60, docker_available_check=None, **kw):
        captured["timeout_s"] = timeout_s
        return {
            "exit_code": 0,
            "timed_out": False,
            "sandbox_used": True,
            "duration_s": 0.0,
            "reason": "",
            "stdout": "",
            "stderr": "",
        }

    return fake_sandbox


def _poc_result():
    return {
        "run_pocs": [
            {
                "name": "poc1",
                "script": "echo hi",
                "finding_id": "F-1",
                "non_destructive": True,
            }
        ]
    }


def test_process_verification_pocs_plumbs_configured_poc_timeout(tmp_path):
    captured: dict = {}
    meta = {
        "output_dir": str(tmp_path / "out"),
        "target_path": str(tmp_path / "repo"),
        "session_id": "s",
        "poc_timeout": 25,
    }
    sca_domain.process_verification_pocs(
        meta,
        _poc_result(),
        sandbox_runner=_capturing_sandbox(captured),
        docker_available_check=lambda: True,
    )
    assert captured["timeout_s"] == 25


def test_process_verification_pocs_defaults_poc_timeout_when_unset(tmp_path):
    captured: dict = {}
    meta = {
        "output_dir": str(tmp_path / "out"),
        "target_path": str(tmp_path / "repo"),
        "session_id": "s",
    }
    sca_domain.process_verification_pocs(
        meta,
        _poc_result(),
        sandbox_runner=_capturing_sandbox(captured),
        docker_available_check=lambda: True,
    )
    assert captured["timeout_s"] == sca_domain.POC_TIMEOUT_DEFAULT
