"""
Orchestrator unit tests for the jsa skill start/step/status protocol.

Tests the Penny skill CLI protocol:
  start()  -> first action dict
  step(agent, result) -> next action dict
  extract_state() -> dict for mempalace persistence
  restore_state(data) -> resume from persisted state
"""

import json
import shutil
import sys
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))


from orchestrate import (
    JSAPipelineOrchestrator,
    SCRIPT_SRC_RE,
    INLINE_SCRIPT_RE,
    _is_js_file_url,
    _is_out_of_scope,
    main,
)
from fsm import JSAPhase

# ── Katana mock: a single meaningful HTML page with forms, fetch(),
# external + inline scripts, and a link — covers all classification paths.
KATANA_MOCK_ENTRY = {
    "timestamp": "2026-06-01T00:00:00Z",
    "request": {"method": "GET", "endpoint": "https://ginandjuice.shop/"},
    "response": {
        "status_code": 200,
        "headers": {"Content-Type": "text/html"},
        "body": (
            '<!DOCTYPE html><html><head><title>Gin and Juice</title></head>'
            '<body>'
            '<form action="/login" method="POST">'
            '<input type="text" name="user">'
            '<input type="password" name="pass">'
            '</form>'
            '<script>var x = 1; fetch("/api/user");</script>'
            '<a href="/products">Products</a>'
            '</body></html>'
        ),
        "content_length": 300,
    },
}
KATANA_MOCK = [KATANA_MOCK_ENTRY]


