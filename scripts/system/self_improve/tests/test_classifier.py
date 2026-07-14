# target_classifier tests — TDD
"""Target layer classification for self-improvement amendments."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from target_classifier import classify_target, TargetLayer  # noqa: E402


class TestClassifyTargetDomainGuidance:
    """Learning related to skill-specific behaviors → Domain Guidance."""

    def test_coding_pattern_targets_domain_guidance(self):
        result = classify_target(
            "Penny tends to assume Python projects use uv without checking",
            ["outcome_xyz (MISMATCH: wrong package manager)"],
        )
        assert result == TargetLayer.DOMAIN_GUIDANCE

    def test_planning_pattern_targets_domain_guidance(self):
        result = classify_target(
            "Piper underestimates dependency chains in refactoring plans",
            ["outcome_abc (MISMATCH: missed 3 deps)"],
        )
        assert result == TargetLayer.DOMAIN_GUIDANCE

    def test_testing_pattern_targets_domain_guidance(self):
        result = classify_target(
            "Echo misses config files when exploring authentication modules",
            ["outcome_def (PARTIAL: config file not found)"],
        )
        assert result == TargetLayer.DOMAIN_GUIDANCE

    def test_crest_misclassification_targets_domain_guidance(self):
        result = classify_target(
            "Carren consistently rates CREST constraints as medium when they are high",
            ["outcome_ghi (MISMATCH: wrong severity assessment)"],
        )
        assert result == TargetLayer.DOMAIN_GUIDANCE

    def test_output_format_targets_domain_guidance(self):
        result = classify_target(
            "SUMMARY format omits the mempalace_drawer field in Piper prompts",
            ["outcome_jkl (MISMATCH: orchestrator failed to read SUMMARY)"],
        )
        assert result == TargetLayer.DOMAIN_GUIDANCE


class TestClassifyTargetMempalacePref:
    """User preference patterns → Mempalace."""

    def test_user_communication_style_targets_mempalace(self):
        result = classify_target(
            "User consistently asks for shorter, more concise responses",
            ["session_2026-04-10 (user: 'be brief')", "session_2026-04-11 (user: 'too verbose')"],
        )
        assert result == TargetLayer.MEMPALACE_PREF

    def test_user_workflow_preference_targets_mempalace(self):
        result = classify_target(
            "User prefers to see test output before committing to file edits",
            ["session_2026-04-12 (user rejected edit without seeing tests)"],
        )
        assert result == TargetLayer.MEMPALACE_PREF

    def test_user_confirmation_threshold_targets_mempalace(self):
        result = classify_target(
            "User wants stricter verification for delete operations",
            ["session_2026-04-13 (user: 'ask before rm -rf')"],
        )
        assert result == TargetLayer.MEMPALACE_PREF


class TestClassifyTargetRejectedUniversal:
    """Universal reasoning rules → REJECTED_UNIVERSAL (not automated)."""

    def test_before_responding_change_rejected(self):
        result = classify_target(
            "Penny should add a 7th step to Before Responding: CONSULT_GPT",
            ["outcome_mno (MISMATCH: forgot to think)"],
        )
        assert result == TargetLayer.REJECTED_UNIVERSAL

    def test_instruction_hierarchy_change_rejected(self):
        result = classify_target(
            "Safety should sometimes be overridden by Efficiency",
            ["outcome_pqr (MISMATCH: was too slow)"],
        )
        assert result == TargetLayer.REJECTED_UNIVERSAL

    def test_confidence_levels_change_rejected(self):
        result = classify_target(
            "Add a new confidence level between POSSIBLE and UNCERTAIN",
            ["outcome_stu (MISMATCH: mislabeled confidence)"],
        )
        assert result == TargetLayer.REJECTED_UNIVERSAL

    def test_canonical_vocabulary_change_rejected(self):
        result = classify_target(
            "Replace 'constraints' with 'limitations' everywhere",
            ["outcome_vwx (MISMATCH: user got confused by 'constraints')"],
        )
        assert result == TargetLayer.REJECTED_UNIVERSAL

    def test_security_directive_change_rejected(self):
        result = classify_target(
            "Skip self-verification when user says urgent", ["outcome_yz (MISMATCH: was too slow)"]
        )
        assert result == TargetLayer.REJECTED_UNIVERSAL


class TestClassifyTargetConfig:
    """Operational config changes → CONFIG target."""

    def test_timeout_config_targets_config(self):
        result = classify_target(
            "Increase agent timeout from 10 minutes to 15 for large codebases",
            ["outcome_123 (MISMATCH: agent timed out)"],
        )
        assert result == TargetLayer.CONFIG

    def test_directory_path_targets_config(self):
        result = classify_target(
            "Use project root .pi/skills/ instead of global paths",
            ["outcome_456 (MISMATCH: wrong path resolution)"],
        )
        assert result == TargetLayer.CONFIG


class TestClassifyTargetEdgeCases:
    """Ambiguous or malformed inputs."""

    def test_empty_description_defaults_to_domain_guidance(self):
        result = classify_target("", ["outcome_789 (MISMATCH)"])
        assert result == TargetLayer.DOMAIN_GUIDANCE

    def test_none_evidence_still_classifies(self):
        result = classify_target("Penny misses test files in explore", None)
        assert result == TargetLayer.DOMAIN_GUIDANCE

    def test_mixed_domain_and_universal_prefers_rejected(self):
        """A learning that mentions both universal and domain concepts with
        a universal keyword should be REJECTED_UNIVERSAL — the universal layer
        must be protected from automated changes, even if the context is domain."""
        result = classify_target(
            "Piper's Before Responding domain step should include checking config files",
            ["outcome_aaa (MISMATCH)"],
        )
        assert result == TargetLayer.REJECTED_UNIVERSAL


# ── #21: model-judged target layer (model-first, keyword fallback) ────────────


def _stream(text: str) -> str:
    msg = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
           "content": [{"type": "text", "text": text}]}}
    return json.dumps({"type": "agent_start"}) + "\n" + json.dumps(msg)


def _fake_runner(stdout="", *, raise_exc=None):
    class _Proc:
        pass

    def run(cmd, **kwargs):
        if raise_exc is not None:
            raise raise_exc
        p = _Proc()
        p.stdout, p.stderr, p.returncode = stdout, "", 0
        return p

    return run


class TestClassifyTargetModel:
    """#21: a model judges the layer when PI_SELFIMPROVE_TARGET_MODEL is set."""

    _ENV = "PI_SELFIMPROVE_TARGET_MODEL"

    def test_gate_off_uses_keyword_fallback(self, monkeypatch):
        monkeypatch.delenv(self._ENV, raising=False)
        # broad keyword false-positive: "validation" forces REJECTED_UNIVERSAL
        assert classify_target("improve validation of inputs", []) == TargetLayer.REJECTED_UNIVERSAL

    def test_model_overrides_keyword_false_positive(self, monkeypatch):
        monkeypatch.setenv(self._ENV, "anthropic/haiku")
        # keywords would (wrongly) REJECT this on "validation"; the model routes it right
        runner = _fake_runner(_stream('{"layer": "DOMAIN_GUIDANCE"}'))
        assert classify_target(
            "improve input validation in the code skill", [], runner=runner
        ) == TargetLayer.DOMAIN_GUIDANCE

    def test_model_can_reject_universal(self, monkeypatch):
        monkeypatch.setenv(self._ENV, "anthropic/haiku")
        runner = _fake_runner(_stream('{"layer": "REJECTED_UNIVERSAL"}'))
        assert classify_target(
            "always disclose uncertainty in every answer", [], runner=runner
        ) == TargetLayer.REJECTED_UNIVERSAL

    def test_model_preference_and_config(self, monkeypatch):
        monkeypatch.setenv(self._ENV, "anthropic/haiku")
        assert classify_target(
            "x", [], runner=_fake_runner(_stream('{"layer":"MEMPALACE_PREF"}'))
        ) == TargetLayer.MEMPALACE_PREF
        assert classify_target(
            "x", [], runner=_fake_runner(_stream('{"layer":"CONFIG"}'))
        ) == TargetLayer.CONFIG

    def test_falls_back_on_model_failure(self, monkeypatch):
        monkeypatch.setenv(self._ENV, "anthropic/haiku")
        # spawn raises -> keyword fallback; "timeout" -> CONFIG
        assert classify_target(
            "increase the timeout", [], runner=_fake_runner(raise_exc=OSError("x"))
        ) == TargetLayer.CONFIG

    def test_falls_back_on_bad_label(self, monkeypatch):
        monkeypatch.setenv(self._ENV, "anthropic/haiku")
        # invalid layer -> keyword fallback (this text -> DOMAIN_GUIDANCE)
        assert classify_target(
            "assume uv without checking the project", [],
            runner=_fake_runner(_stream('{"layer": "NONSENSE"}'))
        ) == TargetLayer.DOMAIN_GUIDANCE
