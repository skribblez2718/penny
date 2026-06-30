"""
End-to-end tests for code skill.

Tests the complete lifecycle from CLI invocation to final output.
These are SLOW tests — they exercise the full orchestration loop.

Mark with @pytest.mark.e2e:
    pytest test_e2e.py -m e2e -v
"""

import pytest
import subprocess
import json
from pathlib import Path

ORCHESTRATE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "orchestrate.py"


@pytest.mark.e2e
def test_cli_start_with_state_data_emits_explore():
    """CLI start with valid state-data must emit explore action (echo invoke)."""
    state_data = json.dumps({
        "ideal_state": {
            "goal": "e2e test goal",
            "success_criteria": ["Test passes"],
            "language": "python",
        },
        "goal": "e2e test goal",
    })
    result = subprocess.run(
        ["python", str(ORCHESTRATE_PATH), "start",
         "--session-id", "e2e-test-001",
         "--goal", "e2e test goal",
         "--state-data", state_data,
         "--project-root", str(Path(__file__).resolve().parent.parent)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    action = json.loads(result.stdout)
    assert "action" in action
    assert action["action"] == "invoke_agent"
    assert action["agent"] == "echo"
    assert action["state_id"] == "explore"


@pytest.mark.e2e
def test_cli_start_without_state_data_emits_error():
    """CLI start without state-data must emit chain-contract error."""
    result = subprocess.run(
        ["python", str(ORCHESTRATE_PATH), "start",
         "--session-id", "e2e-test-002",
         "--goal", "e2e test without PRD",
         "--project-root", str(Path(__file__).resolve().parent.parent)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    action = json.loads(result.stdout)
    assert action["action"] == "error"
    assert "PRD dependency" in action["errors"][0]
