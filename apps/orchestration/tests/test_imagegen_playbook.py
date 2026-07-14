"""Integration tests for the imagegen skill (ImagegenPlaybook) on the engine.

Drives the full FSM end-to-end through ``start()``/``step()`` with the three
external-effect seams (``_check_readiness``, ``_comfy_generate``,
``_ensure_output_dir``) stubbed, so NO live ComfyUI is ever touched — the whole
suite is hermetic (success criterion: "zero live-service dependency").

Coverage maps to the IDEAL_STATE acceptance criteria:
  * 4-way preset routing matrix (0 misroutes) — via the pure ``route_preset``.
  * fail-fast readiness (unreachable / missing required checkpoint) — actionable
    error, 0 silent hangs.
  * missing steampunk LoRA degrades to base FLUX with a WARN (0 hard failures).
  * default candidate count 3; >10 clamped to 10 with a warning.
  * one-candidate-at-a-time sequential generation + manifest.
  * vera+carren parallel critique; NEEDS_REVISION if EITHER flags.
  * bounded revise loop (max_iterations=2) with honest exhaustion (met=False +
    itemized unresolved issues, best vera-valid candidate presented).
  * regenerate ONLY the failed candidates on a revise loop.
  * composed prompt > 4000 chars truncated before generating.
  * raw-override passthrough with the wordless negative still applied.
  * UNCERTAIN / needs_clarification escalation + clarify resume.
  * partial batch (ComfyUI dies mid-run) persists + surfaces a partial error.
  * dual-format (human + machine) result contract.
"""

import pytest
from orchestration.checkpointer import STATUS_AWAITING_USER, STATUS_RUNNING, Checkpointer
from orchestration.playbooks import get_playbook
from orchestration.playbooks.imagegen import (
    WORDLESS_NEGATIVE,
    ImagegenMachine,
    ImagegenPlaybook,
    route_preset,
)

SID, RID = "sess-imagegen", "run-imagegen"


class FakeImagegen(ImagegenPlaybook):
    """ImagegenPlaybook with all external effects stubbed. Class attributes let a
    per-test subclass tune readiness / generation without a live service."""

    NAME = "imagegen"
    readiness = {
        "reachable": True,
        "comfy_version": "0.27.0-test",
        "missing_optional": [],
        "lora_fallback": False,
    }
    readiness_error: Exception | None = None
    fail_indices: tuple[int, ...] = ()

    def _check_readiness(self, ctx, preset):
        if self.readiness_error is not None:
            raise self.readiness_error
        return dict(self.readiness)

    def _ensure_output_dir(self, ctx, requested):
        return requested or "/tmp/imagegen-test"

    def _comfy_generate(self, ctx, plan):
        # Record the plan so tests can assert host lock + which indices regenerated.
        ctx.extras.setdefault("imagegen", {}).setdefault("_plans", []).append(dict(plan))
        candidates, errors = [], []
        for i in plan["indices"]:
            if i in self.fail_indices:
                errors.append(f"candidate {i} (seed {plan['base_seed'] + i}) failed: comfy died")
                continue
            candidates.append(
                {
                    "index": i,
                    "seed": plan["base_seed"] + i,
                    "prompt_id": f"pid-{i}",
                    "graph_sha256": f"hash-{i}",
                    "files": [f"/tmp/imagegen-test/cand{i}.png"],
                }
            )
        return {
            "candidates": candidates,
            "errors": errors,
            "manifest_path": "/tmp/imagegen-test/manifest.json",
        }


@pytest.fixture
def cp(tmp_path):
    return Checkpointer(db_path=tmp_path / "orch.db")


def _start(cp, constraints=None, goal="a red hot-air balloon", cls=FakeImagegen):
    return cls(cp).start(session_id=SID, run_id=RID, goal=goal, constraints=constraints or {})


def _step(cp, agent, result, cls=FakeImagegen):
    return cls(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)