class TestStartProtocol:
    def test_start_without_intake_returns_instructions(self):
        """Without pre-collected intake data, start() returns
        escalate_to_user with a questions array for the missing fields.

        The skill extension routes this to Penny, who invokes the
        questionnaire tool and feeds the answers back via step --agent user.
        """
        orch = JSAPipelineOrchestrator(
            session_id="test-001",
            goal="Analyze JS on https://example.com",
            constraints={"output_dir": "/tmp/jsa-test-001"},
        )
        action = orch.start()
        # target_url is auto-extracted from goal, but auth + session are
        # still missing → escalation is required
        assert action["action"] == "escalate_to_user"
        assert action["state_id"] == "INTAKE"
        assert "questions" in action
        assert len(action["questions"]) >= 1
        # Verify the questions have the right shape
        for q in action["questions"]:
            assert "id" in q
            assert "label" in q
            assert "prompt" in q
            assert "options" in q
            assert "allowOther" in q
            assert q["allowOther"] is True
        assert action["session_id"] == "test-001"
        assert "orchestrator_state" in action
    def test_start_with_intake_advances_to_stop(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            """With pre-collected intake data, start() runs through local phases.
            May reach SAST_VALIDATE, STOP, or complete."""
            orch = JSAPipelineOrchestrator(
                session_id="test-002",
                goal="https://example.com",
                constraints={"intake": {
                    "target_url": "https://example.com",
                    "authenticated_testing": "anonymous_only",
                    "session_management": "cookie",
                }},
            )
            action = orch.start()
            # With intake data, runs through ACQUIRE→CVE→SAST→... hits SAST_VALIDATE or STOP
            assert action["action"] in ("escalate_to_user", "complete", "invoke_agent")
            assert action["session_id"] == "test-002"
            # Verify intake was processed
            intake = orch.state.metadata.get("intake", {})
            assert intake["target_url"] == "https://example.com"
            assert intake["session_management"] == "cookie"

    def test_action_has_required_keys(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="test-003",
                goal="https://example.com",
                constraints={"intake": {
                    "target_url": "https://example.com",
                    "authenticated_testing": "anonymous_only",
                    "session_management": "cookie",
                }},
            )
            action = orch.start()
            required = {"action", "state_id", "session_id", "description", "orchestrator_state"}
            assert required.issubset(action.keys())

    def test_step_with_intake_data_advances_to_stop(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            """start() with intake → auto-advances through locals to SAST_VALIDATE or STOP."""
            orch = JSAPipelineOrchestrator(
                session_id="test-intake-step",
                goal="https://ginandjuice.shop",
                constraints={"intake": {
                    "target_url": "https://ginandjuice.shop",
                    "out_of_scope": "https://ginandjuice.shop/vulnerabilities",
                    "authenticated_testing": "both",
                    "auth_instructions": "login at /login with test:test",
                    "roles": "admin\nuser",
                    "session_management": "cookie",
                    "session_details": "sessionid cookie, HttpOnly",
                }},
            )
            action = orch.start()
            # With intake data, runs through locals, hits SAST_VALIDATE or STOP.
            # The next action may be:
            #   - escalate_to_user  (STOP checkpoint for user inspection)
            #   - complete          (pipeline finished)
            #   - invoke_agent      (single agent dispatch)
            #   - invoke_agents_parallel (batch dispatch: CVE_RESEARCH PoC, DISPATCH waves)
            assert action["action"] in (
                "escalate_to_user", "complete", "invoke_agent", "invoke_agents_parallel"
            )
            # Verify intake data was stored
            intake = orch.state.metadata.get("intake", {})
            assert intake["target_url"] == "https://ginandjuice.shop"
            assert intake["session_management"] == "cookie"
            assert intake["roles"] == ["admin", "user"]



class TestIntakeEscalation:
    """INTAKE validates target configuration and, when required fields
    are missing, escalates to the user via the canonical
    `escalate_to_user` action with a `questions` array. The skill tool
    routes this to Penny, who invokes the questionnaire tool and feeds
    the answers back via `step --agent user`.
    """

    def _missing_field_ids(self, action: dict) -> set[str]:
        """Helper: extract the set of question IDs (field keys) from an
        escalate_to_user action."""
        return {q["id"] for q in action.get("questions", [])}

    def test_no_intake_returns_escalate_to_user(self):
        """No constraints at all → INTAKE returns escalate_to_user with
        a question for each missing required field (target_url is
        auto-extracted from goal; auth + session are still missing)."""
        orch = JSAPipelineOrchestrator(
            session_id="e-001",
            goal="Analyze JS on https://example.com",
            constraints={"output_dir": "/tmp/jsa-e-001"},
        )
        action = orch.start()
        assert action["action"] == "escalate_to_user"
        assert action["state_id"] == "INTAKE"
        missing = self._missing_field_ids(action)
        # target_url is auto-filled from goal, so only auth + session are missing
        assert "authenticated_testing" in missing
        assert "session_management" in missing
        assert "target_url" not in missing
        # Pipeline is still at INTAKE
        assert orch.fsm.phase == JSAPhase.INTAKE

    def test_escalation_questions_have_correct_shape(self):
        """Each question in the escalation has the right shape for the
        skill extension's questionnaire routing."""
        orch = JSAPipelineOrchestrator(
            session_id="e-002",
            goal="Analyze JS on https://example.com",
            constraints={"output_dir": "/tmp/jsa-e-002"},
        )
        action = orch.start()
        for q in action["questions"]:
            assert set(q.keys()) >= {"id", "label", "prompt", "options", "allowOther"}
            assert q["allowOther"] is True  # "Type something" always available
            assert isinstance(q["options"], list)
            assert isinstance(q["prompt"], str)

    def test_all_required_fields_advances_to_acquire(self):
        """When all required fields are present, INTAKE auto-advances
        through ACQUIRE and the pipeline runs through local phases."""
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="e-003",
                goal="https://example.com",
                constraints={
                    "intake": {
                        "target_url": "https://example.com",
                        "authenticated_testing": "anonymous_only",
                        "session_management": "cookie",
                    },
                },
            )
            action = orch.start()
            # Pipeline advanced past INTAKE
            assert action["action"] in ("invoke_agent", "complete")
            assert orch.fsm.phase != JSAPhase.INTAKE

    def test_authenticated_requires_auth_instructions(self):
        """If authenticated_testing is 'both' or 'authenticated_only',
        auth_instructions becomes required and triggers an escalation."""
        orch = JSAPipelineOrchestrator(
            session_id="e-004",
            goal="https://example.com",
            constraints={
                "intake": {
                    "target_url": "https://example.com",
                    "authenticated_testing": "authenticated_only",
                    "session_management": "cookie",
                    # auth_instructions deliberately missing
                },
                "output_dir": "/tmp/jsa-e-004",
            },
        )
        action = orch.start()
        assert action["action"] == "escalate_to_user"
        assert "auth_instructions" in self._missing_field_ids(action)

    def test_anonymous_does_not_require_auth_instructions(self):
        """If authenticated_testing is 'anonymous_only', auth_instructions
        is NOT required and the pipeline advances."""
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="e-005",
                goal="https://example.com",
                constraints={
                    "intake": {
                        "target_url": "https://example.com",
                        "authenticated_testing": "anonymous_only",
                        "session_management": "cookie",
                        # No auth_instructions — that's fine for anonymous
                    },
                },
            )
            action = orch.start()
            assert action["action"] in ("invoke_agent", "complete")
            assert orch.fsm.phase != JSAPhase.INTAKE

    def test_invalid_auth_mode_triggers_escalation(self):
        """Invalid authenticated_testing values are treated as missing."""
        orch = JSAPipelineOrchestrator(
            session_id="e-006",
            goal="https://example.com",
            constraints={
                "intake": {
                    "target_url": "https://example.com",
                    "authenticated_testing": "yes please",  # invalid
                    "session_management": "cookie",
                },
                "output_dir": "/tmp/jsa-e-006",
            },
        )
        action = orch.start()
        assert action["action"] == "escalate_to_user"
        assert "authenticated_testing" in self._missing_field_ids(action)

    def test_invalid_session_management_triggers_escalation(self):
        """Invalid session_management values are treated as missing."""
        orch = JSAPipelineOrchestrator(
            session_id="e-007",
            goal="https://example.com",
            constraints={
                "intake": {
                    "target_url": "https://example.com",
                    "authenticated_testing": "anonymous_only",
                    "session_management": "magic-cookie",  # invalid
                },
                "output_dir": "/tmp/jsa-e-007",
            },
        )
        action = orch.start()
        assert action["action"] == "escalate_to_user"
        assert "session_management" in self._missing_field_ids(action)

    def test_invalid_target_url_triggers_escalation(self):
        """target_url must be a non-empty http(s) URL."""
        orch = JSAPipelineOrchestrator(
            session_id="e-008",
            goal="Analyze a non-URL goal",  # no http(s) in goal
            constraints={
                "intake": {
                    "target_url": "not-a-url",  # invalid
                    "authenticated_testing": "anonymous_only",
                    "session_management": "cookie",
                },
                "output_dir": "/tmp/jsa-e-008",
            },
        )
        action = orch.start()
        assert action["action"] == "escalate_to_user"
        assert "target_url" in self._missing_field_ids(action)

    def test_top_level_constraints_are_merged_into_intake(self):
        """Auth/session fields can be passed at the top level of
        constraints (not nested under intake) and they should be merged
        into the intake record."""
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="e-009",
                goal="https://example.com",
                constraints={
                    "authenticated_testing": "anonymous_only",
                    "session_management": "cookie",
                    "output_dir": "/tmp/jsa-e-009",
                },
            )
            action = orch.start()
            intake = orch.state.metadata.get("intake", {})
            assert intake.get("authenticated_testing") == "anonymous_only"
            assert intake.get("session_management") == "cookie"
            assert intake.get("target_url") == "https://example.com"
            # Pipeline should advance
            assert action["action"] in ("invoke_agent", "complete")

    def test_explicit_intake_overrides_top_level(self):
        """If a user passes BOTH constraints.intake.foo and constraints.foo,
        the explicit intake value wins."""
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="e-010",
                goal="https://example.com",
                constraints={
                    "authenticated_testing": "anonymous_only",  # top-level
                    "session_management": "cookie",
                    "intake": {
                        "authenticated_testing": "both",  # overrides top-level
                        "auth_instructions": "POST /login with admin:admin",
                    },
                    "output_dir": "/tmp/jsa-e-010",
                },
            )
            orch.start()
            intake = orch.state.metadata.get("intake", {})
            assert intake.get("authenticated_testing") == "both"
            assert intake.get("auth_instructions") == "POST /login with admin:admin"

    def test_step_user_feeds_back_intake_answers(self):
        """Simulate the user-escalation feedback loop: start() escalates,
        then step(agent='user', result=answers) processes the answers
        and advances to ACQUIRE."""
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="e-011",
                goal="https://example.com",
                constraints={"output_dir": "/tmp/jsa-e-011"},
            )
            # First call: INTAKE escalates
            action1 = orch.start()
            assert action1["action"] == "escalate_to_user"

            # Simulate user feedback: answers shaped as the questionnaire tool
            # would return them
            user_answers = {
                "target_url": "https://example.com",
                "authenticated_testing": "both",
                "session_management": "cookie",
                "auth_instructions": "POST /login with test:test",
            }
            action2 = orch.step("user", user_answers)
            # Pipeline should now have advanced past INTAKE
            assert action2["action"] in ("invoke_agent", "complete")
            assert orch.fsm.phase != JSAPhase.INTAKE
            # Intake record should reflect the answers
            intake = orch.state.metadata.get("intake", {})
            assert intake.get("authenticated_testing") == "both"
            assert intake.get("auth_instructions") == "POST /login with test:test"

    def test_escalation_previous_state_set(self):
        """The escalate_to_user action sets previous_state to 'INTAKE' so
        the skill tool can resume the FSM correctly after the user
        answers."""
        orch = JSAPipelineOrchestrator(
            session_id="e-012",
            goal="Analyze JS on https://example.com",
            constraints={"output_dir": "/tmp/jsa-e-012"},
        )
        action = orch.start()
        assert action["action"] == "escalate_to_user"
        assert action.get("previous_state") == "INTAKE"

    def test_escalation_unknown_reason_describes_missing_fields(self):
        """The escalate_to_user action's unknown_reason tells Penny (and
        the user) which fields are missing."""
        orch = JSAPipelineOrchestrator(
            session_id="e-013",
            goal="Analyze JS on https://example.com",
            constraints={"output_dir": "/tmp/jsa-e-013"},
        )
        action = orch.start()
        reason = action.get("unknown_reason", "")
        assert "INTAKE" in reason
        # Reason should mention at least one of the missing fields
        assert "authenticated_testing" in reason or "session_management" in reason


