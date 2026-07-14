"""Tests for the code_detection ablation harness (Bitter-Lesson item #3, Part A).

Verifies the harness end-to-end without a live model call (fake pi runner), and
proves the core value: the hand-coded tables MISS a framework (`hono`) that a
model reading the files catches — the ship evidence for retiring the tables.
"""
import json
import sys
import types
from pathlib import Path

ABLATION = Path(__file__).resolve().parent.parent / "ablation"
sys.path.insert(0, str(ABLATION))

import ablate_lib as al  # noqa: E402
import detectors as det  # noqa: E402

FIXTURES = ABLATION / "fixtures" / "code_detection"


def _fake_pi_runner():
    """subprocess.run stand-in: reads the detection prompt (last cmd arg) and
    returns a `pi --mode json` stream whose assistant message is the CORRECT JSON."""

    def run(cmd, **kwargs):
        prompt = cmd[-1].lower()
        if "hono" in prompt:
            obj = {"is_server": True, "language": "typescript", "framework": "hono"}
        elif "fastapi" in prompt:
            obj = {"is_server": True, "language": "python", "framework": "fastapi"}
        else:
            obj = {"is_server": False, "language": None, "framework": None}
        stream = json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": json.dumps(obj)}],
                },
            }
        )
        return types.SimpleNamespace(stdout=stream, returncode=0)

    return run


class TestCasesAndScoring:
    def test_load_cases(self):
        names = {c.name for c in al.load_cases(FIXTURES)}
        assert {"fastapi_service", "hono_api", "click_cli"} <= names

    def test_graded_fields_skip_when_not_server(self):
        assert al.graded_fields({"is_server": False}, det.FIELDS) == ["is_server"]
        assert al.graded_fields({"is_server": True}, det.FIELDS) == det.FIELDS

    def test_score_case_case_insensitive(self):
        scores = al.score_case(
            {"is_server": True, "language": "Python", "framework": "FastAPI"},
            {"is_server": True, "language": "python", "framework": "fastapi"},
            det.FIELDS,
        )
        assert all(scores.values())


class TestHeuristicArmSurfacesRot:
    def test_heuristic_misses_hono_but_gets_the_rest(self):
        cases = al.load_cases(FIXTURES)
        by_name = {r.case: r for r in al.run_arm(cases, det.heuristic_detector, det.FIELDS)}
        assert by_name["fastapi_service"].correct is True
        assert by_name["click_cli"].correct is True
        # the rot: hono is not in the hand-coded tables, so the heuristic misses it
        assert by_name["hono_api"].correct is False
        assert by_name["hono_api"].pred["is_server"] is False


class TestModelArmPipeline:
    def test_model_detector_parses_and_beats_heuristic(self):
        cases = al.load_cases(FIXTURES)
        model = det.model_detector_factory(runner=_fake_pi_runner())
        data = al.run_ablation(
            cases, {"heuristic": det.heuristic_detector, "model": model}, det.FIELDS
        )
        assert data["summary"]["heuristic"]["cases_correct"] == 2
        assert data["summary"]["model"]["cases_correct"] == 3
        hono = next(r for r in data["per_case"] if r["case"] == "hono_api")
        assert hono["heuristic"]["correct"] is False
        assert hono["model"]["correct"] is True

    def test_model_detector_records_bad_stream_as_miss(self):
        def bad_runner(cmd, **kwargs):
            return types.SimpleNamespace(stdout="not json\n", returncode=0)

        model = det.model_detector_factory(runner=bad_runner)
        results = al.run_arm(al.load_cases(FIXTURES), model, det.FIELDS)
        assert all(r.error for r in results)  # recorded, never a crash


class TestArtifactAndReport:
    def test_report_and_artifact(self, tmp_path):
        cases = al.load_cases(FIXTURES)
        data = al.run_ablation(cases, {"heuristic": det.heuristic_detector}, det.FIELDS)
        assert "code_detection" in al.render_report(data)
        out = tmp_path / "latest.json"
        al.write_artifact(out, data)
        assert json.loads(out.read_text())["summary"]["heuristic"]["n"] == len(cases)


class TestInvalidators:
    def test_fingerprint_files(self, tmp_path):
        import hashlib

        f = tmp_path / "sub" / "code_detection.py"
        f.parent.mkdir(parents=True)
        f.write_text("print('x')", encoding="utf-8")
        out = al.fingerprint_files([f], tmp_path)
        assert out == [
            {"path": "sub/code_detection.py", "sha256": hashlib.sha256(b"print('x')").hexdigest()}
        ]