def _frame(cp, cls=FakeImagegen, **extra):
    return _step(cp, "annie", {"frame_complete": True, "confidence": "CERTAIN", **extra}, cls=cls)


def _compose(cp, cls=FakeImagegen, **extra):
    return _step(
        cp,
        "synthia",
        {"compose_complete": True, "confidence": "CERTAIN", **extra},
        cls=cls,
    )


def _critique(cp, vera, carren, cls=FakeImagegen):
    # Both critic contracts now REQUIRE non-empty `evidence` (grounded verdict).
    # Default it for the routing-focused tests; a test can override by passing
    # `evidence` explicitly (incl. [] to exercise the contract-violation path).
    vera = {"evidence": ["cand: technical check seen"], **vera}
    carren = {"evidence": ["cand: aesthetic check seen"], **carren}
    return _step(
        cp,
        "__parallel__",
        [
            {"branch_id": "vera", "agent": "vera", "summary": vera, "exitCode": 0},
            {"branch_id": "carren", "agent": "carren", "summary": carren, "exitCode": 0},
        ],
        cls=cls,
    )


_APPROVE = {"verdict": "APPROVE", "confidence": "CERTAIN"}


# ---------------------------------------------------------------------------
# Registration + FSM well-formedness
# ---------------------------------------------------------------------------


def test_get_playbook_resolves_imagegen():
    assert get_playbook("imagegen") is ImagegenPlaybook


def test_machine_has_required_control_states():
    m = ImagegenMachine()
    ids = {s.id for s in m.states}
    assert {"intake", "unknown", "awaiting_clarification", "complete", "error"} <= ids
    assert m.intake.initial and m.complete.final and m.error.final


def test_escalatable_states_reachable_by_to_unknown():
    m = ImagegenMachine()
    sources = {t.source.id for s in m.states for t in s.transitions if t.event == "to_unknown"}
    assert ImagegenPlaybook.ESCALATABLE_STATES <= sources


# ---------------------------------------------------------------------------
# Routing matrix — 0 misroutes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "goal,expected",
    [
        ("a steampunk owl for the blog post", "blog-flux-steampunk"),
        ("a concept diagram explaining light polarization for the lesson", "learning-qwen"),
        ("an abstract hero header banner", "hero-flux"),
        ("a red hot-air balloon over a valley", "general-flux"),
    ],
)
def test_routing_matrix_no_misroutes(goal, expected):
    assert route_preset(goal) == expected


def test_caller_specified_preset_wins():
    assert route_preset("a red balloon", "hero-flux") == "hero-flux"


def test_preset_keyword_router_is_a_tagged_loan(monkeypatch):
    # Ablated: the keyword heuristic is skipped; an unspecified preset falls to
    # the general-flux catch-all (only a caller constraint routes).
    monkeypatch.setenv("PENNY_ABLATE_IMAGEGEN_PRESET_KEYWORD_ROUTER", "1")
    assert route_preset("a steampunk owl for the blog post") == "general-flux"
    assert route_preset("a steampunk owl", "blog-flux-steampunk") == "blog-flux-steampunk"
    monkeypatch.delenv("PENNY_ABLATE_IMAGEGEN_PRESET_KEYWORD_ROUTER", raising=False)
    # Enabled (default): the keyword heuristic routes again.
    assert route_preset("a steampunk owl for the blog post") == "blog-flux-steampunk"


def test_recall_lessons_render_in_first_directive(cp):
    from orchestration.context import RunContext
    from orchestration.primitives.spec import PrimitiveSpec

    pb = ImagegenPlaybook(cp)
    ctx = RunContext(session_id=SID, run_id=RID, playbook="imagegen", goal="a hero image")
    ctx.recall_lessons = ["prefer wordless negatives; never bake text into the image"]
    spec = PrimitiveSpec("X", "synthia", {"required": {}, "optional": {}}, "compose")
    txt = pb._task_summary("_no_builder_state_", spec, ctx)
    assert "Lessons from prior runs" in txt
    assert "wordless negatives" in txt