class TestStepProtocol:
    def test_step_from_intake_to_stop_to_sast_validate(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            """INTAKE → auto local phases → SAST_VALIDATE → STRUCTURE → SLICE → INVESTIGATE → STOP."""
            orch = JSAPipelineOrchestrator(
                session_id="test-004",
                goal="https://127.0.0.1:1",
                constraints={"output_dir": "/tmp/jsa-test-004"},
            )
            orch.start()  # Returns INTAKE instructions

            # Feed questionnaire data → advances through all locals to SAST_VALIDATE
            action = orch.step("user", {
                "target_url": "https://127.0.0.1:1",
                "authenticated_testing": "both",
                "session_management": "cookie",
            })
            # First stop is SAST_VALIDATE (agent phase) or STOP if no findings
            assert action["action"] in ("invoke_agent", "escalate_to_user", "complete")
            # Confirm agent/STOP until we hit STOP, then confirm to COLLECT
            seen = {action.get("state_id", "")}
            for _ in range(5):
                if action["action"] == "complete":
                    break
                if action.get("state_id") == "STOP":
                    action = orch.step("user", {"stop_decision": "continue"})
                    assert action["state_id"] in ("COLLECT", "MERGE", "COMPLETED")
                    break
                action = orch.step("user" if action["action"] == "escalate_to_user" else "annie",
                                   {"stop_decision": "continue"} if action["action"] == "escalate_to_user" else {"exitCode": 0, "summary": {}})

    def test_step_eventually_reaches_complete(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="test-005",
                goal="https://127.0.0.1:1",
                constraints={"analyzers": ["dom_xss"], "output_dir": "/tmp/jsa-test-005"},
            )
            orch.start()
            # Feed questionnaire data → advances past locals
            action = orch.step("user", {"target_url": "https://127.0.0.1:1", "session_management": "cookie"})
            # Walk through any intermediate STOP/escalate/agent actions until complete
            phases_seen = ["INTAKE"]
            if action.get("state_id"):
                phases_seen.append(action.get("state_id"))
            for _ in range(30):
                if action.get("state_id") == "STOP":
                    action = orch.step("user", {"stop_decision": "continue"})
                else:
                    action = orch.step("annie", {"exitCode": 0, "summary": {}})
                phases_seen.append(action.get("state_id", action.get("phase", "?")))
                if action["action"] == "complete":
                    break
            assert action["action"] == "complete"
            assert "COMPLETED" in phases_seen

    def test_step_with_restore(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="test-006",
                goal="https://127.0.0.1:1",
                constraints={"output_dir": "/tmp/jsa-test-006"},
            )
            orch.start()
            # Feed questionnaire data → ACQUIRE(local)→STOP(confirm)
            orch.step("user", {"target_url": "https://127.0.0.1:1", "session_management": "cookie"})
            # Confirm STOP if reached; otherwise pipeline may have completed
            action = orch.step("user", {"stop_decision": "continue"})
            # Should eventually reach an agent phase or complete
            assert action["action"] in ("invoke_agent", "escalate_to_user", "complete")



class TestStateSerialization:
    def test_extract_state_structure(self):
        orch = JSAPipelineOrchestrator(
            session_id="test-007",
            goal="https://example.com",
        )
        orch.start()
        state = orch.extract_state()
        assert state["session_id"] == "test-007"
        assert "current_phase" in state
        assert "context" in state
        assert state["context"]["goal"] == "https://example.com"

    def test_restore_state_roundtrip(self):
        orch = JSAPipelineOrchestrator(
            session_id="test-008",
            goal="https://example.com",
            constraints={"analyzers": ["dom_xss"]},
        )
        orch.start()
        state = orch.extract_state()

        orch2 = JSAPipelineOrchestrator(
            session_id="test-008",
            goal="https://example.com",
        )
        orch2.restore_state(state)
        assert orch2.fsm.phase.name == orch.fsm.phase.name
        assert orch2.state.analyzers == ["dom_xss"]


class TestUrlExtraction:
    """Regression tests for goal-text URL extraction. URLs embedded in
    natural-language goals often have trailing punctuation that breaks
    downstream acquisition (the trailing dot is treated as part of the
    FQDN, producing malformed requests)."""

    def _extracted_url(self, goal: str) -> str:
        o = JSAPipelineOrchestrator(
            session_id=f"url-{abs(hash(goal))}",
            goal=goal,
            constraints={"output_dir": "/tmp/jsa-url-test"},
        )
        return o.target_url

    def test_url_at_end_of_sentence_with_period(self):
        url = self._extracted_url("Analyze https://ginandjuice.shop.")
        assert url == "https://ginandjuice.shop"

    def test_url_at_end_of_sentence_with_exclamation(self):
        url = self._extracted_url("Check out https://example.com!")
        assert url == "https://example.com"

    def test_url_at_end_of_sentence_with_semicolon(self):
        url = self._extracted_url("Try https://example.com;")
        assert url == "https://example.com"

    def test_url_in_middle_of_sentence(self):
        url = self._extracted_url(
            "Compare https://a.com vs https://b.com for issues"
        )
        assert url == "https://a.com"

    def test_url_with_path_is_preserved(self):
        url = self._extracted_url("Test https://example.com/api/v1.")
        # Period after the path is stripped, path itself is preserved
        assert url == "https://example.com/api/v1"

    def test_url_with_query_is_preserved(self):
        url = self._extracted_url("Test https://example.com/?foo=bar.")
        # The trailing period is the sentence terminator, NOT part of the
        # query string — we strip it. The query string itself is intact.
        assert url == "https://example.com/?foo=bar"

    def test_url_with_https_only(self):
        url = self._extracted_url("Look at https://example.com")
        assert url == "https://example.com"

    def test_url_with_http(self):
        url = self._extracted_url("Look at http://example.com")
        assert url == "http://example.com"

    def test_no_url_in_goal(self):
        url = self._extracted_url("No URL here, just text")
        assert url == ""


class TestCLI:
    def test_cli_start(self, capsys):
        with patch("sys.argv", [
            "orchestrate.py", "start",
            "--session-id", "cli-test",
            "--goal", "https://127.0.0.1:1",
            "--constraints", '{"output_dir": "/tmp/jsa-cli-start"}',
        ]):
            main()
        captured = capsys.readouterr()
        action = json.loads(captured.out)
        # start() without intake returns escalate_to_user with questions
        assert action["action"] == "escalate_to_user"
        assert action["session_id"] == "cli-test"
        assert "questions" in action
    def test_cli_step(self, capsys):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch = JSAPipelineOrchestrator(
                session_id="cli-step-test",
                goal="https://127.0.0.1:1",
                constraints={"output_dir": "/tmp/jsa-cli-step"},
            )
            orch.start()
            # Feed questionnaire data → ACQUIRE(local)→STOP
            orch.step("user", {"target_url": "https://127.0.0.1:1", "session_management": "cookie"})
            state = json.dumps(orch.extract_state())

        with patch("sys.argv", [
            "orchestrate.py", "step",
            "--session-id", "cli-step-test",
            "--agent", "user",
            "--result", '{"stop_decision": "continue"}',
            "--state", state,
        ]), patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            main()
        captured = capsys.readouterr()
        action = json.loads(captured.out)
        assert action["session_id"] == "cli-step-test"
        # After STOP confirm, auto-advances through locals; may hit another escalate or agent
        assert action["action"] in ("invoke_agent", "escalate_to_user", "complete")

    def test_cli_status(self, capsys):
        orch = JSAPipelineOrchestrator(
            session_id="cli-status-test",
            goal="https://127.0.0.1:1",
            constraints={"output_dir": "/tmp/jsa-cli-status"},
        )
        orch.start()
        state = json.dumps(orch.extract_state())

        with patch("sys.argv", [
            "orchestrate.py", "status",
            "--session-id", "cli-status-test",
            "--state", state,
        ]):
            main()
        captured = capsys.readouterr()
        action = json.loads(captured.out)
        assert action["action"] == "status"
        # Phase after start() without intake is INTAKE
        assert action["phase"] == "INTAKE"

    def test_cli_invalid_state(self, capsys):
        with patch("sys.argv", [
            "orchestrate.py", "step",
            "--session-id", "bad-state",
            "--agent", "echo",
            "--result", "{}",
            "--state", "not-json",
        ]):
            main()
        captured = capsys.readouterr()
        action = json.loads(captured.out)
        assert action["action"] == "error"


class TestPhaseSkipping:
    def test_intake_then_stop_then_continue_advances_past_locals(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            """INTAKE(questionnaire) → STOP → continue → auto-runs locals to SAST_VALIDATE."""
            orch = JSAPipelineOrchestrator(
                session_id="test-skip-1",
                goal="just some text with no url",
            )
            orch.start()
            # Feed questionnaire data → STOP
            orch.step("user", {"session_management": "cookie"})
            # Confirm STOP → auto-advances through locals (ACQUIRE skipped, no URL)
            action = orch.step("user", {"stop_decision": "continue"})
            assert action["state_id"] != "ACQUIRE"

    def test_intake_then_stop_then_continue_reaches_sast_validate(self):
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            """With URL: INTAKE → ACQUIRE → ... → SAST_VALIDATE → STOP → continue → INVESTIGATE."""
            orch = JSAPipelineOrchestrator(
                session_id="test-skip-2",
                goal="https://127.0.0.1:1",
                constraints={"output_dir": "/tmp/jsa-skip-2"},
            )
            orch.start()
            orch.step("user", {"target_url": "https://127.0.0.1:1", "session_management": "cookie"})
            action = orch.step("user", {"stop_decision": "continue"})
            state_id = action.get("state_id", action.get("phase", "?"))
            # After questionnaire, first action should be SAST_VALIDATE (agent) or STOP
            assert state_id in ("SAST_VALIDATE", "STOP", "INVESTIGATE")



class TestDedupDirective:
    def test_dedup_directive_exists(self):
        orch = JSAPipelineOrchestrator(
            session_id="dedup-directive-test",
            goal="https://example.com",
        )
        directive = orch._dedup_directive()
        assert directive is not None
        assert directive.type == "local"
        assert directive.phase == "DEDUP"
        assert directive.session_id == orch.session_id
        assert "deduplicate" in directive.description.lower() or "merge" in directive.description.lower()

    def test_dedup_executes_locally(self, tmp_path: Path):
        orch = JSAPipelineOrchestrator(
            session_id="dedup-exec-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        orch.state.sast_findings = [
            {
                "rule_id": "dom_xss",
                "path": "app.js",
                "line": 10,
                "source": "semgrep",
                "message": "innerHTML with user input",
                "code": "el.innerHTML = user;",
            }
        ]
        directive = orch._dedup_directive()
        orch._execute_local_phase(directive)
        # After dedup, sast_findings should still contain the finding
        assert len(orch.state.sast_findings) == 1
        assert orch.state.sast_findings[0].get("source") == "semgrep"
        assert orch.state.metadata.get("dedup") is not None


class TestPipelineIntegration:
    """Integration tests covering full pipeline, state roundtrip, STRUCTURE/SLICE/INVESTIGATE, SAST."""

    def test_state_roundtrip_preserves_output_dir(self) -> None:
        output_dir = "/tmp/jsa-test-fixtures"
        orch = JSAPipelineOrchestrator(
            session_id="roundtrip-test",
            goal="https://example.com",
            constraints={"output_dir": output_dir},
        )
        orch.start()
        state = orch.extract_state()
        # After start(), phase is INTAKE (questionnaire pending)
        assert state["current_phase"] == "INTAKE"

        # Create a fresh orchestrator with different defaults and restore
        orch2 = JSAPipelineOrchestrator(
            session_id="roundtrip-test",
            goal="",
        )
        orch2.restore_state(state)
        assert orch2.state.output_dir == output_dir
        assert orch2.state.target_url == "https://example.com"
        assert orch2.state.js_dir.exists()
        # ACQUIRE not yet run — js_dir may be empty, but structure is intact

    def test_chunk_phase_with_mock_files(self, tmp_path: Path) -> None:
        orch = JSAPipelineOrchestrator(
            session_id="chunk-test",
            goal="https://example.com",
        )
        # Set up mock JS files in the state's js_dir
        js_dir = orch.state.js_dir
        js_dir.mkdir(parents=True, exist_ok=True)
        (js_dir / "vulnerable.js").write_text("function vuln() { return 'xss'; }\n" * 100)
        (js_dir / "safe.js").write_text("function safe() { return 'ok'; }\n" * 100)
        (js_dir / "angular_mock.js").write_text("angular.module('app', [])\n" * 100)
        (js_dir / "react_mock.js").write_text("import React from 'react';\n" * 100)

        directive = orch._structure_directive()
        orch._execute_local_phase(directive)
        # Phase B: STRUCTURE is a stub. Just verify the directive was created.
        assert directive is not None
        assert directive.phase == "STRUCTURE"

    def test_investigate_with_no_cards(self) -> None:
        """INVESTIGATE should produce a valid local directive even with no flow cards."""
        orch = JSAPipelineOrchestrator(
            session_id="investigate-test",
            goal="https://example.com",
            constraints={"analyzers": ["dom_xss"], "output_dir": "/tmp/jsa-investigate-unit-test"},
        )

        # Populate with a real flow card needing LLM verification
        # (sanitizer + multi-step → medium confidence → needs_llm_verify=True)
        from flow_card import FlowCard, FlowEndpoint, SanitizerInfo, FlowStep
        fc = FlowCard(
            flow_id="fc-0",
            vulnerability_class="dom_xss",
            lane="code_static",
            source=FlowEndpoint(type="location.hash", detail="", line=1),
            sink=FlowEndpoint(type="element.innerHTML", detail="", line=10),
            steps=[
                FlowStep(expression="raw = location.hash", line=1),
                FlowStep(expression="clean = raw.substring(0, 100)", line=5),
                FlowStep(expression="el.innerHTML = clean", line=10),
            ],
            sanitizer_chain=[SanitizerInfo(name="substring", covers_sink=False)],
            module_card_ids=["app.js"],
        )
        orch.state.flow_cards = [fc]
        directive = orch._investigate_directive()
        assert directive is not None, "investigate should produce directive for medium-confidence findings"
        assert directive.phase == "INVESTIGATE"
        assert directive.type == "agent"
        shutil.rmtree("/tmp/jsa-investigate-unit-test", ignore_errors=True)

    def test_full_pipeline_flow(self, tmp_path: Path) -> None:
        orch = JSAPipelineOrchestrator(
            session_id="pipeline-test",
            goal="https://example.com",
            constraints={
                "output_dir": str(tmp_path),
                "analyzers": ["dom_xss"],
            },
        )
        # INTAKE returns questionnaire instructions (type=complete with questionnaire path)
        action = orch.start()
        assert action["action"] in ("escalate_to_user", "complete")
        required_keys = {"action", "session_id", "orchestrator_state"}
        assert required_keys.issubset(action.keys())
        # complete actions use 'phase', escalate actions use 'state_id'
        assert "state_id" in action or "phase" in action

        # Feed questionnaire data → advances past locals to SAST_VALIDATE or STOP
        action = orch.step("user", {
            "target_url": "https://example.com",
            "session_management": "cookie",
        })
        assert action["state_id"] in ("SAST_VALIDATE", "STRUCTURE", "SLICE", "INVESTIGATE", "STOP")

        # Walk past SAST_VALIDATE/STRUCTURE/SLICE/INVESTIGATE to reach STOP
        for _ in range(8):
            if action.get("state_id") == "STOP":
                action = orch.step("user", {"stop_decision": "continue"})
                continue
            if action["action"] == "complete":
                break
            action = orch.step("user" if action["action"] == "escalate_to_user" else "annie",
                               {"stop_decision": "continue"} if action["action"] == "escalate_to_user" else {"exitCode": 0, "summary": {}})
        assert action.get("state_id", "COMPLETED") in ("STOP", "COLLECT", "MERGE", "COMPLETED")

        # Step through the pipeline
        seen_phases = {"INTAKE", "STOP", action.get("state_id", "")}
        for _ in range(30):
            if action.get("state_id") == "STOP":
                action = orch.step("user", {"stop_decision": "continue"})
            else:
                action = orch.step("annie", {"exitCode": 0, "summary": {}})
            seen_phases.add(action.get("state_id", action.get("phase")))
            assert "action" in action
            assert "session_id" in action
            assert "orchestrator_state" in action
            if action["action"] == "complete":
                break

        assert action["action"] == "complete"
        assert "COMPLETED" in seen_phases

        # Verify phase_history covers all expected phases
        phase_history = orch.state.metadata.get("phase_history", [])
        unique_phases = set(phase_history)
        expected_phases = {"INTAKE", "ACQUIRE", "CVE_RESEARCH", "STOP", "SAST_SCAN",
                          "NORMALIZE", "DEDUP_WITHIN_SOURCE", "CORRELATE_EVIDENCE",
                          "SAST_VALIDATE", "STRUCTURE", "SLICE", "INVESTIGATE",
                          "COLLECT", "MERGE", "VERIFY", "REPORT",
                          "REFLECT", "COMPLETED"}
        assert expected_phases.issubset(unique_phases), (
            f"Missing phases: {expected_phases - unique_phases}")

    def test_sast_phase_expands_jsa_preset(self, tmp_path: Path) -> None:
        """Verify semgrep receives the full jsa preset expansion instead of --config jsa."""
        orch = JSAPipelineOrchestrator(
            session_id="sast-preset-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        js_dir = orch.state.js_dir
        js_dir.mkdir(parents=True, exist_ok=True)
        (js_dir / "app.js").write_text("const x = 1;\n")

        captured_cmds = []

        def _mock_subprocess(*args, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = json.dumps({"results": []})
            mock_result.stderr = ""
            captured_cmds.append(list(args[0]))
            return mock_result

        directive = orch._sast_scan_directive()
        with patch("subprocess.run", side_effect=_mock_subprocess):
            orch._execute_tool_phase(directive)

        # Find the semgrep call (there may also be jsluice calls)
        semgrep_calls = [c for c in captured_cmds if Path(c[0]).name == "semgrep"]
        assert len(semgrep_calls) == 1, f"Expected 1 semgrep call, got {len(semgrep_calls)}"
        cmd = semgrep_calls[0]

        # The local rules are passed as a single --config pointing at the
        # bundled rules directory (semgrep recurses into all *.yaml files).
        # The registry rules are passed as individual --config flags.
        registry_configs = [
            "p/javascript", "p/typescript", "p/nodejs", "p/expressjs", "p/eslint",
            "p/xss", "p/owasp-top-ten", "p/cwe-top-25",
            "p/secrets", "p/security-audit", "p/sql-injection",
            "p/command-injection", "p/jwt", "p/insecure-transport",
        ]
        # The local rules base directory must appear as a --config value
        from orchestrate import _rules_base_discovery
        expected_local_base = str(_rules_base_discovery())

        for r in registry_configs:
            assert r in cmd, f"Missing registry config in semgrep command: {r}"

        # Local rules: verify the rules base dir is passed
        assert expected_local_base in cmd, (
            f"Missing local rules base dir in semgrep command: {expected_local_base}"
        )

        # Ensure bare 'jsa' was not passed as a --config value
        assert "jsa" not in cmd, "Bare 'jsa' should not appear in semgrep command args"

        # Ensure argv stays small (< 4KB) to avoid E2BIG spawn errors
        total_arg_chars = sum(len(c) + 1 for c in cmd)
        assert total_arg_chars < 4096, (
            f"Semgrep argv too large ({total_arg_chars} chars) — may hit E2BIG"
        )

    def test_sast_phase_handles_missing_semgrep(self) -> None:
        orch = JSAPipelineOrchestrator(
            session_id="sast-test",
            goal="https://example.com",
            constraints={"output_dir": "/tmp/jsa-test-fixtures"},
        )
        # Ensure JS files exist so the semgrep path is reached
        js_dir = orch.state.js_dir
        js_dir.mkdir(parents=True, exist_ok=True)
        (js_dir / "dummy.js").write_text("const x = 1;\n")

        directive = orch._sast_scan_directive()
        # Force discovery to return a missing path so subprocess.run raises FileNotFoundError
        with patch("orchestrate._semgrep_path_discovery", return_value="/nonexistent/semgrep"):
            with patch("subprocess.run", side_effect=FileNotFoundError("semgrep not found")):
                orch._execute_tool_phase(directive)

        # Error message should mention the missing path AND the remediation hint
        assert any("semgrep binary not found" in e for e in orch.state.errors)
        assert any("Install semgrep" in e for e in orch.state.errors)

    def test_semgrep_binary_discovery_finds_via_script_path(self) -> None:
        """_semgrep_path_discovery() must walk up from orchestrate.py to find
        the project venv binary, regardless of where output_dir is set."""
        from orchestrate import _semgrep_path_discovery
        result = _semgrep_path_discovery()
        assert Path(result).name == "semgrep"
        # Must not be the bare 'semgrep' fallback string if the venv exists
        venv_bin = Path("/home/skribblez/projects/penny/.venv/bin/semgrep")
        if venv_bin.exists():
            assert Path(result).resolve() == venv_bin.resolve()

    def test_semgrep_discovery_env_override(self) -> None:
        """$SEMGREP_BIN env var wins over filesystem discovery."""
        from orchestrate import _semgrep_path_discovery
        import os
        os.environ["SEMGREP_BIN"] = "/custom/path/to/semgrep"
        try:
            # Point at a file that does exist for the existence check
            fake = "/tmp/fake_semgrep_for_test"
            Path(fake).write_text("#!/bin/sh\n")
            os.environ["SEMGREP_BIN"] = fake
            assert _semgrep_path_discovery() == fake
        finally:
            os.environ.pop("SEMGREP_BIN", None)
            if Path(fake).exists():
                Path(fake).unlink()

    def test_rules_base_discovery_finds_extensions_dir(self) -> None:
        """_rules_base_discovery() must locate the semgrep rules directory."""
        from orchestrate import _rules_base_discovery
        result = _rules_base_discovery()
        assert result.is_dir()
        # Must contain at least one of the well-known rule subdirs
        assert (result / "javascript-react").exists() or (result / "javascript-lang").exists()

    def test_image_url_filter(self) -> None:
        """_is_image_asset_url should filter static image URLs from jsluice results."""
        from orchestrate import _is_image_asset_url
        # True positives
        assert _is_image_asset_url("/resources/images/x.png") is True
        assert _is_image_asset_url("/foo.jpg") is True
        assert _is_image_asset_url("https://cdn.example.com/a.svg") is True
        assert _is_image_asset_url("/api/x.gif?cache=1") is True  # query stripped
        assert _is_image_asset_url("/a.png#frag") is True
        assert _is_image_asset_url("/x.ICO") is True  # case-insensitive
        # True negatives
        assert _is_image_asset_url("/catalog") is False
        assert _is_image_asset_url("/api/login") is False
        assert _is_image_asset_url("/api/track?img=foo.png") is False  # query string, not extension
        assert _is_image_asset_url("") is False
        assert _is_image_asset_url("/foo.html") is False

    def test_sast_scan_filters_image_urls(self, tmp_path: Path) -> None:
        """End-to-end: jsluice urls phase must exclude image asset URLs and
        record the filtered count in metadata."""
        orch = JSAPipelineOrchestrator(
            session_id="img-filter-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        js_dir = orch.state.js_dir
        js_dir.mkdir(parents=True, exist_ok=True)
        (js_dir / "test.js").write_text("const x = 1;\n")

        # Mock jsluice to return a mix of image and non-image URLs
        jsluice_output = "\n".join([
            json.dumps({"url": "/catalog", "type": "stringLiteral", "filename": str(js_dir / "test.js")}),
            json.dumps({"url": "/resources/images/banner.png", "type": "stringLiteral", "filename": str(js_dir / "test.js")}),
            json.dumps({"url": "/api/users", "type": "stringLiteral", "filename": str(js_dir / "test.js")}),
            json.dumps({"url": "/static/logo.svg", "type": "stringLiteral", "filename": str(js_dir / "test.js")}),
            json.dumps({"url": "/logger", "type": "stringLiteral", "filename": str(js_dir / "test.js")}),
        ])

        def _mock_run(*args, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = jsluice_output
            mock_result.stderr = ""
            return mock_result

        directive = orch._sast_scan_directive()
        with patch("subprocess.run", side_effect=_mock_run):
            orch._execute_tool_phase(directive)

        # Verify counts
        urls_count = orch.state.metadata["sast"]["jsluice_urls_count"]
        filtered_count = orch.state.metadata["sast"].get("jsluice_urls_filtered", 0)
        assert urls_count == 3, f"Expected 3 non-image URLs, got {urls_count}"
        assert filtered_count == 2, f"Expected 2 image URLs filtered, got {filtered_count}"

        # Verify the persisted jsonl only has non-image URLs
        urls_jsonl = (Path(orch.output_dir) / "sast" / "jsluice_urls.jsonl").read_text()
        assert "/resources/images/banner.png" not in urls_jsonl
        assert "/static/logo.svg" not in urls_jsonl
        assert "/catalog" in urls_jsonl
        assert "/api/users" in urls_jsonl
        assert "/logger" in urls_jsonl

    def test_sast_scan_writes_placeholder_for_empty_jsonl(self, tmp_path: Path) -> None:
        """Empty jsluice_secrets.jsonl and jsluice_urls.jsonl must contain a
        placeholder line (not be 0 bytes) for downstream consumers."""
        orch = JSAPipelineOrchestrator(
            session_id="empty-jsonl-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        js_dir = orch.state.js_dir
        js_dir.mkdir(parents=True, exist_ok=True)
        (js_dir / "test.js").write_text("// empty\n")

        def _mock_run(*args, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = ""  # no findings
            mock_result.stderr = ""
            return mock_result

        directive = orch._sast_scan_directive()
        with patch("subprocess.run", side_effect=_mock_run):
            orch._execute_tool_phase(directive)

        secrets_path = Path(orch.output_dir) / "sast" / "jsluice_secrets.jsonl"
        urls_path = Path(orch.output_dir) / "sast" / "jsluice_urls.jsonl"
        assert secrets_path.exists()
        assert urls_path.exists()
        assert secrets_path.stat().st_size > 0, "secrets jsonl must not be 0 bytes"
        assert urls_path.stat().st_size > 0, "urls jsonl must not be 0 bytes"
        # Should contain the placeholder
        assert secrets_path.read_text().strip() == "[]"
        assert urls_path.read_text().strip() == "[]"


class TestRegexPatterns:
    """Unit tests for script extraction regexes."""

    def test_script_src_regex_double_quote(self):
        html = '<script src="/test.js" type="module"></script>'
        match = SCRIPT_SRC_RE.search(html)
        assert match is not None
        assert match.group(1) == "/test.js"

    def test_script_src_regex_single_quote(self):
        html = "<script src='/app/main.js'></script>"
        match = SCRIPT_SRC_RE.search(html)
        assert match is not None
        assert match.group(1) == "/app/main.js"

    def test_script_src_regex_no_src(self):
        html = '<script>alert(1)</script>'
        match = SCRIPT_SRC_RE.search(html)
        assert match is None

    def test_script_src_regex_multiple(self):
        html = '<script src="a.js"></script><script src="b.js"></script>'
        matches = SCRIPT_SRC_RE.findall(html)
        assert matches == ["a.js", "b.js"]

    def test_script_src_regex_relative_path(self):
        html = '<script src="../lib/vendor.js?v=123"></script>'
        match = SCRIPT_SRC_RE.search(html)
        assert match is not None
        assert match.group(1) == "../lib/vendor.js?v=123"

    def test_inline_script_regex_basic(self):
        html = '<script>console.log("hello")</script>'
        match = INLINE_SCRIPT_RE.search(html)
        assert match is not None
        assert match.group(1).strip() == 'console.log("hello")'

    def test_inline_script_regex_multiline(self):
        html = '<script type="text/javascript">\n  var x = 1;\n</script>'
        match = INLINE_SCRIPT_RE.search(html)
        assert match is not None
        assert "var x = 1;" in match.group(1)

    def test_inline_script_regex_no_src(self):
        """Ensure inline regex does NOT match script tags WITH src."""
        html = '<script src="external.js">console.log(1)</script>'
        match = INLINE_SCRIPT_RE.search(html)
        assert match is None

    def test_inline_script_regex_with_type(self):
        html = '<script type="module">\n  export default {};\n</script>'
        match = INLINE_SCRIPT_RE.search(html)
        assert match is not None
        assert "export default {};" in match.group(1)


class TestIsJsFileUrl:
    """Unit tests for _is_js_file_url helper."""

    def test_import_type_always_true(self):
        entry = {"url": "/chunk.js", "type": "import"}
        assert _is_js_file_url(entry) is True

    def test_explicit_js_extension(self):
        entry = {"url": "https://cdn.example.com/app.js?v=1", "type": "fetch"}
        assert _is_js_file_url(entry) is True

    def test_js_extension_without_query(self):
        entry = {"url": "/static/bundle.min.js", "type": "fetch"}
        assert _is_js_file_url(entry) is True

    def test_non_js_extension(self):
        entry = {"url": "/api/v1/users", "type": "fetch"}
        assert _is_js_file_url(entry) is False

    def test_empty_url(self):
        entry = {"url": "", "type": "fetch"}
        assert _is_js_file_url(entry) is False

    def test_missing_url_key(self):
        entry = {"type": "import"}
        assert _is_js_file_url(entry) is True

    def test_import_with_non_js_url(self):
        # Dynamic imports always load JS even if path has no .js extension
        entry = {"url": "https://cdn.example.com/loader?v=2", "type": "import"}
        assert _is_js_file_url(entry) is True


class TestIsOutOfScope:
    """Unit tests for _is_out_of_scope helper."""

    def test_pattern_in_url(self):
        assert _is_out_of_scope("https://example.com/api/internal", ["internal"]) is True

    def test_no_patterns(self):
        assert _is_out_of_scope("https://example.com/app.js", []) is False

    def test_multiple_patterns_match(self):
        assert _is_out_of_scope("https://example.com/admin/keys", ["/internal", "/admin/"]) is True

    def test_no_match(self):
        assert _is_out_of_scope("https://example.com/public.js", ["/private/"]) is False


class TestScopeEnforcement:
    """Regression tests for out_of_scope constraint handling.

    These tests pin the behavior established after the 2026-06-09 audit
    where out_of_scope was found to be (a) not propagated to worker
    prompts in DISPATCH, (b) not propagated to VERIFY, and (c) not
    visible in the response extract_state for operator verification.
    """

    def test_extract_state_surfaces_effective_out_of_scope(self):
        """extract_state must include effective_out_of_scope as a clean list."""
        orch = JSAPipelineOrchestrator(
            session_id="test-scope-1",
            goal="test",
            constraints={"out_of_scope": ["https://x.com/admin", "https://x.com/vulns"]},
        )
        state = orch.extract_state()
        eos = state["context"].get("effective_out_of_scope")
        assert eos == ["https://x.com/admin", "https://x.com/vulns"], (
            f"effective_out_of_scope missing or wrong: {eos}"
        )

    def test_extract_state_effective_oos_empty_when_unset(self):
        orch = JSAPipelineOrchestrator(
            session_id="test-scope-2",
            goal="test",
            constraints={},
        )
        state = orch.extract_state()
        assert state["context"].get("effective_out_of_scope") == []

    def test_verify_directive_includes_scope_in_task(self):
        """VERIFY task text must include the out_of_scope URLs as a hard block."""
        orch = JSAPipelineOrchestrator(
            session_id="test-scope-3",
            goal="test",
            constraints={"out_of_scope": ["https://x.com/admin"]},
        )
        d = orch._verify_directive()
        assert d is not None
        assert "https://x.com/admin" in d.task, "OOS URL missing from VERIFY task"
        assert "OUT OF SCOPE" in d.task, "OOS label missing from VERIFY task"
        # Context must also carry OOS so subagent has programmatic access
        assert d.context.get("out_of_scope") == ["https://x.com/admin"]

    def test_verify_directive_handles_no_scope(self):
        """When no OOS configured, VERIFY directive still renders advisory scope."""
        orch = JSAPipelineOrchestrator(
            session_id="test-scope-4",
            goal="test",
            constraints={},
        )
        d = orch._verify_directive()
        assert d is not None
        # Advisory wording when scope is empty
        assert "none configured" in d.task.lower() or "(none" in d.task.lower()
        assert d.context.get("out_of_scope") == []


class TestCoerceScopeList:
    """Tests for _coerce_scope_list — defensive normalizer for scope values.

    The skill tool bridge has been observed wrapping list-shaped values in
    single-key dicts ({"item": "..."}) when the schema doesn't declare the
    list shape. This helper unwraps that pattern so scope enforcement
    always sees a clean list of URL-substring strings.
    """

    def test_clean_list_passes_through(self):
        from orchestrate import _coerce_scope_list
        assert _coerce_scope_list(["https://a.com/x", "https://b.com/y"]) == [
            "https://a.com/x", "https://b.com/y"
        ]

    def test_single_string_wrapped(self):
        from orchestrate import _coerce_scope_list
        assert _coerce_scope_list("https://a.com/x") == ["https://a.com/x"]

    def test_newline_separated_string(self):
        from orchestrate import _coerce_scope_list
        result = _coerce_scope_list("https://a.com/x\nhttps://b.com/y")
        assert result == ["https://a.com/x", "https://b.com/y"]

    def test_single_key_dict_wrapper(self):
        """The bridge bug pattern: {"item": "https://..."} should unwrap."""
        from orchestrate import _coerce_scope_list
        result = _coerce_scope_list({"item": "https://a.com/x"})
        assert result == ["https://a.com/x"], f"Got: {result}"

    def test_list_of_dict_wrappers(self):
        from orchestrate import _coerce_scope_list
        result = _coerce_scope_list([
            {"item": "https://a.com/x"},
            {"item": "https://b.com/y"},
        ])
        assert result == ["https://a.com/x", "https://b.com/y"], f"Got: {result}"

    def test_named_key_dict(self):
        from orchestrate import _coerce_scope_list
        result = _coerce_scope_list({"url": "https://a.com/x"})
        assert result == ["https://a.com/x"]

    def test_empty_inputs(self):
        from orchestrate import _coerce_scope_list
        assert _coerce_scope_list(None) == []
        assert _coerce_scope_list([]) == []
        assert _coerce_scope_list("") == []
        assert _coerce_scope_list({}) == []

    def test_start_normalizes_dict_wrapped_scope(self):
        """Regression: production input {item: url} must be normalized by start()."""
        # Simulate the exact bridge artifact: a dict-wrapped list
        orch = JSAPipelineOrchestrator(
            session_id="test-coerce-1",
            goal="test",
            constraints={"out_of_scope": {"item": "https://x.com/admin"}},
        )
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch.start()
        # The runtime constraints should be a clean list now
        eos = orch.constraints.get("out_of_scope", [])
        assert eos == ["https://x.com/admin"], f"Got: {eos}"

    def test_start_normalizes_nested_intake_dict_wrapped_scope(self):
        """Regression: when the dict is inside constraints.intake, normalize that too."""
        orch = JSAPipelineOrchestrator(
            session_id="test-coerce-2",
            goal="test",
            constraints={"intake": {"out_of_scope": {"item": "https://x.com/admin"}}},
        )
        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            orch.start()
        eos = orch.constraints.get("intake", {}).get("out_of_scope", [])
        assert eos == ["https://x.com/admin"], f"Got: {eos}"


class TestAcquireLocally:
    """Tests for refactored _acquire_locally with recursive discovery."""
    def test_acquire_downloads_files(self, tmp_path: Path):
        orch = JSAPipelineOrchestrator(
            session_id="acquire-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        html = (
            '<script src="/test.js"></script>'
            '<script>var x = 42;</script>'
        )

        def _mock_subprocess(cmd, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = ""
            mock_result.stderr = ""
            if cmd[0] == "curl":
                # cmd[-o index + 1] is -o value, cmd[-1] is URL
                out_path = Path(cmd[cmd.index("-o") + 1])
                if "homepage.html" in str(out_path):
                    out_path.write_text(html, encoding="utf-8")
                else:
                    out_path.write_text("function test() {}", encoding="utf-8")
            mock_result.check = Mock(side_effect=lambda: None)
            return mock_result

        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            with patch("subprocess.run", side_effect=_mock_subprocess):
                orch._acquire_locally(orch._acquire_directive())

        js_files = list(orch.state.js_dir.glob("*.js"))
        assert any(f.name == "test.js" for f in js_files)
        assert orch.state.metadata["acquire"]["inline_scripts"] == 1
        assert orch.state.metadata["acquire"]["js_files"] >= 1
    def test_acquire_seen_url_tracking(self, tmp_path: Path):
        orch = JSAPipelineOrchestrator(
            session_id="seen-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        html = '<script src="/same.js"></script><script src="/same.js"></script>'
        download_calls = []

        def _mock_subprocess(cmd, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = ""
            mock_result.stderr = ""
            if cmd[0] == "curl":
                url = cmd[-1]
                out_path = str(Path(cmd[cmd.index("-o") + 1]))
                if "homepage.html" in out_path:
                    Path(cmd[cmd.index("-o") + 1]).write_text(html, encoding="utf-8")
                else:
                    download_calls.append(url)
                    Path(cmd[cmd.index("-o") + 1]).write_text("function same() {}", encoding="utf-8")
            mock_result.check = Mock(side_effect=lambda: None)
            return mock_result

        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            with patch("subprocess.run", side_effect=_mock_subprocess):
                orch._acquire_locally(orch._acquire_directive())

        # same.js should only be downloaded once despite two references
        assert download_calls.count("https://example.com/same.js") == 1
    def test_acquire_out_of_scope_filter(self, tmp_path: Path):
        orch = JSAPipelineOrchestrator(
            session_id="scope-test",
            goal="https://example.com",
            constraints={
                "output_dir": str(tmp_path),
                "out_of_scope": ["/vulnerabilities/"],
            },
        )
        html = '<script src="/vulnerabilities/leak.js"></script><script src="/app/main.js"></script>'
        downloaded = []

        def _mock_subprocess(cmd, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = ""
            mock_result.stderr = ""
            if cmd[0] == "curl":
                url = cmd[-1]
                if "homepage.html" in str(Path(cmd[cmd.index("-o") + 1])):
                    Path(cmd[cmd.index("-o") + 1]).write_text(html, encoding="utf-8")
                else:
                    downloaded.append(url)
                    Path(cmd[cmd.index("-o") + 1]).write_text("function f() {}", encoding="utf-8")
            mock_result.check = Mock(side_effect=lambda: None)
            return mock_result

        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            with patch("subprocess.run", side_effect=_mock_subprocess):
                orch._acquire_locally(orch._acquire_directive())

        assert "https://example.com/app/main.js" in downloaded
        assert "https://example.com/vulnerabilities/leak.js" not in downloaded
    def test_acquire_jsluice_recursion(self, tmp_path: Path):
        orch = JSAPipelineOrchestrator(
            session_id="recursion-test",
            goal="https://example.com",
            constraints={"output_dir": str(tmp_path)},
        )
        html = '<script src="/initial.js"></script>'
        jsluice_bin = str(Path.home() / "go" / "bin" / "jsluice")

        def _mock_subprocess(cmd, **kwargs):
            mock_result = Mock()
            mock_result.returncode = 0
            mock_result.stdout = ""
            mock_result.stderr = ""
            if cmd[0] == "curl":
                out_path = Path(cmd[cmd.index("-o") + 1])
                if "homepage.html" in str(out_path):
                    out_path.write_text(html, encoding="utf-8")
                elif "initial.js" in str(out_path):
                    out_path.write_text("import('./recursive.js');", encoding="utf-8")
                elif "recursive.js" in str(out_path):
                    out_path.write_text("function r() {}", encoding="utf-8")
            elif cmd[0] == jsluice_bin and cmd[1] == "urls":
                js_file = Path(cmd[-1])
                if "initial.js" in str(js_file):
                    mock_result.stdout = (
                        '{"url": "./recursive.js", "type": "import"}\n'
                    )
                elif "recursive.js" in str(js_file):
                    mock_result.stdout = ""
            mock_result.check = Mock(side_effect=lambda: None)
            return mock_result

        with patch.object(JSAPipelineOrchestrator, "_run_katana_crawl", return_value=[]):
            with patch("subprocess.run", side_effect=_mock_subprocess):
                # If jsluice exists (mocked), it should find recursive.js and download it
                with patch.object(Path, "exists", return_value=True):
                    orch._acquire_locally(orch._acquire_directive())

        js_files = {f.name for f in orch.state.js_dir.glob("*.js")}
        assert "initial.js" in js_files
        assert "recursive.js" in js_files
        assert orch.state.metadata["acquire"]["recursion_depth"] == 2


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
