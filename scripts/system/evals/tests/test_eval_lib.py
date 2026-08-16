"""Unit tests for eval_lib: time parsing, outcome parsing, and ratchet logic."""

from datetime import datetime, timezone

import eval_lib
from memory.admin_client import AdminCallResult

from eval_lib import (
    DOWN_GOOD,
    ERROR,
    FAIL,
    KIND_EXPECTED_FAIL,
    KIND_FIXED,
    KIND_IMPROVEMENT,
    KIND_NEW_METRIC,
    KIND_OK,
    KIND_REGRESSION,
    PASS,
    SKIP,
    UP_GOOD,
    EvalResult,
    EvalSkip,
    compare,
    memory_call,
    parse_when,
    run_checks,
    update_baseline,
)


class TestParseWhen:
    def test_iso_with_tz(self):
        dt = parse_when("2026-07-05T19:41:23.628108+00:00")
        assert dt == datetime(2026, 7, 5, 19, 41, 23, 628108, tzinfo=timezone.utc)

    def test_iso_naive_assumed_utc(self):
        dt = parse_when("2026-05-23T09:19:05.780672")
        assert dt is not None and dt.tzinfo is not None

    def test_iso_zulu(self):
        assert parse_when("2026-01-01T00:00:00Z") is not None

    def test_epoch_milliseconds(self):
        dt = parse_when(1783280150510)
        assert dt is not None and dt.year == 2026

    def test_epoch_seconds(self):
        dt = parse_when(1783280150)
        assert dt is not None and dt.year == 2026

    def test_epoch_digit_string(self):
        assert parse_when("1783280150510") is not None

    def test_garbage(self):
        assert parse_when("not a date") is None
        assert parse_when("") is None
        assert parse_when(None) is None


class TestMemoryHubAccess:
    def test_memory_call_uses_injected_http_admin_client(self, monkeypatch):
        class Client:
            def call_tool(self, tool, params):
                assert tool == "mempalace_list_drawers"
                assert params == {"limit": 1}
                return AdminCallResult("request", {"drawers": []})

        monkeypatch.setattr(eval_lib, "_MEMORY_CLIENT", Client())
        assert memory_call("mempalace_list_drawers", {"limit": 1}) == {"drawers": []}


class TestRunChecks:
    def test_skip_and_error_are_captured(self):
        def skipper():
            raise EvalSkip("prerequisite missing")

        def crasher():
            raise RuntimeError("boom")

        def passer():
            return EvalResult(name="x.ok", status=PASS)

        results = run_checks([("x.skip", skipper), ("x.crash", crasher), ("x.ok", passer)])
        by_name = {r.name: r for r in results}
        assert by_name["x.skip"].status == SKIP
        assert by_name["x.crash"].status == ERROR
        assert "boom" in by_name["x.crash"].detail
        assert by_name["x.ok"].status == PASS


def _metric(name, value, direction, status=PASS, informational=False):
    return EvalResult(
        name=name,
        status=status,
        value=value,
        direction=direction,
        unit="fraction",
        informational=informational,
    )


class TestCompare:
    BASELINE = {
        "expected_failures": {"a.known_broken": "seam bug"},
        "metrics": {
            "m.down": {"value": 0.30, "tolerance": 0.05, "direction": DOWN_GOOD},
            "m.up": {"value": 0.80, "tolerance": 0.05, "direction": UP_GOOD},
        },
    }

    def kinds(self, results):
        return {v.result.name: v.kind for v in compare(results, self.BASELINE)}

    def test_new_failure_is_regression(self):
        kinds = self.kinds([EvalResult(name="a.new", status=FAIL)])
        assert kinds["a.new"] == KIND_REGRESSION

    def test_known_failure_is_expected(self):
        kinds = self.kinds([EvalResult(name="a.known_broken", status=FAIL)])
        assert kinds["a.known_broken"] == KIND_EXPECTED_FAIL

    def test_fixed_failure_is_flagged(self):
        kinds = self.kinds([EvalResult(name="a.known_broken", status=PASS)])
        assert kinds["a.known_broken"] == KIND_FIXED

    def test_down_good_metric_regresses_past_tolerance(self):
        kinds = self.kinds([_metric("m.down", 0.40, DOWN_GOOD)])
        assert kinds["m.down"] == KIND_REGRESSION

    def test_down_good_metric_within_tolerance_ok(self):
        kinds = self.kinds([_metric("m.down", 0.34, DOWN_GOOD)])
        assert kinds["m.down"] == KIND_OK

    def test_up_good_metric_regresses(self):
        kinds = self.kinds([_metric("m.up", 0.60, UP_GOOD)])
        assert kinds["m.up"] == KIND_REGRESSION

    def test_improvement_detected(self):
        kinds = self.kinds([_metric("m.up", 0.95, UP_GOOD)])
        assert kinds["m.up"] == KIND_IMPROVEMENT

    def test_unbaselined_metric_is_new(self):
        kinds = self.kinds([_metric("m.fresh", 0.5, DOWN_GOOD)])
        assert kinds["m.fresh"] == KIND_NEW_METRIC

    def test_skip_and_informational_never_gate(self):
        results = [
            EvalResult(name="s.skip", status=SKIP),
            _metric("i.volume", 999.0, DOWN_GOOD, informational=True),
        ]
        kinds = self.kinds(results)
        assert kinds["s.skip"] == KIND_OK
        assert kinds["i.volume"] == KIND_OK


class TestUpdateBaseline:
    def test_new_failure_absorbed_and_pass_removed(self):
        baseline = {"expected_failures": {"a.fixed_now": "old"}, "metrics": {}}
        results = [
            EvalResult(name="a.broken", status=FAIL, detail="why"),
            EvalResult(name="a.fixed_now", status=PASS),
        ]
        updated = update_baseline(baseline, results)
        assert "a.broken" in updated["expected_failures"]
        assert "a.fixed_now" not in updated["expected_failures"]

    def test_metric_ratchet_tightens_only(self):
        baseline = {
            "expected_failures": {},
            "metrics": {"m.down": {"value": 0.30, "tolerance": 0.05, "direction": DOWN_GOOD}},
        }
        worse = update_baseline(baseline, [_metric("m.down", 0.50, DOWN_GOOD)])
        assert worse["metrics"]["m.down"]["value"] == 0.30  # never loosens
        better = update_baseline(baseline, [_metric("m.down", 0.10, DOWN_GOOD)])
        assert better["metrics"]["m.down"]["value"] == 0.10  # tightens

    def test_new_metric_seeded(self):
        updated = update_baseline(
            {"expected_failures": {}, "metrics": {}},
            [_metric("m.new", 0.42, UP_GOOD)],
        )
        assert updated["metrics"]["m.new"]["value"] == 0.42
        assert updated["metrics"]["m.new"]["tolerance"] > 0

    def test_failing_metric_value_not_ratcheted(self):
        updated = update_baseline(
            {"expected_failures": {}, "metrics": {}},
            [_metric("m.fail", 0.9, UP_GOOD, status=FAIL)],
        )
        assert "m.fail" in updated["expected_failures"]
        assert "m.fail" not in updated["metrics"]