def test_invalid_caller_preset_falls_back_to_heuristic():
    assert route_preset("a steampunk owl", "not-a-preset") == "blog-flux-steampunk"


# ---------------------------------------------------------------------------
# #16: model-first preset selection (gated), keyword router as fallback
# ---------------------------------------------------------------------------


def _mstream(text: str) -> str:
    import json as _j

    msg = {
        "type": "message_end",
        "message": {
            "role": "assistant", "stopReason": "stop",
            "content": [{"type": "text", "text": text}],
        },
    }
    return _j.dumps({"type": "agent_start"}) + "\n" + _j.dumps(msg)


def _mrunner(stdout: str):
    import types as _t

    def run(cmd, **kwargs):
        return _t.SimpleNamespace(stdout=stdout, stderr="", returncode=0)

    return run


def test_preset_model_first_picks_from_menu(monkeypatch):
    import json as _j

    monkeypatch.setenv("PI_IMAGEGEN_PRESET_MODEL", "anthropic/haiku")
    # mixed intent the keyword sets misroute (steampunk + hero) -> model disambiguates
    payload = _j.dumps(
        {"answer": "hero-flux", "evidence": ["hero header intent"], "confidence": "PROBABLE"}
    )
    assert route_preset(
        "a steampunk-styled hero header", runner=_mrunner(_mstream(payload))
    ) == "hero-flux"


def test_preset_model_other_falls_back_to_keyword(monkeypatch):
    import json as _j

    monkeypatch.setenv("PI_IMAGEGEN_PRESET_MODEL", "anthropic/haiku")
    payload = _j.dumps({"answer": "other", "confidence": "UNCERTAIN"})
    # model abstains -> the keyword router still routes 'blog' correctly
    assert route_preset(
        "a steampunk owl for the blog post", runner=_mrunner(_mstream(payload))
    ) == "blog-flux-steampunk"


def test_preset_caller_request_wins_over_model(monkeypatch):
    monkeypatch.setenv("PI_IMAGEGEN_PRESET_MODEL", "anthropic/haiku")
    # an explicit valid request short-circuits before any model call is made
    assert route_preset(
        "anything", "learning-qwen", runner=_mrunner("NOT-JSON-SHOULD-NOT-BE-USED")
    ) == "learning-qwen"


# ---------------------------------------------------------------------------
# Fail-fast readiness
# ---------------------------------------------------------------------------


def test_start_advances_to_framing_when_ready(cp):
    d = _start(cp)
    assert d["action"] == "invoke_agent" and d["agent"] == "annie" and d["state_id"] == "framing"
    rec = cp.load(RID)
    assert rec.status == STATUS_RUNNING and rec.current_state_id == "framing"
    assert rec.context.extras["imagegen"]["preset"] == "general-flux"


def test_unreachable_comfy_fails_fast_with_actionable_error(cp):
    class Unreachable(FakeImagegen):
        readiness_error = RuntimeError(
            "ComfyUI is not reachable at http://127.0.0.1:8188 (connection refused). "
            "Is comfy-ui.service running?"
        )

    d = _start(cp, cls=Unreachable)
    assert d["action"] == "error"
    assert any("not reachable" in e for e in d["errors"])
    assert cp.load(RID).current_state_id == "error"


def test_missing_required_checkpoint_hard_fails_naming_file(cp):
    class MissingCkpt(FakeImagegen):
        readiness_error = RuntimeError(
            "preset 'general-flux' requires model file(s) not installed in ComfyUI: "
            "flux1-dev-fp8.safetensors. Install them under the ComfyUI models dir."
        )

    d = _start(cp, cls=MissingCkpt)
    assert d["action"] == "error"
    assert any("flux1-dev-fp8.safetensors" in e for e in d["errors"])


def test_missing_lora_warns_and_falls_back_to_base(cp):
    class LoraMissing(FakeImagegen):
        readiness = {
            "reachable": True,
            "comfy_version": "0.27.0",
            "missing_optional": ["steampunk_illustration.safetensors"],
            "lora_fallback": True,
        }

    d = _start(cp, goal="a steampunk owl for the blog", cls=LoraMissing)
    # Not a hard failure — it advances to framing.
    assert d["action"] == "invoke_agent" and d["state_id"] == "framing"
    img = cp.load(RID).context.extras["imagegen"]
    assert img["lora_fallback"] is True
    assert any("falling back to base" in w for w in img["warnings"])


# ---------------------------------------------------------------------------
# Candidate count
# ---------------------------------------------------------------------------


def test_default_candidate_count_is_three(cp):
    _start(cp)
    assert cp.load(RID).context.extras["imagegen"]["count"] == 3


def test_count_over_ten_clamped_with_warning(cp):
    _start(cp, constraints={"count": 25})
    img = cp.load(RID).context.extras["imagegen"]
    assert img["count"] == 10
    assert any("clamped" in w for w in img["warnings"])


def test_max_iterations_defaults_to_two(cp):
    _start(cp)
    assert cp.load(RID).context.max_iterations == 2


# ---------------------------------------------------------------------------
# Happy path to complete (approved)
# ---------------------------------------------------------------------------


def test_full_happy_path_to_complete(cp):
    _start(cp)
    d_compose = _frame(cp)
    assert d_compose["agent"] == "synthia" and d_compose["state_id"] == "composing"
    # After composing, generating (tool) runs inline -> critiquing (parallel).
    d_critique = _compose(cp, positive_prompt="a red balloon", negative_prompt=WORDLESS_NEGATIVE)
    assert d_critique["action"] == "invoke_agents_parallel"
    assert d_critique["state_id"] == "critiquing"
    agents = {t["agent"] for t in d_critique["tasks"]}
    assert agents == {"vera", "carren"}
    # Candidates were generated one at a time (3 of them).
    img = cp.load(RID).context.extras["imagegen"]
    assert len(img["candidates_by_index"]) == 3
    assert img["_plans"][0]["host"] == "127.0.0.1:8188"  # host locked
    assert img["_plans"][0]["indices"] == [0, 1, 2]
    # Both critics approve -> presenting -> complete.
    d = _critique(cp, _APPROVE | {"valid_candidates": [0, 1, 2], "best_candidate": 1}, _APPROVE)
    assert d["action"] == "complete"
    assert d["result"]["met"] is True
    assert d["result"]["approved"] is True
    assert d["result"]["best_candidate"]["index"] == 1


def test_manifest_path_surfaced_in_result(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    d = _critique(cp, _APPROVE, _APPROVE)
    assert d["result"]["manifest_path"] == "/tmp/imagegen-test/manifest.json"


def test_critic_without_evidence_is_contract_violation(cp):
    # A critic verdict with no cited observations is not independently checkable;
    # the engine treats the empty `evidence` as a contract violation and re-issues
    # the critique rather than routing on an ungrounded verdict.
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    d = _critique(cp, _APPROVE | {"evidence": []}, _APPROVE)
    assert d["state_id"] == "critiquing"
    assert d["action"] in ("invoke_agents_parallel", "invoke_agent")


# ---------------------------------------------------------------------------
# Critique: NEEDS_REVISION if EITHER flags
# ---------------------------------------------------------------------------


def test_either_critic_flags_triggers_revision(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    # vera approves, carren flags candidate 1 -> NEEDS_REVISION -> adjusting (synthia).
    d = _critique(
        cp,
        _APPROVE | {"valid_candidates": [0, 1, 2]},
        {
            "verdict": "NEEDS_REVISION",
            "confidence": "PROBABLE",
            "failed_candidates": [1],
            "issues": ["candidate 1 is off-brief"],
        },
    )
    assert (
        d["action"] == "invoke_agent" and d["agent"] == "synthia" and d["state_id"] == "adjusting"
    )


def test_critique_unknown_verdict_errors(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    d = _critique(cp, {"verdict": "MAYBE", "confidence": "CERTAIN"}, _APPROVE)
    assert d["action"] == "error"


# ---------------------------------------------------------------------------
# Regenerate ONLY the failed candidates
# ---------------------------------------------------------------------------


def test_revise_regenerates_only_failed_candidates(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    # carren flags candidate 2 only.
    _critique(
        cp,
        _APPROVE | {"valid_candidates": [0, 1, 2]},
        {
            "verdict": "NEEDS_REVISION",
            "confidence": "PROBABLE",
            "failed_candidates": [2],
            "issues": ["cand 2 muddy"],
        },
    )
    # adjusting -> generating (regen only [2]) -> critiquing.
    d = _step(
        cp,
        "synthia",
        {
            "adjust_complete": True,
            "confidence": "CERTAIN",
            "positive_prompt": "x sharper",
            "strategy_change": "sharpen",
        },
    )
    assert d["action"] == "invoke_agents_parallel" and d["state_id"] == "critiquing"
    img = cp.load(RID).context.extras["imagegen"]
    # The second generate plan regenerated ONLY index 2.
    assert img["_plans"][-1]["indices"] == [2]
    # All 3 candidates still present (0 and 1 kept, 2 replaced).
    assert set(img["candidates_by_index"]) == {"0", "1", "2"}


# ---------------------------------------------------------------------------
# Bounded loop + honest exhaustion
# ---------------------------------------------------------------------------


def test_bounded_loop_exhausts_honestly(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    flag = {
        "verdict": "NEEDS_REVISION",
        "confidence": "PROBABLE",
        "failed_candidates": [0],
        "issues": ["still off-brief"],
    }
    # iteration 0 -> revise
    d1 = _critique(cp, _APPROVE | {"valid_candidates": [1, 2]}, flag)
    assert d1["state_id"] == "adjusting"
    _step(
        cp,
        "synthia",
        {"adjust_complete": True, "confidence": "CERTAIN", "strategy_change": "try teal"},
    )
    # iteration 1 -> still flagged -> budget spent (max_iterations=2) -> exhausted -> complete
    d2 = _critique(cp, _APPROVE | {"valid_candidates": [1, 2]}, flag)
    assert d2["action"] == "complete"
    assert d2["result"]["met"] is False
    assert d2["result"]["approved"] is False
    assert d2["result"]["exhausted"] is True
    assert d2["result"]["unresolved_issues"]  # itemized, not fabricated pass
    # Presents the best vera-valid candidate (index 1, first valid).
    assert d2["result"]["best_candidate"]["index"] == 1


def test_loop_never_exceeds_max_iterations(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    flag = {
        "verdict": "NEEDS_REVISION",
        "confidence": "PROBABLE",
        "failed_candidates": [0],
        "issues": ["bad"],
    }
    _critique(cp, _APPROVE | {"valid_candidates": [0]}, flag)  # it0 -> revise
    _step(cp, "synthia", {"adjust_complete": True, "confidence": "CERTAIN", "strategy_change": "a"})
    d = _critique(cp, _APPROVE | {"valid_candidates": [0]}, flag)  # it1 -> exhausted
    assert d["action"] == "complete"
    assert cp.load(RID).context.iteration == 1  # 2 generate passes total (0 and 1)


# ---------------------------------------------------------------------------
# Prompt handling
# ---------------------------------------------------------------------------


def test_composed_prompt_truncated_over_4000(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="z" * 4500)
    img = cp.load(RID).context.extras["imagegen"]
    assert len(img["positive"]) == 4000
    assert any("truncated" in w for w in img["warnings"])


def test_raw_override_passthrough_with_wordless_negative(cp):
    _start(cp, constraints={"raw_prompt": "MY EXACT PROMPT with a label please"})
    _frame(cp)
    # synthia composes something else, but the raw override wins the positive slot.
    _compose(cp, positive_prompt="synthia's version")
    img = cp.load(RID).context.extras["imagegen"]
    assert img["positive"] == "MY EXACT PROMPT with a label please"
    # Wordless negative still applies (v1 does not block the positive).
    assert img["negative"] == WORDLESS_NEGATIVE


# ---------------------------------------------------------------------------
# Escalation
# ---------------------------------------------------------------------------


def test_framing_uncertain_escalates_then_clarify_resumes(cp):
    _start(cp)
    d = _step(cp, "annie", {"frame_complete": False, "confidence": "UNCERTAIN"})
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "framing"
    assert cp.load(RID).status == STATUS_AWAITING_USER
    d2 = _step(cp, "user", {"answer": "make it a brass owl"})
    assert d2["action"] == "invoke_agent" and d2["agent"] == "annie" and d2["state_id"] == "framing"


def test_composing_needs_clarification_escalates(cp):
    _start(cp)
    _frame(cp)
    d = _step(
        cp,
        "synthia",
        {
            "compose_complete": False,
            "confidence": "PROBABLE",
            "needs_clarification": True,
            "clarifying_questions": ["which color palette?"],
        },
    )
    assert d["action"] == "escalate_to_user"
    assert "which color palette?" in d["unknown_reason"]


def test_critique_uncertain_escalates(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    d = _critique(cp, {"verdict": "APPROVE", "confidence": "UNCERTAIN"}, _APPROVE)
    assert d["action"] == "escalate_to_user" and d["previous_state"] == "critiquing"


# ---------------------------------------------------------------------------
# Partial batch (ComfyUI dies mid-run)
# ---------------------------------------------------------------------------


def test_partial_batch_persists_and_surfaces_error(cp):
    class PartialFail(FakeImagegen):
        fail_indices = (2,)  # comfy dies before candidate 2

    _start(cp, cls=PartialFail)
    _frame(cp, cls=PartialFail)
    d = _compose(cp, cls=PartialFail, positive_prompt="x")
    # 2 of 3 candidates persisted -> proceeds to critiquing (not a hard fail).
    assert d["action"] == "invoke_agents_parallel"
    img = cp.load(RID).context.extras["imagegen"]
    assert set(img["candidates_by_index"]) == {"0", "1"}
    assert any("comfy died" in e for e in img["partial_errors"])
    # The partial error is surfaced in the final result.
    dfin = _critique(cp, _APPROVE | {"valid_candidates": [0, 1]}, _APPROVE, cls=PartialFail)
    assert dfin["result"]["partial_batch_errors"]


def test_zero_candidates_is_a_hard_error(cp):
    class AllFail(FakeImagegen):
        fail_indices = (0, 1, 2)

    _start(cp, cls=AllFail)
    _frame(cp, cls=AllFail)
    d = _compose(cp, cls=AllFail, positive_prompt="x")
    assert d["action"] == "error"
    assert any("0 candidates" in e for e in d["errors"])


# ---------------------------------------------------------------------------
# Dual-format result contract
# ---------------------------------------------------------------------------


def test_dual_format_result_contract(cp):
    _start(cp)
    _frame(cp)
    _compose(cp, positive_prompt="x")
    d = _critique(cp, _APPROVE | {"valid_candidates": [0, 1, 2]}, _APPROVE)
    result = d["result"]
    # Human-readable format.
    assert isinstance(result["human"], str) and "Image generation" in result["human"]
    # Machine format.
    machine = result["machine"]
    assert machine["preset"] == "general-flux"
    assert machine["candidate_count"] == 3
    assert machine["approved"] is True
    assert "candidates" in machine and "manifest_path" in machine
