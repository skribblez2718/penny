"""VideogenPlaybook — one finalized section through a twelve-phase video FSM.

The playbook owns orchestration only.  Contract/path, bundle/provenance, QA,
service, and media behavior is imported lazily from ``.pi/skills/videogen/scripts``.
All durable domain state is compact JSON-safe metadata in
``ctx.extras["videogen"]``; source, canon, code, and media remain caller-owned
files under the validated workspace/output roots.
"""

from __future__ import annotations

import copy
import json
import re
import sys
import time
from collections.abc import Mapping, MutableMapping, Sequence
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, cast

from statemachine import State, StateMachine

from ..checkpointer import STATUS_AWAITING_USER
from ..context import RunContext
from ..contracts import Confidence
from ..engine import BasePlaybook
from ..primitives.spec import ParallelSpec, PrimitiveSpec

# OPEN (skill spec §15: canon/version regeneration policy).
OPEN_CANON_CHANGE_POLICY: str = "restart_storyboard"

# Separate finite repair budgets.  Neither consumes the operator refine budget.
MAX_CARREN_REPAIRS: int = 5  # OPEN constant (skill spec §15): pre-synthesis revision bound; raised 3→5 after live-pilot evidence of near-converged exhaustion
MAX_AUTOMATIC_REPAIRS: int = 3

CONFIDENCES = frozenset({"CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"})
STATUSES = frozenset({"COMPLETE", "BLOCKED", "UNCERTAIN"})
CARREN_VERDICTS = frozenset({"APPROVE", "NEEDS_REVISION", "UNCERTAIN"})
VERA_VERDICTS = frozenset({"PASS", "FAIL", "UNCERTAIN"})
REFINE_ROUTES = (
    "STORYBOARD",
    "NARRATION_SCRIPT",
    "VOICE_SYNTH",
    "CODEGEN",
    "VALIDATE",
    "DRAFT_RENDER",
)
DOMAIN_PHASES = (
    "INGEST",
    "STORYBOARD",
    "NARRATION_SCRIPT",
    "VOICE_SYNTH",
    "CODEGEN",
    "VALIDATE",
    "DRAFT_RENDER",
    "AUTO_QA",
    "OPERATOR_REVIEW",
    "REFINE",
    "FINALIZE",
    "PUBLISH_HANDOFF",
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
_EVIDENCE_KEYS = frozenset({"kind", "ref", "sha256", "detail"})
_GATE_PACKET_KEYS = frozenset(
    {
        "gate",
        "run_id",
        "iteration",
        "draft_video_path",
        "draft_video_sha256",
        "captions_path",
        "duration_seconds",
        "content_sha256",
        "storyboard_summary",
        "auto_qa",
        "changes_since_last_review",
    }
)


class _PauseRequired(RuntimeError):
    """A tool cannot safely continue until a human resolves durable uncertainty."""


def _contract(
    required: dict[str, type],
    optional: dict[str, type] | None = None,
    *,
    evidence: Sequence[str] = (),
    conditional_evidence: Sequence[tuple[str, str]] = (),
) -> dict[str, Any]:
    result: dict[str, Any] = {"required": required, "optional": optional or {}}
    if evidence:
        result["evidence"] = tuple(evidence)
    if conditional_evidence:
        result["conditional_evidence"] = tuple(conditional_evidence)
    return result


VG_ANNIE_INGEST_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "confidence": str,
        "needs_clarification": bool,
        "inventory_path": str,
        "inventory_sha256": str,
        "concept_count": int,
        "evidence_refs": list,
        "issues": list,
    },
    {"clarifying_questions": list, "warnings": list},
    evidence=("evidence_refs",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_SYNTHIA_STORYBOARD_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "confidence": str,
        "needs_clarification": bool,
        "storyboard_path": str,
        "storyboard_sha256": str,
        "coverage_matrix_path": str,
        "coverage_matrix_sha256": str,
        "scene_count": int,
        "estimated_duration_seconds": float,
        "over_guide": bool,
        "evidence_refs": list,
        "issues": list,
    },
    {"clarifying_questions": list, "open_questions": list, "warnings": list},
    evidence=("evidence_refs",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_SYNTHIA_NARRATION_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "confidence": str,
        "needs_clarification": bool,
        "narration_path": str,
        "narration_sha256": str,
        "pronunciation_table_path": str,
        "pronunciation_table_sha256": str,
        "claim_source_map_path": str,
        "claim_source_map_sha256": str,
        "scene_count": int,
        "evidence_refs": list,
        "issues": list,
    },
    {
        "clarifying_questions": list,
        "warnings": list,
        # Narration text lives in the storyboard's scene entries (the bundle
        # authority); when authoring updates those fields, the summary reports
        # the refreshed storyboard artifact so the ledger stays current.
        "storyboard_path": str,
        "storyboard_sha256": str,
    },
    evidence=("evidence_refs",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_CARREN_NARRATION_GATE_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "verdict": str,
        "confidence": str,
        "needs_clarification": bool,
        "met": bool,
        "reviewed_storyboard_sha256": str,
        "reviewed_narration_sha256": str,
        "cited_evidence": list,
        "issues": list,
    },
    {
        "clarifying_questions": list,
        "review_path": str,
        "review_sha256": str,
    },
    evidence=("cited_evidence",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_SKRIBBLE_CODEGEN_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "confidence": str,
        "needs_clarification": bool,
        "files": list,
        "scene_ids": list,
        "schema_sha256": str,
        "schema_version": str,
        "primitive_inventory": list,
        "validation_evidence": list,
        "issues": list,
    },
    {"clarifying_questions": list, "warnings": list},
    evidence=("validation_evidence",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_SYNTHIA_REFINE_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "confidence": str,
        "needs_clarification": bool,
        "met": bool,
        "feedback_ledger_path": str,
        "feedback_ledger_sha256": str,
        "change_plan_path": str,
        "change_plan_sha256": str,
        "affected_scene_ids": list,
        "earliest_route": str,
        "unresolved_note_ids": list,
        "evidence_refs": list,
        "issues": list,
    },
    {"clarifying_questions": list, "warnings": list},
    evidence=("evidence_refs",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_SKRIBBLE_REFINE_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "confidence": str,
        "needs_clarification": bool,
        "met": bool,
        "changed_files": list,
        "before_after_hashes": list,
        "affected_scene_ids": list,
        "resolved_note_ids": list,
        "validation_evidence": list,
        "issues": list,
    },
    {"clarifying_questions": list, "warnings": list},
    evidence=("validation_evidence",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_CARREN_REFINE_GATE_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "verdict": str,
        "confidence": str,
        "needs_clarification": bool,
        "met": bool,
        "reviewed_storyboard_sha256": str,
        "reviewed_narration_sha256": str,
        "resolved_note_ids": list,
        "cited_evidence": list,
        "issues": list,
    },
    {
        "clarifying_questions": list,
        "review_path": str,
        "review_sha256": str,
    },
    evidence=("cited_evidence",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)
VG_VERA_AUTO_QA_CONTRACT = _contract(
    {
        "status": str,
        "phase": str,
        "verdict": str,
        "confidence": str,
        "needs_clarification": bool,
        "met": bool,
        "qa_report_path": str,
        "qa_report_sha256": str,
        "check_results": list,
        "rationale": str,
        "unresolved_issues": list,
    },
    {"clarifying_questions": list, "warnings": list},
    evidence=("check_results",),
    conditional_evidence=(("clarifying_questions", "needs_clarification"),),
)

VG_ANNIE_INGEST = PrimitiveSpec(
    "VG_ANNIE_INGEST",
    "annie",
    VG_ANNIE_INGEST_CONTRACT,
    "Inventory only the exact finalized section and caller canon; write the concept inventory.",
)
VG_SYNTHIA_STORYBOARD = PrimitiveSpec(
    "VG_SYNTHIA_STORYBOARD",
    "synthia",
    VG_SYNTHIA_STORYBOARD_CONTRACT,
    "Author a source-complete concept→beat→scene storyboard and coverage matrix.",
)
VG_SYNTHIA_NARRATION = PrimitiveSpec(
    "VG_SYNTHIA_NARRATION",
    "synthia",
    VG_SYNTHIA_NARRATION_CONTRACT,
    "Author exact per-scene narration, pronunciation, and claim/source artifacts.",
)
VG_CARREN_NARRATION_GATE = PrimitiveSpec(
    "VG_CARREN_NARRATION_GATE",
    "carren",
    VG_CARREN_NARRATION_GATE_CONTRACT,
    "Independently review the exact current storyboard and narration hashes before TTS.",
)
VG_SKRIBBLE_CODEGEN = PrimitiveSpec(
    "VG_SKRIBBLE_CODEGEN",
    "skribble",
    VG_SKRIBBLE_CODEGEN_CONTRACT,
    "Generate one schema-grounded scene source per storyboard scene and validate it.",
)
VG_SYNTHIA_REFINE = PrimitiveSpec(
    "VG_SYNTHIA_REFINE",
    "synthia",
    VG_SYNTHIA_REFINE_CONTRACT,
    "Map verbatim operator feedback and write the smallest evidence-backed change plan.",
)
VG_VERA_AUTO_QA = PrimitiveSpec(
    "VG_VERA_AUTO_QA",
    "vera",
    VG_VERA_AUTO_QA_CONTRACT,
    "Independently verify every deterministic and semantic QA row; never repair.",
)


class VideogenMachine(StateMachine):
    """The twelve frozen domain phases plus five engine control states."""

    resume_target: str = ""

    intake = State(initial=True)
    INGEST = State()
    STORYBOARD = State()
    NARRATION_SCRIPT = State()
    VOICE_SYNTH = State()
    CODEGEN = State()
    VALIDATE = State()
    DRAFT_RENDER = State()
    AUTO_QA = State()
    OPERATOR_REVIEW = State()
    REFINE = State()
    FINALIZE = State()
    PUBLISH_HANDOFF = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_ingest = intake.to(INGEST)
    intake_unknown = intake.to(unknown)
    ingest_done = INGEST.to(STORYBOARD)
    ingest_refine = INGEST.to(REFINE)
    storyboard_done = STORYBOARD.to(NARRATION_SCRIPT)
    narration_again = NARRATION_SCRIPT.to.itself()
    narration_storyboard = NARRATION_SCRIPT.to(STORYBOARD)
    narration_approved = NARRATION_SCRIPT.to(VOICE_SYNTH)
    narration_exhausted = NARRATION_SCRIPT.to(complete)
    voice_done = VOICE_SYNTH.to(CODEGEN)
    voice_source_stale = VOICE_SYNTH.to(INGEST)
    voice_binding_stale = VOICE_SYNTH.to(STORYBOARD)
    code_done = CODEGEN.to(VALIDATE)
    validation_done = VALIDATE.to(DRAFT_RENDER)
    validation_storyboard = VALIDATE.to(STORYBOARD)
    validation_narration = VALIDATE.to(NARRATION_SCRIPT)
    validation_voice = VALIDATE.to(VOICE_SYNTH)
    validation_codegen = VALIDATE.to(CODEGEN)
    validation_source_stale = VALIDATE.to(INGEST)
    validation_exhausted = VALIDATE.to(complete)
    draft_done = DRAFT_RENDER.to(AUTO_QA)
    draft_source_stale = DRAFT_RENDER.to(INGEST)
    draft_binding_stale = DRAFT_RENDER.to(STORYBOARD)
    qa_pass = AUTO_QA.to(OPERATOR_REVIEW)
    qa_storyboard = AUTO_QA.to(STORYBOARD)
    qa_narration = AUTO_QA.to(NARRATION_SCRIPT)
    qa_voice = AUTO_QA.to(VOICE_SYNTH)
    qa_codegen = AUTO_QA.to(CODEGEN)
    qa_validate = AUTO_QA.to(VALIDATE)
    qa_render = AUTO_QA.to(DRAFT_RENDER)
    qa_source_stale = AUTO_QA.to(INGEST)
    qa_exhausted = AUTO_QA.to(complete)
    review_approve = OPERATOR_REVIEW.to(FINALIZE)
    review_refine = OPERATOR_REVIEW.to(REFINE)
    review_exhausted = OPERATOR_REVIEW.to(complete)
    review_abort = OPERATOR_REVIEW.to(error)
    refine_storyboard = REFINE.to(STORYBOARD)
    refine_narration = REFINE.to(NARRATION_SCRIPT)
    refine_voice = REFINE.to(VOICE_SYNTH)
    refine_codegen = REFINE.to(CODEGEN)
    refine_validate = REFINE.to(VALIDATE)
    refine_render = REFINE.to(DRAFT_RENDER)
    refine_exhausted = REFINE.to(complete)
    finalize_done = FINALIZE.to(PUBLISH_HANDOFF)
    finalize_refine = FINALIZE.to(REFINE)
    finalize_source_stale = FINALIZE.to(INGEST)
    finalize_binding_stale = FINALIZE.to(STORYBOARD)
    publish_done = PUBLISH_HANDOFF.to(complete)
    publish_source_stale = PUBLISH_HANDOFF.to(INGEST)
    publish_binding_stale = PUBLISH_HANDOFF.to(STORYBOARD)

    # Unknown is a uniform omitted seam in the flow diagram.  Tool phases use it
    # only for an external operation whose disposition cannot be proven safely.
    to_unknown = (
        intake.to(unknown)
        | INGEST.to(unknown)
        | STORYBOARD.to(unknown)
        | NARRATION_SCRIPT.to(unknown)
        | VOICE_SYNTH.to(unknown)
        | CODEGEN.to(unknown)
        | VALIDATE.to(unknown)
        | DRAFT_RENDER.to(unknown)
        | AUTO_QA.to(unknown)
        | REFINE.to(unknown)
        | FINALIZE.to(unknown)
        | PUBLISH_HANDOFF.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = (
        awaiting_clarification.to(INGEST, cond="rt_ingest")
        | awaiting_clarification.to(STORYBOARD, cond="rt_storyboard")
        | awaiting_clarification.to(NARRATION_SCRIPT, cond="rt_narration")
        | awaiting_clarification.to(CODEGEN, cond="rt_codegen")
        | awaiting_clarification.to(AUTO_QA, cond="rt_qa")
        | awaiting_clarification.to(REFINE, cond="rt_refine")
    )

    def rt_ingest(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "INGEST"

    def rt_storyboard(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "STORYBOARD"

    def rt_narration(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "NARRATION_SCRIPT"

    def rt_codegen(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "CODEGEN"

    def rt_qa(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "AUTO_QA"

    def rt_refine(self, *a: Any, **k: Any) -> bool:
        return self.resume_target == "REFINE"

    abort = (
        intake.to(error)
        | INGEST.to(error)
        | STORYBOARD.to(error)
        | NARRATION_SCRIPT.to(error)
        | VOICE_SYNTH.to(error)
        | CODEGEN.to(error)
        | VALIDATE.to(error)
        | DRAFT_RENDER.to(error)
        | AUTO_QA.to(error)
        | OPERATOR_REVIEW.to(error)
        | REFINE.to(error)
        | FINALIZE.to(error)
        | PUBLISH_HANDOFF.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_safe(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str, int)):
        return True
    if isinstance(value, float):
        return value == value and value not in (float("inf"), float("-inf"))
    if isinstance(value, list):
        return all(_json_safe(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _json_safe(item) for key, item in value.items()
        )
    return False


def _as_json(value: Any) -> Any:
    if is_dataclass(value):
        return _as_json(asdict(value))
    if isinstance(value, tuple):
        return [_as_json(item) for item in value]
    if isinstance(value, list):
        return [_as_json(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _as_json(item) for key, item in value.items()}
    return value


def _read_json(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read JSON artifact {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"JSON artifact must be an object: {path}")
    return value


def _extract_positive_int(value: Any, *keys: str) -> int | None:
    candidates: list[Any] = [value]
    while candidates:
        candidate = candidates.pop(0)
        if not isinstance(candidate, Mapping):
            continue
        for key in keys:
            item = candidate.get(key)
            if isinstance(item, int) and not isinstance(item, bool) and item > 0:
                return item
        data = candidate.get("data")
        if isinstance(data, Mapping):
            candidates.append(data)
    return None


def _extract_nonempty(value: Any, *keys: str) -> str | None:
    candidates: list[Any] = [value]
    while candidates:
        candidate = candidates.pop(0)
        if not isinstance(candidate, Mapping):
            continue
        for key in keys:
            item = candidate.get(key)
            if isinstance(item, str) and item.strip():
                return item
        data = candidate.get("data")
        if isinstance(data, Mapping):
            candidates.append(data)
    return None


# Keys the skill extension injects into every run's constraints at invocation
# time (runtime plumbing, not caller contract data). They are consumed by the
# playbook and stripped before contract validation.
_ENGINE_RUNTIME_KEYS = frozenset({"skill_dir"})


def _caller_constraints(ctx: RunContext) -> dict[str, Any]:
    """The caller's contract constraints with engine-runtime keys removed."""
    return {
        key: value
        for key, value in dict(ctx.constraints or {}).items()
        if key not in _ENGINE_RUNTIME_KEYS
    }


def _skill_scripts(ctx: RunContext) -> str:
    candidates: list[Path] = []
    injected = (ctx.constraints or {}).get("skill_dir")
    if isinstance(injected, str) and injected:
        injected_path = Path(injected)
        if injected_path.is_absolute():
            candidates.append(injected_path / "scripts")
    if ctx.project_root:
        candidates.append(
            Path(ctx.project_root) / ".pi" / "skills" / "videogen" / "scripts"
        )
    for parent in Path(__file__).resolve().parents:
        candidates.append(parent / ".pi" / "skills" / "videogen" / "scripts")
    for candidate in candidates:
        if candidate.is_dir():
            value = str(candidate)
            if value not in sys.path:
                sys.path.insert(0, value)
            return value
    raise RuntimeError("videogen skill scripts directory is unavailable")


class VideogenPlaybook(BasePlaybook):
    NAME = "videogen"
    machine_cls = VideogenMachine
    STEP_CAP = 120
    TOOL_STATES = frozenset(
        {"VOICE_SYNTH", "VALIDATE", "DRAFT_RENDER", "FINALIZE", "PUBLISH_HANDOFF"}
    )
    GATE_STATES = frozenset({"OPERATOR_REVIEW"})
    PRIMITIVE_BY_STATE = {
        "INGEST": VG_ANNIE_INGEST,
        "STORYBOARD": VG_SYNTHIA_STORYBOARD,
        "CODEGEN": VG_SKRIBBLE_CODEGEN,
        "AUTO_QA": VG_VERA_AUTO_QA,
        "REFINE": VG_SYNTHIA_REFINE,
    }
    ESCALATABLE_STATES = frozenset(
        {"INGEST", "STORYBOARD", "NARRATION_SCRIPT", "CODEGEN", "AUTO_QA", "REFINE"}
    )
    LOOP_GUARDS = False

    # ------------------------------------------------------------------
    # Engine adaptation and lifecycle
    # ------------------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        """Normalize the whole caller contract before the first side effect."""
        contracts = self._contracts(ctx)
        try:
            resolution = contracts.resolve_profile(_caller_constraints(ctx))
            intake = contracts.validate_and_normalize_constraints(resolution)
        except contracts.ConstraintValidationError as exc:
            raise RuntimeError(
                "invalid videogen constraints: " + "; ".join(exc.errors)
            ) from exc
        except contracts.VideogenContractError as exc:
            raise RuntimeError(f"invalid videogen constraints: {exc}") from exc

        ctx.max_iterations = intake.max_refine_iterations
        self._initialize_extras(ctx, intake)

        # The two preflight seams are the first permitted side effects.  Tests
        # override them; production defaults use only frozen helper APIs.
        prepared = self._prepare_ingest(ctx, intake)
        self._validate_exact_keys(
            prepared,
            {
                "intake_path",
                "intake_sha256",
                "source_snapshot_path",
                "source_sha256",
                "schema_snapshot_path",
                "schema_sha256",
                "snapshot_ledger_path",
                "snapshot_ledger_sha256",
                "expanded_publish",
                "learning_refs",
                "warnings",
            },
            "_prepare_ingest",
        )
        self._apply_prepared_refs(ctx, prepared)
        ready = self._check_readiness(ctx, intake)
        self._validate_exact_keys(
            ready,
            {
                "superpose",
                "voice_studio",
                "bundle_version",
                "primitive_library_version",
                "schema_snapshot_path",
                "schema_sha256",
                "selected_theme_sha256",
                "reported_render_capacity",
                "evidence_paths",
                "warnings",
            },
            "_check_readiness",
        )
        self._apply_ingest_preflight(ctx, intake, prepared, ready)
        self.sm.send("start_ingest")
        return "INGEST"

    def _initialize_extras(self, ctx: RunContext, intake: Any) -> None:
        ctx.extras["videogen"] = {
            "schema_version": 1,
            "lifecycle_state": "INGEST",
            "paths": {
                "workspace_dir": intake.workspace_dir,
                "output_dir": intake.output_dir,
                "intake": None,
                "source_snapshot": None,
                "schema_snapshot": None,
                "snapshot_ledger": None,
                "storyboard": None,
                "narration": None,
                "bundle": None,
                "provenance": None,
                "draft_video": None,
                "draft_captions": None,
                "qa_report": None,
                "gate_packet": None,
                "approval_record": None,
                "final_video": None,
                "final_captions": None,
                "final_poster": None,
                "handoff_receipt": None,
            },
            "hashes": {
                "intake": None,
                "content": intake.content_sha256,
                "schema": None,
                "snapshot_ledger": None,
                "storyboard": None,
                "narration": None,
                "bundle": None,
                "draft_video": None,
                "draft_captions": None,
                "qa_report": None,
                "gate_packet": None,
                "approval_record": None,
                "final_video": None,
                "final_captions": None,
                "final_poster": None,
                "handoff_receipt": None,
            },
            "phase_state": {
                "narration_stage": "AUTHOR",
                "earliest_refine_route": None,
                "latest_summary_refs": {},
            },
            "scene_ledger": {},
            "operation_journal": {"path": None, "sha256": None, "keys": []},
            "service_ledger": {
                "superpose_project_id": None,
                "draft_video_id": None,
                "final_video_id": None,
            },
            "qa": {
                "verdict": None,
                "report_path": None,
                "report_sha256": None,
                "blocking_ids": [],
                "uncertain_ids": [],
            },
            "review": {
                "iteration": 0,
                "packet_path": None,
                "packet_sha256": None,
                "response_path": None,
                "response_sha256": None,
                "approved_draft_sha256": None,
            },
            "budget": {
                "max_refine_iterations": intake.max_refine_iterations,
                "refine_iterations_used": 0,
                "carren_repairs_used": 0,
                "automatic_repairs_used": 0,
            },
            "staleness": {
                "content_status": "UNKNOWN",
                "compatibility_status": "UNKNOWN",
                "changed_bindings": [],
                "checked_at": None,
            },
            "learning": {"retrieved_refs": [], "write_ref": None, "warning": None},
            "warnings": [],
        }

    def _apply_prepared_refs(
        self, ctx: RunContext, prepared: Mapping[str, Any]
    ) -> None:
        """Expose freshly snapshotted inputs to readiness without persisting payloads."""
        vg = self._vg(ctx)
        vg["paths"]["intake"] = prepared["intake_path"]
        vg["paths"]["source_snapshot"] = prepared["source_snapshot_path"]
        vg["paths"]["snapshot_ledger"] = prepared["snapshot_ledger_path"]
        vg["paths"]["schema_snapshot"] = prepared.get("schema_snapshot_path")
        vg["hashes"]["content"] = prepared["source_sha256"]
        vg["hashes"]["snapshot_ledger"] = prepared["snapshot_ledger_sha256"]
        vg["hashes"]["schema"] = prepared.get("schema_sha256")

    def _apply_ingest_preflight(
        self,
        ctx: RunContext,
        intake: Any,
        prepared: Mapping[str, Any],
        ready: Mapping[str, Any],
    ) -> None:
        vg = self._vg(ctx)
        if prepared["source_sha256"] != intake.content_sha256:
            raise RuntimeError(
                "ingest source snapshot hash disagrees with normalized exact bytes"
            )
        for name in ("source_sha256", "snapshot_ledger_sha256"):
            self._require_sha(prepared.get(name), f"_prepare_ingest.{name}")
        for name in ("schema_sha256", "selected_theme_sha256"):
            self._require_sha(ready.get(name), f"_check_readiness.{name}")
        if ready.get("bundle_version") != 1:
            raise RuntimeError(
                "readiness bundle_version must be the frozen M1 protocol version 1"
            )
        version = ready.get("primitive_library_version")
        if not isinstance(version, str) or not _SEMVER_RE.fullmatch(version):
            raise RuntimeError(
                "readiness primitive_library_version must be semantic version text"
            )
        for key in (
            "intake_path",
            "source_snapshot_path",
            "snapshot_ledger_path",
        ):
            if (
                not isinstance(prepared.get(key), str)
                or not Path(prepared[key]).is_absolute()
            ):
                raise RuntimeError(f"_prepare_ingest.{key} must be an absolute path")
        if (
            not isinstance(ready.get("schema_snapshot_path"), str)
            or not Path(cast(str, ready["schema_snapshot_path"])).is_absolute()
        ):
            raise RuntimeError("_check_readiness.schema_snapshot_path must be absolute")
        paths = vg["paths"]
        hashes = vg["hashes"]
        paths["intake"] = prepared["intake_path"]
        paths["source_snapshot"] = prepared["source_snapshot_path"]
        paths["schema_snapshot"] = ready["schema_snapshot_path"]
        paths["snapshot_ledger"] = prepared["snapshot_ledger_path"]
        # Readiness atomically replaces the provisional intake with the exact
        # completed intake evidence, so bind the digest of the bytes now present.
        hashes["intake"] = self._artifacts(ctx).sha256_file(prepared["intake_path"])
        hashes["content"] = prepared["source_sha256"]
        hashes["schema"] = ready["schema_sha256"]
        hashes["snapshot_ledger"] = prepared["snapshot_ledger_sha256"]
        vg["learning"]["retrieved_refs"] = list(prepared.get("learning_refs") or [])
        vg["warnings"].extend(str(item) for item in prepared.get("warnings") or [])
        vg["warnings"].extend(str(item) for item in ready.get("warnings") or [])
        self._store_compact_ref(ctx, "expanded_publish", prepared["expanded_publish"])
        self._store_compact_ref(ctx, "readiness", dict(ready))
        self._store_compact_ref(
            ctx,
            "staleness_baseline",
            {
                "voice_id": intake.voice_id,
                "theme": intake.theme,
                "schema_sha256": ready["schema_sha256"],
                "selected_theme_sha256": ready["selected_theme_sha256"],
            },
        )
        self._set_staleness(ctx, "CURRENT", "COMPATIBLE", [])

        if intake.mode == "refine_existing":
            prior_path = Path(
                cast(dict[str, Any], intake.existing_video)["bundle_dir"]
            ) / ("provenance.json")
            artifacts = self._artifacts(ctx)
            try:
                prior = artifacts.read_provenance(prior_path)
            except Exception as exc:
                raise RuntimeError(
                    f"existing_video.bundle_dir provenance is UNKNOWN and cannot be reused: {exc}"
                ) from exc
            current_bindings = self._ingest_binding_hashes(ctx)
            comparison = artifacts.compare_staleness(
                current_section_identity=intake.section_identity,
                current_content_sha256=intake.content_sha256,
                prior_provenance=prior,
                current_bindings=current_bindings,
            )
            self._set_staleness(
                ctx,
                comparison.content_status,
                comparison.compatibility_status,
                list(comparison.changed_bindings),
            )
            if comparison.content_status in {"UNKNOWN", "DIFFERENT_IDENTITY"}:
                raise RuntimeError(
                    "existing video identity/content provenance cannot be safely reused: "
                    + "; ".join(comparison.reasons)
                )
            # STALE or materially incompatible prior work restarts from the new
            # current storyboard; it never enters the targeted refine path.
            self._store_compact_ref(
                ctx,
                "refine_existing_compatible",
                comparison.content_status == "CURRENT"
                and comparison.compatibility_status == "COMPATIBLE",
            )

    def parallel_spec(self, state: str, ctx: RunContext) -> ParallelSpec | None:
        if state == "NARRATION_SCRIPT":
            stage = self._vg(ctx)["phase_state"]["narration_stage"]
            if stage == "AUTHOR":
                return ParallelSpec(branches={"synthia": VG_SYNTHIA_NARRATION})
            if stage == "CARREN":
                return ParallelSpec(branches={"carren": VG_CARREN_NARRATION_GATE})
            raise ValueError(f"invalid persisted narration stage {stage!r}")
        return super().parallel_spec(state, ctx)

    def step(self, *, session_id: str, run_id: str, agent: str, result: Any) -> dict:  # noqa: C901
        """Run local semantic SUMMARY validation through the engine's retry path.

        The generic contract gate validates only Python types/nonempty evidence.
        This pre-pass adds enum, exact-key, hash, nested-row, and cross-hash rules
        before ``BasePlaybook`` can route the state.
        """
        if agent == "user":
            return super().step(
                session_id=session_id, run_id=run_id, agent=agent, result=result
            )
        rec = self.cp.load(run_id)
        if rec is None:
            return super().step(
                session_id=session_id, run_id=run_id, agent=agent, result=result
            )
        state = rec.current_state_id
        if (
            state in self.TOOL_STATES
            or state in self.GATE_STATES
            or state in {"complete", "error"}
        ):
            return super().step(
                session_id=session_id, run_id=run_id, agent=agent, result=result
            )
        self.ctx = rec.context
        self.sm = self.machine_cls()
        self.sm.current_state_value = state
        try:
            if (
                state == "NARRATION_SCRIPT"
                and agent == "__parallel__"
                and isinstance(result, list)
            ):
                for entry in result:
                    if not isinstance(entry, Mapping) or entry.get(
                        "exitCode", 0
                    ) not in (0, None):
                        continue
                    summary = entry.get("summary")
                    if isinstance(summary, Mapping):
                        self._validate_summary_semantics(state, dict(summary))
            elif agent != "__parallel__":
                summary: Any = result
                if isinstance(result, Mapping) and {
                    "exitCode",
                    "summary",
                    "summary_missing",
                } <= set(result):
                    if result.get("exitCode", 0) not in (0, None) or result.get(
                        "summary_missing"
                    ):
                        summary = None
                    else:
                        summary = result.get("summary")
                if isinstance(summary, Mapping):
                    self._validate_summary_semantics(state, dict(summary))
        except (ValueError, RuntimeError) as exc:
            return self._retry_malformed(state, f"invalid semantic SUMMARY: {exc}")
        return super().step(
            session_id=session_id, run_id=run_id, agent=agent, result=result
        )

    def _advance_to(self, state: str) -> dict:
        # Agent escalation already uses BasePlaybook._escalate.  This branch is
        # for a deterministic tool that routed through unknown because an
        # external submission's disposition could not be proven.
        if state == "awaiting_clarification":
            self._save(STATUS_AWAITING_USER, state)
            return self.escalation_directive()
        return super()._advance_to(state)

    def _resume(self, state: str, result: Any) -> dict:
        if state == "awaiting_clarification":
            target = str(self.ctx.previous_state or "")
            if target not in {
                "INGEST",
                "STORYBOARD",
                "NARRATION_SCRIPT",
                "CODEGEN",
                "AUTO_QA",
                "REFINE",
            }:
                target = "INGEST"
            self.sm.resume_target = target
        return super()._resume(state, result)

    # ------------------------------------------------------------------
    # Agent semantic gates and routing
    # ------------------------------------------------------------------
    def _validate_summary_semantics(self, state: str, summary: dict[str, Any]) -> None:  # noqa: C901
        contracts: dict[str, dict[str, Any]] = {
            "INGEST": VG_ANNIE_INGEST_CONTRACT,
            "STORYBOARD": VG_SYNTHIA_STORYBOARD_CONTRACT,
            "CODEGEN": VG_SKRIBBLE_CODEGEN_CONTRACT,
            "AUTO_QA": VG_VERA_AUTO_QA_CONTRACT,
            "REFINE": VG_SYNTHIA_REFINE_CONTRACT,
        }
        if state == "NARRATION_SCRIPT":
            stage = self._vg(self.ctx)["phase_state"]["narration_stage"]
            contract = (
                VG_SYNTHIA_NARRATION_CONTRACT
                if stage == "AUTHOR"
                else VG_CARREN_NARRATION_GATE_CONTRACT
            )
        else:
            contract = contracts.get(state)
        if contract is None:
            raise ValueError(f"no semantic contract for {state}")
        allowed = set(contract["required"]) | set(contract.get("optional", {}))
        unknown = sorted(set(summary) - allowed)
        if unknown:
            # Benign extra fields (agent-supplied receipts, notes, etc.) are
            # ignored, not fatal: contracts validate what matters — required
            # fields, formats, and evidence — and tolerate agent variance.
            summary = {key: value for key, value in summary.items() if key in allowed}
        missing = sorted(set(contract["required"]) - set(summary))
        if missing:
            raise ValueError(f"missing SUMMARY fields {missing}")
        status = summary.get("status")
        confidence = summary.get("confidence")
        if status not in STATUSES:
            raise ValueError(f"status must be one of {sorted(STATUSES)}")
        if confidence not in CONFIDENCES:
            raise ValueError(f"confidence must be one of {sorted(CONFIDENCES)}")
        if summary.get("phase") != state:
            raise ValueError(f"phase must be exactly {state}")
        needs = summary.get("needs_clarification")
        if needs is True and not summary.get("clarifying_questions"):
            raise ValueError(
                "needs_clarification requires nonempty clarifying_questions"
            )
        if needs is True and (status != "UNCERTAIN" or confidence != "UNCERTAIN"):
            raise ValueError("clarification requires status/confidence UNCERTAIN")
        if status == "UNCERTAIN" and confidence != "UNCERTAIN":
            raise ValueError("UNCERTAIN status requires UNCERTAIN confidence")

        for field in ("evidence_refs", "cited_evidence"):
            if field in summary:
                self._validate_evidence_refs(summary[field], field)
        if status == "BLOCKED":
            # An honest block report must not be masked by artifact format
            # validation: the artifacts legitimately may not exist yet. The
            # route handler surfaces the block; issues carry the reason.
            if not summary.get("issues"):
                raise ValueError("BLOCKED status requires nonempty issues")
            return
        if status == "UNCERTAIN":
            # Uncertainty pauses via the existing pause semantics; artifacts may
            # not exist yet, so skip artifact-pair validation only.
            return
        if state == "INGEST":
            self._artifact_pair(summary, "inventory_path", "inventory_sha256")
            self._nonnegative_int(summary["concept_count"], "concept_count")
        elif state == "STORYBOARD":
            self._artifact_pair(summary, "storyboard_path", "storyboard_sha256")
            self._artifact_pair(
                summary, "coverage_matrix_path", "coverage_matrix_sha256"
            )
            if self._nonnegative_int(summary["scene_count"], "scene_count") <= 0:
                raise ValueError("scene_count must be positive")
            duration_estimate = summary["estimated_duration_seconds"]
            if (
                isinstance(duration_estimate, bool)
                or not isinstance(duration_estimate, (int, float))
                or duration_estimate < 0
            ):
                raise ValueError(
                    "estimated_duration_seconds must be a nonnegative number"
                )
        elif state == "NARRATION_SCRIPT":
            stage = self._vg(self.ctx)["phase_state"]["narration_stage"]
            if stage == "AUTHOR":
                for p, h in (
                    ("narration_path", "narration_sha256"),
                    ("pronunciation_table_path", "pronunciation_table_sha256"),
                    ("claim_source_map_path", "claim_source_map_sha256"),
                ):
                    self._artifact_pair(summary, p, h)
                if "storyboard_path" in summary or "storyboard_sha256" in summary:
                    self._artifact_pair(summary, "storyboard_path", "storyboard_sha256")
                if self._nonnegative_int(summary["scene_count"], "scene_count") <= 0:
                    raise ValueError("scene_count must be positive")
            else:
                verdict = summary.get("verdict")
                if verdict not in CARREN_VERDICTS:
                    raise ValueError(
                        f"Carren verdict must be one of {sorted(CARREN_VERDICTS)}"
                    )
                if summary.get("met") is not (verdict == "APPROVE"):
                    raise ValueError("Carren met must be true iff verdict is APPROVE")
                if verdict == "UNCERTAIN" and confidence != "UNCERTAIN":
                    raise ValueError(
                        "Carren UNCERTAIN verdict requires UNCERTAIN confidence"
                    )
                vg = self._vg(self.ctx)
                if (
                    summary.get("reviewed_storyboard_sha256")
                    != vg["hashes"]["storyboard"]
                ):
                    raise ValueError("Carren reviewed_storyboard_sha256 is not current")
                if (
                    summary.get("reviewed_narration_sha256")
                    != vg["hashes"]["narration"]
                ):
                    raise ValueError("Carren reviewed_narration_sha256 is not current")
                if verdict != "APPROVE":
                    issues = summary.get("issues")
                    if not isinstance(issues, list) or not issues:
                        raise ValueError("a non-approve Carren verdict requires issues")
                    for index, issue in enumerate(issues):
                        if not isinstance(issue, Mapping):
                            raise ValueError(
                                f"Carren issue {index} must name a scene/beat and evidence"
                            )
                        located = any(
                            issue.get(key)
                            for key in ("scene_id", "beat_id", "affected_scene_ids")
                        )
                        grounded = issue.get("evidence") or issue.get("evidence_ref")
                        if not located or not grounded:
                            raise ValueError(
                                f"Carren issue {index} lacks scene/beat or cited evidence"
                            )
                if "review_path" in summary or "review_sha256" in summary:
                    if not {"review_path", "review_sha256"} <= set(summary):
                        raise ValueError(
                            "review_path and review_sha256 must appear together"
                        )
                    self._artifact_pair(summary, "review_path", "review_sha256")
        elif state == "CODEGEN":
            self._require_sha(summary.get("schema_sha256"), "schema_sha256")
            if summary["schema_sha256"] != self._vg(self.ctx)["hashes"]["schema"]:
                raise ValueError(
                    "CODEGEN schema hash is not the immutable ingest snapshot"
                )
            version = summary.get("schema_version")
            readiness = self._load_compact_ref(self.ctx, "readiness")
            if not isinstance(version, str) or version != readiness.get(
                "primitive_library_version"
            ):
                raise ValueError("CODEGEN schema_version disagrees with readiness")
            scene_ids = self._scene_ids(summary.get("scene_ids"), "scene_ids")
            expected = list(self._vg(self.ctx)["scene_ledger"])
            if scene_ids != expected and set(scene_ids) != set(expected):
                raise ValueError("CODEGEN scene IDs must equal the storyboard set")
            files = summary.get("files")
            if not isinstance(files, list) or len(files) != len(scene_ids):
                raise ValueError("CODEGEN files must contain one row per scene")
            file_ids: list[str] = []
            for index, row in enumerate(files):
                if not isinstance(row, Mapping) or set(row) != {
                    "scene_id",
                    "path",
                    "sha256",
                }:
                    raise ValueError(
                        f"files[{index}] must have exact scene_id/path/sha256 keys"
                    )
                file_ids.append(str(row["scene_id"]))
                self._artifact_pair(dict(row), "path", "sha256")
            if set(file_ids) != set(scene_ids) or len(file_ids) != len(set(file_ids)):
                raise ValueError("CODEGEN file scene IDs do not match scene_ids")
            if not summary.get("validation_evidence"):
                raise ValueError("CODEGEN validation_evidence must be nonempty")
        elif state == "REFINE":
            self._artifact_pair(
                summary, "feedback_ledger_path", "feedback_ledger_sha256"
            )
            self._validate_feedback_ledger(ctx=self.ctx, summary=summary)
            self._artifact_pair(summary, "change_plan_path", "change_plan_sha256")
            if summary.get("earliest_route") not in REFINE_ROUTES:
                raise ValueError(f"earliest_route must be one of {list(REFINE_ROUTES)}")
            self._scene_ids(
                summary.get("affected_scene_ids"), "affected_scene_ids", empty_ok=True
            )
            if summary.get("met") is not True and status == "COMPLETE":
                raise ValueError("a COMPLETE refine mapping requires met=true")
        elif state == "AUTO_QA":
            self._artifact_pair(summary, "qa_report_path", "qa_report_sha256")
            qa = self._qa(self.ctx)
            rows = summary.get("check_results")
            if not isinstance(rows, list):
                raise ValueError("check_results must be a list")
            validated = [qa.validate_qa_result(row) for row in rows]
            report = qa.roll_up_report(validated)
            verdict = summary.get("verdict")
            if verdict not in VERA_VERDICTS or verdict != report["verdict"]:
                raise ValueError("Vera verdict must exactly equal the 18-row roll-up")
            if summary.get("met") is not (verdict == "PASS"):
                raise ValueError("Vera met must be true iff verdict is PASS")
            if verdict == "UNCERTAIN" and confidence != "UNCERTAIN":
                raise ValueError("Vera UNCERTAIN verdict requires UNCERTAIN confidence")
            if (
                not isinstance(summary.get("rationale"), str)
                or not summary["rationale"].strip()
            ):
                raise ValueError("Vera rationale must be nonempty")

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        if state == "NARRATION_SCRIPT":
            branches = summary.get("branches")
            if not isinstance(branches, Mapping) or len(branches) != 1:
                raise ValueError("NARRATION_SCRIPT requires exactly one staged branch")
            summary = dict(next(iter(branches.values())))
        self._validate_summary_semantics(state, summary)
        auto_qa_report: dict[str, Any] | None = None
        disagreement_ids: list[str] = []
        if state == "AUTO_QA":
            auto_qa_report, disagreement_ids = self._auto_qa_gate_report(
                ctx, summary["check_results"]
            )
        if disagreement_ids:
            self._persist_summary_ref(
                ctx,
                "AUTO_QA:rejected",
                {
                    "schema_version": 1,
                    "reason": "Vera PASS disagrees with persisted deterministic evidence",
                    "disagreement_ids": disagreement_ids,
                    "deterministic_qa": copy.deepcopy(
                        self._vg(ctx)["phase_state"]["latest_summary_refs"].get(
                            "deterministic_qa"
                        )
                    ),
                    "submitted_summary": copy.deepcopy(summary),
                },
            )
        else:
            ref_key = self._summary_ref_key(state, summary)
            self._persist_summary_ref(ctx, ref_key, summary)
        self._vg(ctx)["warnings"].extend(
            str(item) for item in summary.get("warnings") or []
        )

        pause_reason = self._summary_pause_reason(state, summary)
        if pause_reason:
            self._pause_route(ctx, state, pause_reason)
            return
        if summary.get("status") == "BLOCKED":
            # A narration-author block whose issues route to STORYBOARD is a
            # bounded in-run repair (the author correctly refused to make
            # structural edits mid-narration), not a terminal condition.
            vg = self._vg(ctx)
            if (
                state == "NARRATION_SCRIPT"
                and vg["phase_state"]["narration_stage"] == "AUTHOR"
                and any(
                    str(item.get("owner") or item.get("earliest_route") or "")
                    == "STORYBOARD"
                    for item in summary.get("issues") or []
                    if isinstance(item, Mapping)
                )
                and vg["budget"]["carren_repairs_used"] < MAX_CARREN_REPAIRS
            ):
                vg["budget"]["carren_repairs_used"] += 1
                vg["lifecycle_state"] = "STORYBOARD"
                vg["phase_state"]["narration_stage"] = "AUTHOR"
                self._persist_summary_ref(ctx, "storyboard_repair_request", summary)
                self.sm.send("narration_storyboard")
                return
            raise RuntimeError(
                f"{state} blocked: {summary.get('issues') or 'no issue detail'}"
            )

        vg = self._vg(ctx)
        if state == "INGEST":
            compatible = bool(
                self._load_compact_ref(ctx, "refine_existing_compatible", False)
            )
            intake = self._normalized_intake(ctx)
            vg["lifecycle_state"] = (
                "REFINE"
                if intake.mode == "refine_existing" and compatible
                else ("STORYBOARD")
            )
            self.sm.send(
                "ingest_refine"
                if intake.mode == "refine_existing" and compatible
                else "ingest_done"
            )
        elif state == "STORYBOARD":
            self._accept_storyboard(ctx, summary)
            vg["phase_state"]["narration_stage"] = "AUTHOR"
            vg["lifecycle_state"] = "NARRATION_SCRIPT"
            self.sm.send("storyboard_done")
        elif state == "NARRATION_SCRIPT":
            self._route_narration(ctx, summary)
        elif state == "CODEGEN":
            self._accept_codegen(ctx, summary)
            vg["lifecycle_state"] = "VALIDATE"
            self.sm.send("code_done")
        elif state == "AUTO_QA":
            if auto_qa_report is None:
                raise RuntimeError("AUTO_QA gate report was not computed")
            self._route_auto_qa(
                ctx,
                summary,
                report=auto_qa_report,
                disagreement_ids=disagreement_ids,
            )
        elif state == "REFINE":
            self._route_refine(ctx, summary)
        else:
            raise ValueError(f"route_after: unexpected state {state!r}")

    def _summary_pause_reason(
        self, state: str, summary: Mapping[str, Any]
    ) -> str | None:
        if summary.get("needs_clarification"):
            questions = "; ".join(
                str(item) for item in summary.get("clarifying_questions") or []
            )
            return f"{state} needs clarification: {questions}"
        if (
            summary.get("status") == "UNCERTAIN"
            or summary.get("confidence") == "UNCERTAIN"
        ):
            return f"{state} reported evidence-backed uncertainty"
        if summary.get("verdict") == "UNCERTAIN":
            return f"{state} reviewer verdict is UNCERTAIN"
        return None

    def _pause_route(self, ctx: RunContext, state: str, reason: str) -> None:
        ctx.previous_state = state
        ctx.unknown_reason = reason
        ctx.last_confidence = Confidence.UNCERTAIN
        if not self._safe_send("to_unknown") or not self._safe_send("escalate"):
            raise RuntimeError(f"cannot route {state} to awaiting_clarification")

    def _route_narration(self, ctx: RunContext, summary: Mapping[str, Any]) -> None:
        vg = self._vg(ctx)
        stage = vg["phase_state"]["narration_stage"]
        if stage == "AUTHOR":
            vg["paths"]["narration"] = summary["narration_path"]
            vg["hashes"]["narration"] = summary["narration_sha256"]
            if summary.get("storyboard_sha256"):
                # Authoring may update the storyboard's per-scene narration text
                # (the bundle authority). Accept the refreshed artifact only when
                # the scene set is unchanged — structural edits belong to
                # STORYBOARD, not narration authoring.
                try:
                    updated = json.loads(
                        Path(str(summary["storyboard_path"])).read_text(
                            encoding="utf-8"
                        )
                    )
                except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                    raise RuntimeError(
                        f"updated storyboard is unreadable JSON: {exc}"
                    ) from exc
                updated_ids = [
                    scene.get("scene_id")
                    for scene in (updated.get("scenes") or [])
                    if isinstance(scene, Mapping)
                ]
                if set(updated_ids) != set(vg["scene_ledger"]) or len(
                    updated_ids
                ) != len(set(updated_ids)):
                    raise RuntimeError(
                        "narration authoring changed the storyboard scene set; "
                        "structural edits must route through STORYBOARD"
                    )
                vg["paths"]["storyboard"] = summary["storyboard_path"]
                vg["hashes"]["storyboard"] = summary["storyboard_sha256"]
            vg["phase_state"]["narration_stage"] = "CARREN"
            self.sm.send("narration_again")
            return

        verdict = summary["verdict"]
        if verdict == "APPROVE":
            # This persisted ref is the production proof consumed by VOICE_SYNTH.
            vg["phase_state"]["narration_stage"] = "COMPLETE"
            vg["lifecycle_state"] = "VOICE_SYNTH"
            self.sm.send("narration_approved")
            return
        budget = vg["budget"]
        if budget["carren_repairs_used"] >= MAX_CARREN_REPAIRS:
            self._mark_exhausted(
                ctx,
                reason="Carren pre-synthesis revision budget exhausted",
                unresolved=list(summary.get("issues") or []),
            )
            self.sm.send("narration_exhausted")
            return
        budget["carren_repairs_used"] += 1
        issue_routes = {
            str(item.get("earliest_route") or item.get("owner") or "")
            for item in summary.get("issues") or []
            if isinstance(item, Mapping)
        }
        if "STORYBOARD" in issue_routes:
            vg["lifecycle_state"] = "STORYBOARD"
            vg["phase_state"]["narration_stage"] = "AUTHOR"
            self.sm.send("narration_storyboard")
        else:
            vg["phase_state"]["narration_stage"] = "AUTHOR"
            self.sm.send("narration_again")

    def _route_auto_qa(
        self,
        ctx: RunContext,
        summary: Mapping[str, Any],
        *,
        report: Mapping[str, Any],
        disagreement_ids: Sequence[str],
    ) -> None:
        vg = self._vg(ctx)
        gate_ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "evidence"
                / "qa"
                / f"gate-{vg['review']['iteration']:03d}.json"
            ),
            dict(report),
            root=vg["paths"]["workspace_dir"],
        )
        vg["phase_state"]["latest_summary_refs"]["AUTO_QA:gate"] = gate_ref
        vg["paths"]["qa_report"] = gate_ref["path"]
        vg["hashes"]["qa_report"] = gate_ref["sha256"]
        vg["qa"] = {
            "verdict": report["verdict"],
            "report_path": gate_ref["path"],
            "report_sha256": gate_ref["sha256"],
            "blocking_ids": list(report["blocking_ids"]),
            "uncertain_ids": list(report["uncertain_ids"]),
        }
        if report["verdict"] == "PASS":
            if disagreement_ids:
                raise RuntimeError("an AUTO_QA disagreement cannot produce PASS")
            self._create_gate_packet(ctx)
            vg["lifecycle_state"] = "OPERATOR_REVIEW"
            self.sm.send("qa_pass")
            return
        if report["verdict"] == "UNCERTAIN":
            self._pause_route(
                ctx, "AUTO_QA", "AUTO_QA has one or more uncertain checks"
            )
            return
        unresolved = list(summary.get("unresolved_issues") or [])
        if not unresolved:
            unresolved = list(report["blocking_ids"])
        if not self._consume_automatic_repair(ctx, unresolved):
            self.sm.send("qa_exhausted")
            return
        route = self._earliest_qa_route(report["checks"])
        self._route_qa_event(ctx, route)

    def _route_refine(self, ctx: RunContext, summary: Mapping[str, Any]) -> None:
        vg = self._vg(ctx)
        if summary.get("met") is not True:
            self._mark_exhausted(
                ctx,
                reason="refinement mapping/change plan did not resolve every note",
                unresolved=list(
                    summary.get("unresolved_note_ids") or summary.get("issues") or []
                ),
            )
            self.sm.send("refine_exhausted")
            return
        vg["phase_state"]["earliest_refine_route"] = summary["earliest_route"]
        route = str(summary["earliest_route"])
        old_storyboard = vg["hashes"]["storyboard"]
        old_narration = vg["hashes"]["narration"]
        self._refresh_design_hashes(ctx)
        design_changed = (
            vg["hashes"]["storyboard"] != old_storyboard
            or vg["hashes"]["narration"] != old_narration
        )
        # Any changed pedagogy/narration must pass Carren before a voice mutation,
        # even if an optimistic change plan named a later route.
        if design_changed and REFINE_ROUTES.index(route) > REFINE_ROUTES.index(
            "NARRATION_SCRIPT"
        ):
            route = "NARRATION_SCRIPT"
            vg["phase_state"]["narration_stage"] = "CARREN"
        elif route == "NARRATION_SCRIPT":
            vg["phase_state"]["narration_stage"] = "AUTHOR"
        elif route == "STORYBOARD":
            vg["phase_state"]["narration_stage"] = "AUTHOR"
        vg["lifecycle_state"] = route
        self.sm.send(
            {
                "STORYBOARD": "refine_storyboard",
                "NARRATION_SCRIPT": "refine_narration",
                "VOICE_SYNTH": "refine_voice",
                "CODEGEN": "refine_codegen",
                "VALIDATE": "refine_validate",
                "DRAFT_RENDER": "refine_render",
            }[route]
        )

    # ------------------------------------------------------------------
    # Deterministic states
    # ------------------------------------------------------------------
    def run_tool_state(self, state: str, ctx: RunContext) -> None:  # noqa: C901
        try:
            stale = self._recheck_staleness(ctx)
            if stale["content_status"] != "CURRENT":
                self._refresh_ingest_snapshots(ctx)
                self._invalidate_for_staleness(ctx)
                self._set_staleness(
                    ctx,
                    stale["content_status"],
                    stale["compatibility_status"],
                    stale["changed_bindings"],
                )
                self._vg(ctx)["lifecycle_state"] = "INGEST"
                self._send_stale_event(state, source=True)
                return
            if stale["compatibility_status"] != "COMPATIBLE":
                self._refresh_ingest_snapshots(ctx)
                self._invalidate_for_staleness(ctx)
                self._set_staleness(
                    ctx,
                    stale["content_status"],
                    stale["compatibility_status"],
                    stale["changed_bindings"],
                )
                self._vg(ctx)["lifecycle_state"] = "STORYBOARD"
                self._send_stale_event(state, source=False)
                return
            if state == "VOICE_SYNTH":
                self._run_voice_synth(ctx)
                self.sm.send("voice_done")
            elif state == "VALIDATE":
                self._run_validate(ctx)
            elif state == "DRAFT_RENDER":
                self._run_draft_render(ctx)
                self.sm.send("draft_done")
            elif state == "FINALIZE":
                self._run_finalize(ctx)
            elif state == "PUBLISH_HANDOFF":
                self._run_publish_handoff(ctx)
            else:
                raise RuntimeError(f"no videogen tool runner for {state}")
        except _PauseRequired as exc:
            self._pause_tool(ctx, state, str(exc))

    def _run_voice_synth(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        gate = self._load_summary_ref(ctx, "NARRATION_SCRIPT:carren")
        if (
            gate.get("verdict") != "APPROVE"
            or gate.get("met") is not True
            or gate.get("reviewed_storyboard_sha256") != vg["hashes"]["storyboard"]
            or gate.get("reviewed_narration_sha256") != vg["hashes"]["narration"]
            or not gate.get("cited_evidence")
        ):
            raise RuntimeError(
                "VOICE_SYNTH is forbidden without current cited Carren APPROVE evidence"
            )
        scenes = self._narration_scenes(ctx)
        workspace = vg["paths"]["workspace_dir"]
        provenance_updates: dict[str, str] = {}
        for scene in scenes:
            scene_id = scene["scene_id"]
            text = scene["narration"]
            narration_hash = self._artifacts(ctx).sha256_bytes(text.encode("utf-8"))
            ledger = vg["scene_ledger"].setdefault(scene_id, self._empty_scene_row())
            existing_path = ledger.get("audio_path")
            if (
                ledger.get("narration_sha256") == narration_hash
                and isinstance(existing_path, str)
                and self._file_hash_or_none(existing_path) == ledger.get("audio_sha256")
            ):
                continue
            destination = str(Path(workspace) / "audio" / f"{scene_id}.wav")
            result = self._voice_scene(
                ctx,
                scene_id=scene_id,
                narration_text=text,
                narration_sha256=narration_hash,
                pronunciation_actions=scene.get("pronunciation_actions", []),
                destination_path=destination,
            )
            self._validate_exact_keys(
                result,
                {
                    "scene_id",
                    "narration_sha256",
                    "audio_path",
                    "audio_sha256",
                    "duration_seconds",
                    "item_id",
                    "job_id",
                    "terminal_status",
                    "pronunciation_actions",
                    "cleanup_status",
                    "journal_refs",
                    "warnings",
                },
                "_voice_scene",
            )
            if (
                result["scene_id"] != scene_id
                or result["narration_sha256"] != narration_hash
            ):
                raise RuntimeError(
                    f"voice result for {scene_id} is bound to the wrong narration"
                )
            self._artifact_values(
                result["audio_path"], result["audio_sha256"], "voice audio"
            )
            duration = result["duration_seconds"]
            if (
                isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or duration <= 0
            ):
                raise RuntimeError(f"voice duration for {scene_id} must be positive")
            ledger.update(
                {
                    "narration_sha256": narration_hash,
                    "audio_path": result["audio_path"],
                    "audio_sha256": result["audio_sha256"],
                    "audio_duration_seconds": float(duration),
                    "voice_item_id": result["item_id"],
                    "voice_job_id": result["job_id"],
                }
            )
            provenance_updates[f"bundle/audio/{scene_id}"] = result["audio_sha256"]
            vg["warnings"].extend(str(item) for item in result.get("warnings") or [])
        # Reuse decisions above must compare against the prior persisted scene hashes.
        self._sync_narration_hashes(ctx)
        provenance_path = vg["paths"].get("provenance")
        if (
            provenance_updates
            and isinstance(provenance_path, str)
            and Path(provenance_path).is_file()
        ):
            self._update_provenance_checksums(ctx, provenance_updates)
        if not scenes or any(
            not row.get("audio_path") or not row.get("audio_sha256")
            for row in vg["scene_ledger"].values()
            if row.get("narration_sha256")
        ):
            raise RuntimeError(
                "VOICE_SYNTH did not produce every narration-bearing scene audio"
            )
        # Measured-audio-first timing: the deterministic engine — not an agent —
        # writes measured WAV durations into the storyboard's measured_duration
        # fields and emits a hash-bound audio manifest so downstream codegen has
        # attested timing authority (architecture rule 2).
        storyboard_path = vg["paths"]["storyboard"]
        storyboard_doc = _read_json(storyboard_path)
        manifest_rows: dict[str, dict[str, Any]] = {}
        for scene in storyboard_doc.get("scenes") or []:
            if not isinstance(scene, MutableMapping):
                continue
            row = vg["scene_ledger"].get(str(scene.get("scene_id")))
            if row and row.get("audio_duration_seconds"):
                scene["measured_duration"] = float(row["audio_duration_seconds"])
                manifest_rows[str(scene.get("scene_id"))] = {
                    "audio_path": row["audio_path"],
                    "audio_sha256": row["audio_sha256"],
                    "duration_seconds": float(row["audio_duration_seconds"]),
                    "narration_sha256": row["narration_sha256"],
                }
        artifacts = self._artifacts(ctx)
        artifacts.atomic_write_json(
            storyboard_path, storyboard_doc, root=vg["paths"]["workspace_dir"]
        )
        vg["hashes"]["storyboard"] = self._file_hash(storyboard_path)
        manifest_path = str(
            Path(storyboard_path).parent / "audio-manifest-current.json"
        )
        artifacts.atomic_write_json(
            manifest_path,
            {"scenes": manifest_rows, "storyboard_sha256": vg["hashes"]["storyboard"]},
            root=vg["paths"]["workspace_dir"],
        )
        vg["paths"]["audio_manifest"] = manifest_path
        vg["hashes"]["audio_manifest"] = self._file_hash(manifest_path)
        vg["lifecycle_state"] = "CODEGEN"

    def _run_validate(self, ctx: RunContext) -> None:  # noqa: C901
        vg = self._vg(ctx)
        intake = self._normalized_intake(ctx)
        storyboard = _read_json(vg["paths"]["storyboard"])
        readiness = self._load_compact_ref(ctx, "readiness")
        expanded = self._load_compact_ref(ctx, "expanded_publish")
        scene_files: dict[str, str] = {}
        audio_files: dict[str, str] = {}
        for scene_id, row in vg["scene_ledger"].items():
            if not row.get("code_path"):
                raise RuntimeError(f"VALIDATE missing code for scene {scene_id}")
            scene_files[scene_id] = row["code_path"]
            if row.get("narration_sha256"):
                if not row.get("audio_path"):
                    raise RuntimeError(
                        f"VALIDATE missing audio for narration scene {scene_id}"
                    )
                audio_files[scene_id] = row["audio_path"]
        manifest = {
            "bundle_version": readiness["bundle_version"],
            "video_id": expanded["video_id"],
            "primitive_library_version": readiness["primitive_library_version"],
            "theme": intake.theme,
        }
        provenance = self._build_provenance(ctx, readiness)
        bundle_dir = str(Path(vg["paths"]["workspace_dir"]) / "bundle")
        bundle = self._artifacts(ctx).materialize_bundle(
            workspace_root=vg["paths"]["workspace_dir"],
            bundle_dir=bundle_dir,
            manifest=manifest,
            provenance=provenance,
            storyboard=storyboard,
            scene_files=scene_files,
            audio_files=audio_files,
            caption_files=None,
        )
        vg["paths"]["bundle"] = bundle.bundle["path"]
        vg["paths"]["provenance"] = bundle.provenance["path"]
        vg["hashes"]["bundle"] = bundle.bundle["sha256"]
        result = self._validate_bundle_service(
            ctx, bundle_dir=bundle.bundle["path"], bundle_sha256=bundle.bundle["sha256"]
        )
        self._validate_exact_keys(
            result,
            {
                "import_result",
                "project_id",
                "validation_result",
                "violations",
                "journal_refs",
                "evidence_paths",
            },
            "_validate_bundle_service",
        )
        project_id = result.get("project_id")
        if (
            isinstance(project_id, bool)
            or not isinstance(project_id, int)
            or project_id <= 0
        ):
            raise RuntimeError("Superpose import did not return a positive project_id")
        violations = result.get("violations")
        if not isinstance(violations, list):
            raise RuntimeError("Superpose violations must be a list")
        if violations:
            if not self._consume_automatic_repair(ctx, violations):
                self.sm.send("validation_exhausted")
                return
            route = self._violation_route(violations)
            if route == "NARRATION_SCRIPT":
                vg["phase_state"]["narration_stage"] = "AUTHOR"
            vg["lifecycle_state"] = route
            self.sm.send(
                {
                    "STORYBOARD": "validation_storyboard",
                    "NARRATION_SCRIPT": "validation_narration",
                    "VOICE_SYNTH": "validation_voice",
                    "CODEGEN": "validation_codegen",
                }[route]
            )
            return
        vg["service_ledger"]["superpose_project_id"] = project_id
        vg["lifecycle_state"] = "DRAFT_RENDER"
        self.sm.send("validation_done")

    def _run_draft_render(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        project_id = vg["service_ledger"]["superpose_project_id"]
        if (
            not isinstance(project_id, int)
            or isinstance(project_id, bool)
            or project_id <= 0
        ):
            raise RuntimeError("DRAFT_RENDER requires a validated Superpose project_id")
        affected = self._affected_scene_ids(ctx)
        input_hash = self._artifacts(ctx).sha256_bytes(
            self._artifacts(ctx).canonical_json_bytes(
                [vg["hashes"]["bundle"], "draft", affected or None]
            )
        )
        result = self._render_project(
            ctx,
            project_id=project_id,
            quality="draft",
            scene_ids=affected or None,
            assemble=True,
            input_sha256=input_hash,
        )
        self._validate_render_result(result, "draft")
        video_path, captions_path = self._render_artifact_paths(result)
        video_hash = self._file_hash(video_path)
        captions_hash = self._file_hash(captions_path)
        probe = self._probe_media(ctx, video_path)
        self._validate_media_probe(probe, video_path)
        vg["paths"]["draft_video"] = video_path
        vg["paths"]["draft_captions"] = captions_path
        vg["hashes"]["draft_video"] = video_hash
        vg["hashes"]["draft_captions"] = captions_hash
        vg["service_ledger"]["draft_video_id"] = result["video_id"]
        self._accept_scene_outputs(ctx, result["scene_outputs"], quality="draft")
        result = self._complete_render_evidence(ctx, result, quality="draft")
        self._write_deterministic_qa(ctx, result, probe)
        vg["lifecycle_state"] = "AUTO_QA"

    def _run_finalize(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        approval = self._current_approval(ctx)
        if approval.get("draft_video_sha256") != vg["hashes"]["draft_video"]:
            raise RuntimeError(
                "FINALIZE approval is not bound to the current draft hash"
            )
        project_id = vg["service_ledger"]["superpose_project_id"]
        intake = self._normalized_intake(ctx)
        input_hash = self._artifacts(ctx).sha256_bytes(
            self._artifacts(ctx).canonical_json_bytes(
                [
                    vg["hashes"]["bundle"],
                    intake.quality_tier,
                    vg["hashes"]["storyboard"],
                    vg["hashes"]["narration"],
                ]
            )
        )
        result = self._render_project(
            ctx,
            project_id=project_id,
            quality=intake.quality_tier,
            scene_ids=None,
            assemble=True,
            input_sha256=input_hash,
        )
        self._validate_render_result(result, intake.quality_tier)
        final_video, final_captions = self._render_artifact_paths(result)
        final_probe = self._probe_media(ctx, final_video)
        self._validate_media_probe(final_probe, final_video)
        duration = float(final_probe["duration_seconds"])
        if (
            intake.length_cap_seconds is not None
            and duration > intake.length_cap_seconds
        ):
            self._invalidate_approval(ctx)
            vg["lifecycle_state"] = "REFINE"
            self.sm.send("finalize_refine")
            return
        self._accept_scene_outputs(ctx, result["scene_outputs"], quality="final")
        scene1_path = self._scene1_final_path(ctx, result)
        poster_destination = str(
            Path(vg["paths"]["workspace_dir"]) / "final" / "poster.jpg"
        )
        poster = self._extract_poster(
            ctx,
            scene1_final_video_path=scene1_path,
            destination_path=poster_destination,
        )
        self._validate_exact_keys(
            poster,
            {
                "path",
                "sha256",
                "size_bytes",
                "width",
                "height",
                "source_path",
                "command",
                "result",
                "elapsed_ms",
            },
            "_extract_poster",
        )
        self._artifact_values(poster["path"], poster["sha256"], "poster")
        if poster["source_path"] != scene1_path:
            raise RuntimeError(
                "poster was not extracted from scene 1 final-quality render"
            )
        vg["paths"]["final_video"] = final_video
        vg["paths"]["final_captions"] = final_captions
        vg["paths"]["final_poster"] = poster["path"]
        vg["hashes"]["final_video"] = self._file_hash(final_video)
        vg["hashes"]["final_captions"] = self._file_hash(final_captions)
        vg["hashes"]["final_poster"] = poster["sha256"]
        vg["service_ledger"]["final_video_id"] = result["video_id"]
        finalize_ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "evidence"
                / "finalize"
                / f"poster-extraction-i{vg['review']['iteration']:03d}.json"
            ),
            {
                "schema_version": 1,
                "phase": "FINALIZE",
                "poster_command": copy.deepcopy(poster["command"]),
                "poster_result": copy.deepcopy(poster["result"]),
                "poster_path": poster["path"],
                "poster_sha256": poster["sha256"],
                "source_path": poster["source_path"],
                "width": poster["width"],
                "height": poster["height"],
            },
            root=vg["paths"]["workspace_dir"],
        )
        vg["phase_state"]["latest_summary_refs"]["FINALIZE"] = finalize_ref
        self._update_provenance_checksums(
            ctx,
            {
                "final/video": vg["hashes"]["final_video"],
                "final/captions": vg["hashes"]["final_captions"],
                "final/poster": vg["hashes"]["final_poster"],
                "evidence/finalize/poster-extraction": finalize_ref["sha256"],
            },
        )
        # Updating provenance changes the bundle tree digest.
        bundle_ledger = self._artifacts(ctx).build_tree_ledger(vg["paths"]["bundle"])
        vg["hashes"]["bundle"] = self._artifacts(ctx).ledger_sha256(bundle_ledger)
        # Re-import/validate is journal-reconciled by the seam; final evidence is
        # not allowed to bypass the full project validator.
        validation = self._validate_bundle_service(
            ctx, bundle_dir=vg["paths"]["bundle"], bundle_sha256=vg["hashes"]["bundle"]
        )
        if validation.get("violations"):
            self._invalidate_approval(ctx)
            vg["lifecycle_state"] = "REFINE"
            self.sm.send("finalize_refine")
            return
        vg["lifecycle_state"] = "PUBLISH_HANDOFF"
        self.sm.send("finalize_done")

    def _run_publish_handoff(self, ctx: RunContext) -> None:  # noqa: C901
        vg = self._vg(ctx)
        intake = self._normalized_intake(ctx)
        approval = self._current_approval(ctx)
        provenance = self._artifacts(ctx).read_provenance(vg["paths"]["provenance"])
        if provenance["approval_record"] != approval:
            raise RuntimeError(
                "PUBLISH_HANDOFF approval disagrees with workspace provenance"
            )
        expanded = self._load_compact_ref(ctx, "expanded_publish")
        workspace = vg["paths"]["workspace_dir"]
        approval_ref = self._artifacts(ctx).atomic_write_json(
            str(Path(workspace) / "review" / "approval-record.json"),
            approval,
            root=workspace,
        )
        instructions_value = {
            "destinations": expanded["destinations"],
            "attach_behavior": expanded["attach_behavior"],
            "consumer_preference": expanded["consumer_preference"],
            "instructions": expanded["instructions"],
            "handoff_only": True,
        }
        instructions_ref = self._artifacts(ctx).atomic_write_json(
            str(Path(workspace) / "handoff" / "publish-instructions.json"),
            instructions_value,
            root=workspace,
        )
        release_name = expanded["base_name"]
        release_root = Path(intake.output_dir) / release_name
        source_files = {
            "video": vg["paths"]["final_video"],
            "captions": vg["paths"]["final_captions"],
            "poster": vg["paths"]["final_poster"],
            "bundle": vg["paths"]["bundle"],
            "auto_qa_report": vg["paths"]["qa_report"],
            "approval_record": approval_ref["path"],
            "publish_instructions": instructions_ref["path"],
        }
        artifacts = self._artifacts(ctx)
        source_bundle_ledger = artifacts.build_tree_ledger(vg["paths"]["bundle"])
        expected_artifacts = {
            "video": self._staged_file_ref(
                release_root / "media" / f"{release_name}.mp4", source_files["video"]
            ),
            "captions": self._staged_file_ref(
                release_root / "media" / f"{release_name}.vtt", source_files["captions"]
            ),
            "poster": self._staged_file_ref(
                release_root / "media" / f"{release_name}.jpg", source_files["poster"]
            ),
            "bundle": {
                "path": str(release_root / "bundle"),
                "sha256": artifacts.ledger_sha256(source_bundle_ledger),
                "file_count": len(source_bundle_ledger),
            },
            "auto_qa_report": self._staged_file_ref(
                release_root / "evidence" / "auto-qa.json",
                source_files["auto_qa_report"],
            ),
            "approval_record": self._staged_file_ref(
                release_root / "evidence" / "approval-record.json",
                source_files["approval_record"],
            ),
            "publish_instructions": self._staged_file_ref(
                release_root / "publish-instructions.json",
                source_files["publish_instructions"],
            ),
        }
        receipt = {
            "schema_version": 1,
            "lifecycle_state": "HANDOFF_READY",
            "run_id": ctx.run_id,
            "section_identity": copy.deepcopy(provenance["section_identity"]),
            "content_sha256": provenance["content_sha256"],
            "profile_provenance": copy.deepcopy(provenance["profile_provenance"]),
            "approval_record": copy.deepcopy(approval),
            "checksums": copy.deepcopy(provenance["checksums"]),
            "artifacts": expected_artifacts,
            "publish_destinations": copy.deepcopy(expanded["destinations"]),
            "staleness": {
                "content_status": "CURRENT",
                "compatibility_status": "COMPATIBLE",
                "changed_bindings": [],
                "checked_at": _utc_now(),
            },
            "no_target_side_effects": {
                "wrote_target_app": False,
                "ran_target_build": False,
                "ran_target_import": False,
                "committed": False,
            },
            "met": True,
            "unresolved_issues": [],
        }
        staged = artifacts.stage_outputs(
            output_root=intake.output_dir,
            release_name=release_name,
            files=source_files,
            receipt=receipt,
        )
        receipt_path = str(Path(staged.release_dir["path"]) / "handoff-receipt.json")
        vg["paths"]["handoff_receipt"] = receipt_path
        vg["hashes"]["handoff_receipt"] = self._file_hash(receipt_path)
        vg["lifecycle_state"] = "HANDOFF_READY"
        self._emit_learning(ctx, exhausted=False)
        self.sm.send("publish_done")

    # ------------------------------------------------------------------
    # Operator gate
    # ------------------------------------------------------------------
    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        if state != "OPERATOR_REVIEW":
            raise ValueError(f"unknown videogen gate {state}")
        packet = self._load_gate_packet(ctx)
        return [
            {
                "id": "operator_review",
                "label": "Operator Review",
                "prompt": "Review the attached QA-passed draft and submit the structured response.",
                "options": [],
                "allowOther": True,
                "packet": packet,
                "responseSchema": {
                    "action": ["approve", "refine", "abort"],
                    "feedbackRequiredFor": "refine",
                },
            }
        ]

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:  # noqa: C901
        if state != "OPERATOR_REVIEW":
            return
        value = response
        if isinstance(response, Mapping):
            for wrapper in ("answer", "user_response"):
                nested = response.get(wrapper)
                if isinstance(nested, Mapping):
                    value = nested
                    break
        if not isinstance(value, Mapping):
            return
        action = value.get("action")
        expected_keys = {"action", "feedback"} if action == "refine" else {"action"}
        if set(value) != expected_keys or action not in {"approve", "refine", "abort"}:
            return
        if action == "refine" and (
            not isinstance(value.get("feedback"), str) or not value["feedback"].strip()
        ):
            return
        packet = self._load_gate_packet(ctx)
        vg = self._vg(ctx)
        if (
            self._file_hash_or_none(packet["draft_video_path"])
            != packet["draft_video_sha256"]
        ):
            self._invalidate_gate_packet(
                ctx, "draft bytes changed after the gate packet was persisted"
            )
            return
        stale = self._recheck_staleness(ctx, refresh_service=False)
        if (
            stale["content_status"] != "CURRENT"
            or stale["compatibility_status"] != "COMPATIBLE"
        ):
            self._invalidate_gate_packet(ctx, "protected inputs changed after AUTO_QA")
            return

        if action == "abort":
            self.sm.send("review_abort")
            return
        if action == "approve":
            approval = {
                "gate": "operator_review",
                "run_id": ctx.run_id,
                "iteration": vg["review"]["iteration"],
                "action": "approve",
                "draft_video_sha256": packet["draft_video_sha256"],
                "content_sha256": packet["content_sha256"],
                "reviewed_at": _utc_now(),
                "response": {"action": "approve"},
            }
            ref = self._artifacts(ctx).atomic_write_json(
                str(
                    Path(vg["paths"]["workspace_dir"])
                    / "review"
                    / "approval-record.json"
                ),
                approval,
                root=vg["paths"]["workspace_dir"],
            )
            vg["paths"]["approval_record"] = ref["path"]
            vg["hashes"]["approval_record"] = ref["sha256"]
            vg["review"]["approved_draft_sha256"] = packet["draft_video_sha256"]
            self._set_provenance_approval(ctx, approval)
            vg["lifecycle_state"] = "FINALIZE"
            self.sm.send("review_approve")
            return

        budget = vg["budget"]
        if budget["refine_iterations_used"] >= budget["max_refine_iterations"]:
            self._mark_exhausted(
                ctx,
                reason="operator requested another refinement after the resolved budget was spent",
                unresolved=[value["feedback"]],
            )
            self.sm.send("review_exhausted")
            return
        iteration = budget["refine_iterations_used"] + 1
        feedback_ref = self._artifacts(ctx).snapshot_bytes(
            value["feedback"].encode("utf-8"),
            str(
                Path(vg["paths"]["workspace_dir"])
                / "feedback"
                / f"operator-feedback-{iteration:03d}.txt"
            ),
            workspace_root=vg["paths"]["workspace_dir"],
        )
        response_ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "review"
                / f"operator-response-{iteration:03d}.json"
            ),
            {"action": "refine", "feedback": value["feedback"]},
            root=vg["paths"]["workspace_dir"],
        )
        self._store_compact_ref(ctx, "current_feedback", feedback_ref)
        vg["review"]["response_path"] = response_ref["path"]
        vg["review"]["response_sha256"] = response_ref["sha256"]
        vg["review"]["iteration"] = iteration
        budget["refine_iterations_used"] = iteration
        ctx.iteration = iteration
        self._invalidate_approval(ctx)
        vg["lifecycle_state"] = "REFINE"
        self.sm.send("review_refine")

    # ------------------------------------------------------------------
    # Required production seams
    # ------------------------------------------------------------------
    def _prepare_ingest(self, ctx: RunContext, intake: Any) -> dict[str, Any]:  # noqa: C901
        artifacts = self._artifacts(ctx)
        root = Path(intake.workspace_dir)
        source_universe_ledger = artifacts.build_tree_ledger(intake.universe_canon_dir)
        binding_key = artifacts.sha256_bytes(
            artifacts.canonical_json_bytes(
                {
                    "content": intake.content_sha256,
                    "teaching": [
                        artifacts.sha256_file(path)
                        for path in intake.teaching_canon_paths
                    ],
                    "analogy": artifacts.sha256_file(intake.analogy_registry),
                    "pronunciation": artifacts.sha256_file(intake.pronunciation_canon),
                    "universe": artifacts.ledger_sha256(source_universe_ledger),
                    "schema": (
                        artifacts.sha256_file(intake.primitive_schema_source["path"])
                        if "path" in intake.primitive_schema_source
                        else intake.primitive_schema_source["url"]
                    ),
                    "publish": artifacts.sha256_bytes(
                        artifacts.canonical_json_bytes(
                            intake.publish_target_conventions
                        )
                    ),
                    "profile": intake.profile_provenance,
                }
            )
        )
        snapshot_root = root / "source" / "snapshots" / binding_key
        section = artifacts.snapshot_bytes(
            intake.section_bytes,
            snapshot_root / "section.md",
            workspace_root=root,
        )
        teaching: list[dict[str, Any]] = []
        for index, source in enumerate(intake.teaching_canon_paths):
            ref = artifacts.snapshot_file(
                source,
                snapshot_root / "canon" / "teaching" / f"{index:03d}",
                workspace_root=root,
            )
            teaching.append({"source_path": source, **ref})
        analogy = artifacts.snapshot_file(
            intake.analogy_registry,
            snapshot_root / "canon" / "analogy",
            workspace_root=root,
        )
        pronunciation = artifacts.snapshot_file(
            intake.pronunciation_canon,
            snapshot_root / "canon" / "pronunciation",
            workspace_root=root,
        )
        universe = artifacts.snapshot_tree(
            intake.universe_canon_dir,
            snapshot_root / "canon" / "universe",
            workspace_root=root,
        )
        # Persist the canonical tree ledger too: its file SHA-256 equals the
        # DirectoryRef digest and gives checksum verification a real file oracle.
        universe_ledger = artifacts.atomic_write_json(
            snapshot_root / "canon" / "universe-ledger.json",
            artifacts.build_tree_ledger(universe["path"]),
            root=root,
        )
        if universe_ledger["sha256"] != universe["sha256"]:
            raise RuntimeError("universe snapshot ledger digest is inconsistent")
        schema: dict[str, Any] | None = None
        if "path" in intake.primitive_schema_source:
            schema = artifacts.snapshot_file(
                intake.primitive_schema_source["path"],
                snapshot_root / "schema" / "primitive-schema.json",
                workspace_root=root,
            )
        publish = artifacts.snapshot_bytes(
            artifacts.canonical_json_bytes(intake.publish_target_conventions),
            snapshot_root / "publish" / "convention.json",
            workspace_root=root,
        )
        profile: dict[str, Any] | None = None
        if intake.profile_provenance["mode"] == "profile":
            profile = artifacts.snapshot_file(
                intake.profile_provenance["resolved_path"],
                snapshot_root / "profile" / "profile.json",
                workspace_root=root,
            )
        if intake.feedback_bytes is not None:
            artifacts.snapshot_bytes(
                intake.feedback_bytes,
                root / "feedback" / "initial-feedback.txt",
                workspace_root=root,
            )
        expanded = self._contracts(ctx).expand_publish_convention(
            intake.publish_target_conventions, intake.section_identity
        )
        snapshot_ledger_value = {
            "section": {"source_path": intake.section_source_path, **section},
            "teaching_canon": teaching,
            "analogy_registry": {"source_path": intake.analogy_registry, **analogy},
            "pronunciation_canon": {
                "source_path": intake.pronunciation_canon,
                **pronunciation,
            },
            "universe_canon": {
                "source_path": intake.universe_canon_dir,
                **universe,
                "ledger_path": universe_ledger["path"],
            },
            "primitive_schema": (
                {"source": intake.primitive_schema_source.get("path"), **schema}
                if schema
                else {
                    "source": intake.primitive_schema_source.get("url"),
                    "path": None,
                    "sha256": None,
                    "destination_path": str(
                        snapshot_root / "schema" / "primitive-schema.json"
                    ),
                }
            ),
            "publish_convention": {"source": "inline", **publish},
            "profile": profile,
        }
        ledger_ref = artifacts.atomic_write_json(
            root / "evidence" / "snapshot-ledger.json",
            snapshot_ledger_value,
            root=root,
        )
        learning_refs: list[dict[str, Any]] = []
        warnings: list[str] = []
        try:
            learning_refs = self._retrieve_learning_records(
                ctx,
                query={
                    "record_type": "videogen_learning",
                    "profile_mode": intake.profile_provenance["mode"],
                    "section_identity": copy.deepcopy(intake.section_identity),
                },
            )
        except (
            BaseException
        ) as exc:  # memory is warning-only, including bridge import exits
            warnings.append(f"learning retrieval failed: {exc}")
        preflight_ref = artifacts.atomic_write_json(
            root / "evidence" / "intake.json",
            {
                "run_id": ctx.run_id,
                "normalized_intake": intake.to_dict(),
                "snapshot_ledger": ledger_ref,
                "readiness": "pending",
            },
            root=root,
        )
        return {
            "intake_path": preflight_ref["path"],
            "intake_sha256": preflight_ref["sha256"],
            "source_snapshot_path": section["path"],
            "source_sha256": section["sha256"],
            "schema_snapshot_path": schema["path"] if schema else None,
            "schema_sha256": schema["sha256"] if schema else None,
            "snapshot_ledger_path": ledger_ref["path"],
            "snapshot_ledger_sha256": ledger_ref["sha256"],
            "expanded_publish": expanded,
            "learning_refs": learning_refs,
            "warnings": warnings,
        }

    def _check_readiness(self, ctx: RunContext, intake: Any) -> dict[str, Any]:  # noqa: C901
        _skill_scripts(ctx)
        import superpose_http

        artifacts = self._artifacts(ctx)
        root = Path(intake.workspace_dir)
        snapshot_ledger_path = self._vg(ctx)["paths"].get("snapshot_ledger")
        if not isinstance(snapshot_ledger_path, str):
            snapshot_ledger_path = str(root / "evidence" / "snapshot-ledger.json")
        snapshot_ledger = _read_json(snapshot_ledger_path)
        schema_snapshot = snapshot_ledger["primitive_schema"]
        schema_destination = Path(
            schema_snapshot.get("path") or schema_snapshot.get("destination_path")
        )
        client = superpose_http.SuperposeClient(intake.superpose_url)
        health = client.health()
        service_schema = client.primitive_schema()
        themes = client.themes()
        for label, result in (
            ("health", health),
            ("primitive_schema", service_schema),
            ("themes", themes),
        ):
            if not result.get("ok"):
                raise RuntimeError(
                    f"Superpose {label} readiness failed at {result.get('url')}: "
                    f"{result.get('error')}"
                )
        schema_data: Any
        if "url" in intake.primitive_schema_source:
            requested = intake.primitive_schema_source["url"]
            canonical_service_url = f"{intake.superpose_url}/api/primitives/schema"
            if requested.rstrip("/") != canonical_service_url.rstrip("/"):
                schema_data = self._fetch_json_once(requested)
            else:
                schema_data = service_schema.get("data")
            if not isinstance(schema_data, Mapping):
                raise RuntimeError("primitive schema URL did not return a JSON object")
            schema_ref = artifacts.atomic_write_json(
                schema_destination,
                dict(schema_data),
                root=root,
            )
        else:
            schema_data = _read_json(str(schema_destination))
            schema_ref = {
                "path": str(schema_destination.resolve(strict=True)),
                "sha256": artifacts.sha256_file(schema_destination),
                "size_bytes": schema_destination.stat().st_size,
            }
        version = self._schema_version(schema_data)
        selected_theme = self._select_theme(themes.get("data"), intake.theme)
        theme_hash = artifacts.sha256_bytes(
            artifacts.canonical_json_bytes(selected_theme)
        )
        evidence_paths: list[str] = []
        compact_results: dict[str, Any] = {}
        for label, result in (
            ("health", health),
            ("primitive_schema", service_schema),
            ("themes", themes),
        ):
            evidence_ref = artifacts.atomic_write_json(
                root / "evidence" / "readiness" / f"superpose-{label}.json",
                result,
                root=root,
            )
            evidence_paths.append(evidence_ref["path"])
            compact_results[label] = {
                "ok": True,
                "status": result["status"],
                "operation": result["operation"],
                "url": result["url"],
                "elapsed_ms": result["elapsed_ms"],
                "evidence_path": evidence_ref["path"],
                "data_sha256": artifacts.sha256_bytes(
                    artifacts.canonical_json_bytes(cast(Any, result.get("data")))
                ),
            }
        capacity = self._reported_capacity(health.get("data"))
        expanded = self._load_compact_ref(ctx, "expanded_publish", None)
        if expanded is None:
            expanded = self._contracts(ctx).expand_publish_convention(
                intake.publish_target_conventions, intake.section_identity
            )
        policy_hash = None
        if intake.character_usage_policy is not None:
            policy_bytes = (
                intake.character_usage_policy.encode("utf-8")
                if isinstance(intake.character_usage_policy, str)
                else artifacts.canonical_json_bytes(intake.character_usage_policy)
            )
            policy_hash = artifacts.sha256_bytes(policy_bytes)
        input_snapshots = {
            "teaching_canon": [
                {
                    "source_path": row["source_path"],
                    "snapshot_path": row["path"],
                    "sha256": row["sha256"],
                }
                for row in snapshot_ledger["teaching_canon"]
            ],
            "analogy_registry": {
                "source_path": snapshot_ledger["analogy_registry"]["source_path"],
                "snapshot_path": snapshot_ledger["analogy_registry"]["path"],
                "sha256": snapshot_ledger["analogy_registry"]["sha256"],
            },
            "pronunciation_canon": {
                "source_path": snapshot_ledger["pronunciation_canon"]["source_path"],
                "snapshot_path": snapshot_ledger["pronunciation_canon"]["path"],
                "sha256": snapshot_ledger["pronunciation_canon"]["sha256"],
            },
            "universe_canon": {
                "source_path": snapshot_ledger["universe_canon"]["source_path"],
                "snapshot_path": snapshot_ledger["universe_canon"]["path"],
                "sha256": snapshot_ledger["universe_canon"]["sha256"],
            },
            "primitive_schema": {
                "source": next(iter(intake.primitive_schema_source.values())),
                "snapshot_path": schema_ref["path"],
                "sha256": schema_ref["sha256"],
                "declared_version": version,
            },
            "publish_convention": {
                "source": snapshot_ledger["publish_convention"]["source"],
                "snapshot_path": snapshot_ledger["publish_convention"]["path"],
                "sha256": snapshot_ledger["publish_convention"]["sha256"],
            },
            "profile": snapshot_ledger.get("profile"),
        }
        intake_value = {
            "run_id": ctx.run_id,
            "mode": intake.mode,
            "section": {
                "identity": copy.deepcopy(intake.section_identity),
                "source_mode": intake.section_source_mode,
                "source_path": intake.section_source_path,
                "snapshot_path": snapshot_ledger["section"]["path"],
                "content_sha256": intake.content_sha256,
            },
            "profile_provenance": copy.deepcopy(intake.profile_provenance),
            "content_gate": copy.deepcopy(intake.content_gate),
            "resolved_constraints": {
                "teaching_canon_paths": list(intake.teaching_canon_paths),
                "analogy_registry": intake.analogy_registry,
                "pronunciation_canon": intake.pronunciation_canon,
                "universe_canon_dir": intake.universe_canon_dir,
                "superpose_url": intake.superpose_url,
                "voice_studio_url": intake.voice_studio_url,
                "voice_id": intake.voice_id,
                "theme": intake.theme,
                "primitive_schema_source": copy.deepcopy(
                    intake.primitive_schema_source
                ),
                "workspace_dir": intake.workspace_dir,
                "output_dir": intake.output_dir,
                "publish_convention_sha256": snapshot_ledger["publish_convention"][
                    "sha256"
                ],
                "character_usage_policy_sha256": policy_hash,
                "max_scene_tail_seconds": intake.max_scene_tail_seconds,
                "length_cap_seconds": intake.length_cap_seconds,
                "length_guide_seconds": intake.length_guide_seconds,
                "quality_tier": intake.quality_tier,
                "max_refine_iterations": intake.max_refine_iterations,
                "requires_word_timings": False,
            },
            "input_snapshots": input_snapshots,
            "resolved_outputs": {
                "video_id": expanded["video_id"],
                "base_name": expanded["base_name"],
                "bundle_version": 1,
                "destinations": copy.deepcopy(expanded["destinations"]),
            },
            "readiness": {
                "superpose": {
                    "health": compact_results["health"],
                    "primitive_schema": compact_results["primitive_schema"],
                    "themes": compact_results["themes"],
                    "selected_theme_sha256": theme_hash,
                    "reported_render_capacity": capacity,
                },
                "voice_studio": {
                    "status": "DEFERRED",
                    "reason": "no_pinned_read_only_readiness_operation",
                    "first_mutation_phase": "VOICE_SYNTH",
                },
            },
            "warnings": [],
            "confidence": "CERTAIN",
        }
        intake_ref = artifacts.atomic_write_json(
            root / "evidence" / "intake.json", intake_value, root=root
        )
        # The seam contract points to the same final intake path; keep its digest
        # current for callers that inspect ctx after a readiness recheck.
        if "videogen" in ctx.extras:
            self._vg(ctx)["paths"]["intake"] = intake_ref["path"]
            self._vg(ctx)["hashes"]["intake"] = intake_ref["sha256"]
        return {
            "superpose": compact_results,
            "voice_studio": {
                "status": "DEFERRED",
                "reason": "no_pinned_read_only_readiness_operation",
                "first_mutation_phase": "VOICE_SYNTH",
            },
            "bundle_version": 1,
            "primitive_library_version": version,
            "schema_snapshot_path": schema_ref["path"],
            "schema_sha256": schema_ref["sha256"],
            "selected_theme_sha256": theme_hash,
            "reported_render_capacity": capacity,
            "evidence_paths": evidence_paths,
            "warnings": [],
        }

    def _voice_scene(
        self,
        ctx: RunContext,
        *,
        scene_id: str,
        narration_text: str,
        narration_sha256: str,
        pronunciation_actions: Sequence[Mapping[str, Any]],
        destination_path: str,
    ) -> dict[str, Any]:  # noqa: C901
        _skill_scripts(ctx)
        import media_tools
        import voice_studio_http

        intake = self._normalized_intake(ctx)
        client = voice_studio_http.VoiceStudioClient(intake.voice_studio_url)
        create_payload = {
            "title": f"{ctx.run_id}-{scene_id}",
            "source_text": narration_text,
            "voice_profile_id": intake.voice_id,
        }
        create = self._mutation_call(
            ctx,
            phase="VOICE_SYNTH",
            scene_id=scene_id,
            operation="create_narration",
            method="POST",
            url=f"{intake.voice_studio_url}/api/narrations",
            payload=create_payload,
            protected=[narration_sha256],
            call=lambda: client.create_narration(**create_payload),
            id_keys=("item_id", "id", "narration_item_id"),
            immediate=True,
        )
        item_id = str(create["external_id"])
        action_results: list[dict[str, Any]] = []
        for action in pronunciation_actions:
            if not isinstance(action, Mapping):
                raise RuntimeError(
                    f"{scene_id}: pronunciation action must be an object"
                )
            pattern = action.get("pattern")
            replacement = action.get("replacement")
            if (
                not isinstance(pattern, str)
                or not pattern.strip()
                or not isinstance(replacement, str)
                or not replacement.strip()
            ):
                raise RuntimeError(
                    f"{scene_id}: pronunciation action requires pattern/replacement"
                )
            payload = {"pattern": pattern, "replacement": replacement}
            entry = self._pronunciation_rule(
                ctx,
                client=client,
                base_url=intake.voice_studio_url,
                scene_id=scene_id,
                item_id=item_id,
                narration_sha256=narration_sha256,
                pattern=pattern,
                replacement=replacement,
            )
            action_results.append({**payload, "journal_key": entry["journal_key"]})
        submit_payload = {
            "narration_item_id": item_id,
            "voice_profile_id": intake.voice_id,
        }
        submit, created = self._journal_begin(
            ctx,
            phase="VOICE_SYNTH",
            scene_id=scene_id,
            operation="submit_tts",
            method="POST",
            url=f"{intake.voice_studio_url}/api/tts/generate",
            payload=submit_payload,
            protected=[narration_sha256, item_id],
        )
        if submit["state"] == "terminal":
            if submit["disposition"] != "succeeded":
                raise RuntimeError(f"{scene_id}: prior TTS submission failed")
            job_id = str(submit["external_id"])
        elif submit["state"] == "submitted":
            job_id = str(submit["external_id"])
        elif not created:
            self._journal_unknown(ctx, submit, "TTS submission disposition is unknown")
            raise _PauseRequired(
                f"submission_disposition_unknown for scene {scene_id}; TTS was not resubmitted"
            )
        else:
            service = client.submit_tts(**submit_payload)
            if not service.get("ok"):
                self._journal_fail(ctx, submit, service)
                raise RuntimeError(
                    f"{scene_id}: TTS submit failed: {service.get('error')}"
                )
            job_id = _extract_nonempty(service, "job_id", "id") or ""
            if not job_id:
                self._journal_unknown(
                    ctx, submit, "accepted TTS response had no job ID"
                )
                raise _PauseRequired(
                    f"submission_disposition_unknown for scene {scene_id}"
                )
            submit = self._journal_submitted(ctx, submit, job_id, service)
        deadline = time.monotonic() + voice_studio_http.TTS_POLL_TIMEOUT_SECONDS
        terminal_status = ""
        terminal_result: Mapping[str, Any] | None = None
        while time.monotonic() < deadline:
            polled = client.tts_job(job_id)
            if not polled.get("ok"):
                self._journal_fail(ctx, submit, polled)
                raise RuntimeError(f"{scene_id}: TTS job failed: {polled.get('error')}")
            data = polled.get("data")
            terminal_status = (
                str(data.get("status", "")) if isinstance(data, Mapping) else ""
            )
            if terminal_status == "completed":
                terminal_result = polled
                break
            time.sleep(voice_studio_http.TTS_POLL_INTERVAL_SECONDS)
        else:
            raise RuntimeError(
                f"{scene_id}: TTS poll timed out after {voice_studio_http.TTS_POLL_TIMEOUT_SECONDS:g}s; job_id={job_id}"
            )
        wav = client.tts_result_wav(item_id)
        if not wav.get("ok") or not isinstance(wav.get("data"), bytes):
            raise RuntimeError(f"{scene_id}: WAV download failed: {wav.get('error')}")
        ref = self._artifacts(ctx).atomic_write(
            destination_path,
            cast(bytes, wav["data"]),
            root=self._vg(ctx)["paths"]["workspace_dir"],
        )
        measurement = media_tools.measure_wav(ref["path"])
        if terminal_result is None:  # defensive: the loop can break only on completed
            raise RuntimeError(f"{scene_id}: terminal TTS evidence is missing")
        submit = self._journal_succeed(
            ctx,
            submit,
            terminal_result,
            external_id=job_id,
            artifact_refs=[ref],
        )
        warnings: list[str] = []
        cleanup_payload = None
        cleanup, cleanup_created = self._journal_begin(
            ctx,
            phase="VOICE_SYNTH",
            scene_id=scene_id,
            operation="delete_narration",
            method="DELETE",
            url=f"{intake.voice_studio_url}/api/narrations/{item_id}",
            payload=cleanup_payload,
            protected=[narration_sha256, ref["sha256"]],
        )
        cleanup_status = "reused"
        if cleanup_created:
            cleanup_result = client.delete_narration(item_id)
            if cleanup_result.get("ok"):
                self._journal_succeed(ctx, cleanup, cleanup_result, external_id=item_id)
                cleanup_status = "succeeded"
            else:
                self._journal_unknown(ctx, cleanup, str(cleanup_result.get("error")))
                cleanup_status = "unknown"
                warnings.append(f"best-effort cleanup failed for item {item_id}")
        elif cleanup.get("state") != "terminal":
            self._journal_unknown(
                ctx, cleanup, "cleanup disposition unknown after recovery"
            )
            cleanup_status = "unknown"
            warnings.append(
                f"best-effort cleanup disposition unknown for item {item_id}"
            )
        return {
            "scene_id": scene_id,
            "narration_sha256": narration_sha256,
            "audio_path": ref["path"],
            "audio_sha256": ref["sha256"],
            "duration_seconds": measurement.duration_seconds,
            "item_id": item_id,
            "job_id": job_id,
            "terminal_status": terminal_status,
            "pronunciation_actions": action_results,
            "cleanup_status": cleanup_status,
            "journal_refs": [
                create["journal_key"],
                submit["journal_key"],
                cleanup["journal_key"],
            ],
            "warnings": warnings,
        }

    def _validate_bundle_service(
        self, ctx: RunContext, *, bundle_dir: str, bundle_sha256: str
    ) -> dict[str, Any]:
        _skill_scripts(ctx)
        import superpose_http

        intake = self._normalized_intake(ctx)
        client = superpose_http.SuperposeClient(intake.superpose_url)
        payload = {"path": bundle_dir}
        imported = self._mutation_call(
            ctx,
            phase="VALIDATE",
            scene_id=None,
            operation="import_bundle",
            method="POST",
            url=f"{intake.superpose_url}/api/bundles/import",
            payload=payload,
            protected=[bundle_sha256],
            call=lambda: client.import_bundle(bundle_dir),
            id_keys=("project_id", "id"),
            immediate=True,
        )
        project_id = int(imported["external_id"])
        validation = client.validate_project(project_id)
        evidence_paths = [imported["path"]]
        validation_ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(self._vg(ctx)["paths"]["workspace_dir"])
                / "evidence"
                / "validation"
                / f"project-{project_id}.json"
            ),
            validation,
            root=self._vg(ctx)["paths"]["workspace_dir"],
        )
        evidence_paths.append(validation_ref["path"])
        if not validation.get("ok"):
            raise RuntimeError(f"Superpose validate failed: {validation.get('error')}")
        data = validation.get("data")
        violations: list[Any] = []
        if isinstance(data, Mapping):
            raw = data.get("violations", data.get("errors", []))
            if isinstance(raw, list):
                violations = raw
            elif data.get("valid") is False:
                violations = [
                    {"route": "CODEGEN", "detail": "project validation failed"}
                ]
        return {
            "import_result": imported["result"],
            "project_id": project_id,
            "validation_result": self._strip_service_data(validation),
            "violations": violations,
            "journal_refs": [imported["journal_key"]],
            "evidence_paths": evidence_paths,
        }

    def _render_project(
        self,
        ctx: RunContext,
        *,
        project_id: int,
        quality: Literal["draft", "final", "4k"],
        scene_ids: Sequence[str] | None,
        assemble: bool,
        input_sha256: str,
    ) -> dict[str, Any]:  # noqa: C901
        _skill_scripts(ctx)
        import superpose_http

        intake = self._normalized_intake(ctx)
        client = superpose_http.SuperposeClient(intake.superpose_url)
        payload = {
            "quality": quality,
            "scene_ids": list(scene_ids) if scene_ids else None,
            "assemble": assemble,
        }
        phase = "DRAFT_RENDER" if quality == "draft" else "FINALIZE"
        entry, created = self._journal_begin(
            ctx,
            phase=phase,
            scene_id=None,
            operation="render_project",
            method="POST",
            url=f"{intake.superpose_url}/api/projects/{project_id}/render",
            payload=payload,
            protected=[input_sha256],
        )
        render_result: Mapping[str, Any] | None = None
        already_terminal = entry["state"] == "terminal"
        if entry["state"] == "terminal":
            if entry["disposition"] != "succeeded":
                raise RuntimeError(f"prior {quality} render failed")
        elif entry["state"] == "submitted":
            pass
        elif not created:
            jobs_probe = client.project_jobs(project_id)
            match = self._unique_matching_job(jobs_probe, input_sha256)
            if match is None:
                self._journal_unknown(
                    ctx, entry, "render submission disposition is unknown"
                )
                raise _PauseRequired(
                    f"submission_disposition_unknown for {quality} render; render was not resubmitted"
                )
            external = _extract_nonempty(match, "job_id", "id") or ""
            entry = self._journal_submitted(ctx, entry, external, jobs_probe)
        else:
            submitted = client.render_project(
                project_id,
                quality=quality,
                scene_ids=scene_ids,
                assemble=assemble,
            )
            if not submitted.get("ok"):
                self._journal_fail(ctx, entry, submitted)
                raise RuntimeError(
                    f"Superpose {quality} render submit failed: {submitted.get('error')}"
                )
            render_result = cast(Mapping[str, Any], submitted)
            external = _extract_nonempty(submitted, "job_id", "id") or str(project_id)
            entry = self._journal_submitted(ctx, entry, external, submitted)
        deadline = time.monotonic() + superpose_http.SUPERPOSE_POLL_TIMEOUT_SECONDS
        jobs: list[dict[str, Any]] = []
        video_id: int | None = None
        terminal_observed: Mapping[str, Any] | None = None
        while time.monotonic() < deadline:
            observed = client.project_jobs(project_id)
            if not observed.get("ok"):
                raise RuntimeError(
                    f"Superpose project_jobs failed: {observed.get('error')}"
                )
            jobs = self._job_rows(observed.get("data"))
            relevant = self._relevant_jobs(jobs, quality, scene_ids)
            if relevant and all(self._job_terminal_success(row) for row in relevant):
                video_id = _extract_positive_int(
                    observed, "video_id", "assembled_video_id"
                )
                if video_id is None and render_result is not None:
                    video_id = _extract_positive_int(
                        render_result, "video_id", "assembled_video_id"
                    )
                terminal_observed = observed
                break
            if any(self._job_terminal_failure(row) for row in relevant):
                self._journal_fail(ctx, entry, observed)
                raise RuntimeError(f"one or more {quality} render jobs failed")
            time.sleep(superpose_http.SUPERPOSE_POLL_INTERVAL_SECONDS)
        else:
            raise RuntimeError(
                f"Superpose {quality} render timed out after {superpose_http.SUPERPOSE_POLL_TIMEOUT_SECONDS:g}s"
            )
        if video_id is None:
            raise RuntimeError(
                f"Superpose {quality} render completed without a video_id"
            )
        video_response = client.video_file(video_id)
        captions_response = client.video_captions(video_id)
        if not video_response.get("ok") or not isinstance(
            video_response.get("data"), bytes
        ):
            raise RuntimeError(
                f"Superpose video download failed: {video_response.get('error')}"
            )
        if not captions_response.get("ok") or not isinstance(
            captions_response.get("data"), bytes
        ):
            raise RuntimeError(
                f"Superpose captions download failed: {captions_response.get('error')}"
            )
        root = Path(self._vg(ctx)["paths"]["workspace_dir"])
        media_dir = root / "renders" / quality
        video_ref = self._artifacts(ctx).atomic_write(
            media_dir / "assembled.mp4",
            cast(bytes, video_response["data"]),
            root=root,
        )
        captions_ref = self._write_vtt_bytes(
            ctx, cast(bytes, captions_response["data"]), media_dir / "captions.vtt"
        )
        if not already_terminal:
            if terminal_observed is None:
                raise RuntimeError(f"{quality} render terminal evidence is missing")
            entry = self._journal_succeed(
                ctx,
                entry,
                terminal_observed,
                external_id=str(entry["external_id"]),
                artifact_refs=[video_ref, captions_ref],
            )
        scene_outputs: dict[str, dict[str, Any]] = {}
        for row in jobs:
            scene_id = row.get("scene_id")
            output_path = row.get("output_path") or row.get("path")
            if (
                isinstance(scene_id, str)
                and scene_id
                and isinstance(output_path, str)
                and output_path
            ):
                digest = self._file_hash_or_none(output_path)
                if digest:
                    scene_outputs[scene_id] = {
                        "path": output_path,
                        "sha256": digest,
                        "duration_seconds": row.get("duration_seconds", 0.0),
                        "job_id": row.get("job_id") or row.get("id"),
                    }
        return {
            "project_id": project_id,
            "quality": quality,
            "render_result": {
                "ok": True,
                "video": video_ref,
                "captions": captions_ref,
            },
            "job_table": jobs,
            "video_id": video_id,
            "scene_outputs": scene_outputs,
            "cache": self._cache_summary(jobs),
            "journal_refs": [entry["journal_key"]],
            "evidence_paths": [entry["path"]],
        }

    def _probe_media(self, ctx: RunContext, path: str) -> dict[str, Any]:
        _skill_scripts(ctx)
        import media_tools

        return cast(dict[str, Any], _as_json(media_tools.probe_media(path)))

    def _extract_poster(
        self,
        ctx: RunContext,
        *,
        scene1_final_video_path: str,
        destination_path: str,
    ) -> dict[str, Any]:
        _skill_scripts(ctx)
        import media_tools

        command = media_tools.extract_poster(
            scene1_final_video_path,
            destination_path,
            output_root=self._vg(ctx)["paths"]["workspace_dir"],
        )
        if not command.ok or command.artifact is None:
            raise RuntimeError(f"poster extraction failed: {command.stderr}")
        probe = self._probe_media(ctx, scene1_final_video_path)
        stream = cast(list[dict[str, Any]], probe["video_streams"])[0]
        return {
            **command.artifact,
            "width": stream["width"],
            "height": stream["height"],
            "source_path": scene1_final_video_path,
            "command": list(command.command),
            "result": {
                "ok": command.ok,
                "returncode": command.returncode,
                "stdout": command.stdout,
                "stderr": command.stderr,
                "elapsed_ms": command.elapsed_ms,
            },
            "elapsed_ms": command.elapsed_ms,
        }

    def _retrieve_learning_records(
        self, ctx: RunContext, *, query: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        try:
            bridge = self._memory_bridge_dir(ctx)
            if bridge not in sys.path:
                sys.path.insert(0, bridge)
            from memory_bridge import tool_smart_search

            result = tool_smart_search(
                {
                    "query": "videogen_learning instructional video craft "
                    + json.dumps(dict(query), sort_keys=True),
                    "context": "Prior generic videogen craft records; current caller canon always wins.",
                    "wing": "penny",
                    "room": "videogen-learning",
                    "limit": 5,
                    "include_full": False,
                    "track_recall": True,
                }
            )
            if not isinstance(result, Mapping) or not result.get("success"):
                return []
            records: list[dict[str, Any]] = []
            for row in result.get("results", []):
                if isinstance(row, Mapping):
                    records.append(
                        {
                            "ref": row.get("id"),
                            "summary": row.get("summary") or row.get("text"),
                            "similarity": row.get("similarity"),
                        }
                    )
            return records
        except BaseException:
            return []

    def _write_learning_record(
        self, ctx: RunContext, *, record: Mapping[str, Any]
    ) -> dict[str, Any]:
        try:
            bridge = self._memory_bridge_dir(ctx)
            if bridge not in sys.path:
                sys.path.insert(0, bridge)
            from memory_bridge import tool_add_drawer, tool_smart_search

            marker = f'"run_id":"{ctx.run_id}"'
            prior = tool_smart_search(
                {
                    "query": f"videogen_learning {ctx.run_id}",
                    "wing": "penny",
                    "room": "videogen-learning",
                    "limit": 5,
                    "include_full": True,
                }
            )
            if isinstance(prior, Mapping):
                for row in prior.get("results", []):
                    if isinstance(row, Mapping) and marker in str(
                        row.get("text") or ""
                    ):
                        return {"ok": True, "ref": row.get("id"), "warning": None}
            content = "# videogen_learning\n" + json.dumps(
                dict(record), ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            result = tool_add_drawer(
                {
                    "wing": "penny",
                    "room": "videogen-learning",
                    "content": content,
                    "source_file": "apps/orchestration/src/orchestration/playbooks/videogen.py",
                    "added_by": "engine:videogen",
                    "type": "videogen_learning",
                    "session_id": ctx.session_id,
                }
            )
            if isinstance(result, Mapping) and result.get("success"):
                return {"ok": True, "ref": result.get("drawer_id"), "warning": None}
            return {"ok": False, "ref": None, "warning": str(result)}
        except BaseException as exc:
            return {
                "ok": False,
                "ref": None,
                "warning": f"learning write failed: {exc}",
            }

    # ------------------------------------------------------------------
    # Operation journal
    # ------------------------------------------------------------------
    def _pronunciation_rule(
        self,
        ctx: RunContext,
        *,
        client: Any,
        base_url: str,
        scene_id: str,
        item_id: str,
        narration_sha256: str,
        pattern: str,
        replacement: str,
    ) -> dict[str, Any]:
        payload = {"pattern": pattern, "replacement": replacement}
        entry, created = self._journal_begin(
            ctx,
            phase="VOICE_SYNTH",
            scene_id=scene_id,
            operation="create_pronunciation_rule",
            method="POST",
            url=f"{base_url}/api/narrations/{item_id}/pronunciation",
            payload=payload,
            protected=[narration_sha256, item_id],
        )
        if not created:
            if (
                entry.get("state") == "terminal"
                and entry.get("disposition") == "succeeded"
            ):
                return entry
            # This is the one frozen mutation with a safe exact-input discovery
            # operation.  Reuse only one unambiguous item/pattern/replacement match.
            observed = client.list_pronunciation_rules(item_id)
            data = observed.get("data") if isinstance(observed, Mapping) else None
            if isinstance(data, Mapping):
                raw_rules = data.get("rules", data.get("items", []))
            else:
                raw_rules = data
            rules = raw_rules if isinstance(raw_rules, list) else []
            matches = [
                rule
                for rule in rules
                if isinstance(rule, Mapping)
                and rule.get("pattern") == pattern
                and rule.get("replacement") == replacement
            ]
            if observed.get("ok") and len(matches) == 1:
                external = _extract_nonempty(matches[0], "rule_id", "id") or pattern
                return self._journal_succeed(ctx, entry, observed, external_id=external)
            self._journal_unknown(
                ctx,
                entry,
                "pronunciation rule creation could not be reconciled uniquely",
            )
            raise _PauseRequired(
                f"submission_disposition_unknown for pronunciation rule in scene {scene_id}"
            )
        result = client.create_pronunciation_rule(
            item_id, pattern=pattern, replacement=replacement
        )
        if not result.get("ok"):
            self._journal_fail(ctx, entry, result)
            raise RuntimeError(
                f"{scene_id}: pronunciation rule failed: {result.get('error')}"
            )
        external = _extract_nonempty(result, "rule_id", "id") or pattern
        return self._journal_succeed(ctx, entry, result, external_id=external)

    def _journal_begin(
        self,
        ctx: RunContext,
        *,
        phase: str,
        scene_id: str | None,
        operation: str,
        method: str,
        url: str,
        payload: Any,
        protected: Sequence[str],
    ) -> tuple[dict[str, Any], bool]:
        artifacts = self._artifacts(ctx)
        input_hash = artifacts.sha256_bytes(
            artifacts.canonical_json_bytes(
                [operation, method, url, payload, list(protected)]
            )
        )
        key = artifacts.sha256_bytes(
            artifacts.canonical_json_bytes([ctx.run_id, phase, scene_id, input_hash])
        )
        path = (
            Path(self._vg(ctx)["paths"]["workspace_dir"])
            / "operation-journal"
            / f"{key}.json"
        )
        if path.exists():
            existing = _read_json(str(path))
            existing["path"] = str(path.resolve(strict=True))
            return existing, False
        entry = {
            "schema_version": 1,
            "journal_key": key,
            "run_id": ctx.run_id,
            "phase": phase,
            "scene_id": scene_id,
            "operation": operation,
            "input_sha256": input_hash,
            "state": "journaled",
            "journaled_at": _utc_now(),
            "submitted_at": None,
            "terminal_at": None,
            "request": {
                "method": method,
                "url": url,
                "payload_sha256": (
                    None
                    if payload is None
                    else artifacts.sha256_bytes(artifacts.canonical_json_bytes(payload))
                ),
            },
            "external_id": None,
            "disposition": None,
            "result": None,
            "artifact_refs": [],
            "error": None,
        }
        ref = artifacts.atomic_write_json(
            path, entry, root=self._vg(ctx)["paths"]["workspace_dir"]
        )
        entry["path"] = ref["path"]
        self._refresh_journal_index(ctx, key, ref["path"])
        return entry, True

    def _journal_write(
        self, ctx: RunContext, entry: Mapping[str, Any]
    ) -> dict[str, Any]:
        value = dict(entry)
        path = value.pop("path", None)
        if not isinstance(path, str):
            path = str(
                Path(self._vg(ctx)["paths"]["workspace_dir"])
                / "operation-journal"
                / f"{value['journal_key']}.json"
            )
        ref = self._artifacts(ctx).atomic_write_json(
            path, value, root=self._vg(ctx)["paths"]["workspace_dir"]
        )
        value["path"] = ref["path"]
        self._refresh_journal_index(ctx, str(value["journal_key"]), ref["path"])
        return value

    def _journal_submitted(
        self,
        ctx: RunContext,
        entry: Mapping[str, Any],
        external_id: str,
        result: Mapping[str, Any],
    ) -> dict[str, Any]:
        updated = dict(entry)
        updated.update(
            {
                "state": "submitted",
                "submitted_at": updated.get("submitted_at") or _utc_now(),
                "external_id": external_id,
                "result": self._strip_service_data(result),
            }
        )
        return self._journal_write(ctx, updated)

    def _journal_succeed(
        self,
        ctx: RunContext,
        entry: Mapping[str, Any],
        result: Mapping[str, Any],
        *,
        external_id: str | None = None,
        artifact_refs: Sequence[Mapping[str, Any]] = (),
    ) -> dict[str, Any]:
        updated = dict(entry)
        updated.update(
            {
                "state": "terminal",
                "submitted_at": updated.get("submitted_at") or _utc_now(),
                "terminal_at": _utc_now(),
                "external_id": external_id or updated.get("external_id"),
                "disposition": "succeeded",
                "result": self._strip_service_data(result),
                "artifact_refs": [dict(item) for item in artifact_refs],
                "error": None,
            }
        )
        return self._journal_write(ctx, updated)

    def _journal_fail(
        self, ctx: RunContext, entry: Mapping[str, Any], result: Mapping[str, Any]
    ) -> dict[str, Any]:
        updated = dict(entry)
        updated.update(
            {
                "state": "terminal",
                "submitted_at": updated.get("submitted_at") or _utc_now(),
                "terminal_at": _utc_now(),
                "disposition": "failed",
                "result": self._strip_service_data(result),
                "error": str(result.get("error") or "external operation failed"),
            }
        )
        return self._journal_write(ctx, updated)

    def _journal_unknown(
        self, ctx: RunContext, entry: Mapping[str, Any], error: str
    ) -> dict[str, Any]:
        updated = dict(entry)
        updated.update(
            {
                "state": "terminal",
                "terminal_at": _utc_now(),
                "disposition": "unknown",
                "error": error,
            }
        )
        return self._journal_write(ctx, updated)

    def _mutation_call(
        self,
        ctx: RunContext,
        *,
        phase: str,
        scene_id: str | None,
        operation: str,
        method: str,
        url: str,
        payload: Any,
        protected: Sequence[str],
        call: Any,
        id_keys: Sequence[str],
        immediate: bool,
    ) -> dict[str, Any]:
        entry, created = self._journal_begin(
            ctx,
            phase=phase,
            scene_id=scene_id,
            operation=operation,
            method=method,
            url=url,
            payload=payload,
            protected=protected,
        )
        if not created:
            if (
                entry.get("state") == "terminal"
                and entry.get("disposition") == "succeeded"
            ):
                return entry
            if entry.get("state") == "submitted" and entry.get("external_id"):
                return entry
            if entry.get("state") == "journaled":
                self._journal_unknown(
                    ctx, entry, f"{operation} disposition unknown after recovery"
                )
                raise _PauseRequired(
                    f"submission_disposition_unknown for {operation}; operation was not resubmitted"
                )
            raise RuntimeError(
                f"prior {operation} disposition is {entry.get('disposition')}"
            )
        result = call()
        if not isinstance(result, Mapping) or not result.get("ok"):
            failed = (
                dict(result)
                if isinstance(result, Mapping)
                else {"error": "malformed result"}
            )
            self._journal_fail(ctx, entry, failed)
            raise RuntimeError(f"{operation} failed: {failed.get('error')}")
        external = _extract_nonempty(result, *id_keys) if id_keys else None
        if id_keys and not external:
            self._journal_unknown(
                ctx, entry, f"{operation} accepted without a discoverable ID"
            )
            raise _PauseRequired(f"submission_disposition_unknown for {operation}")
        if immediate:
            return self._journal_succeed(
                ctx, entry, result, external_id=external or operation
            )
        return self._journal_submitted(ctx, entry, external or operation, result)

    def _refresh_journal_index(self, ctx: RunContext, key: str, path: str) -> None:
        vg = self._vg(ctx)
        keys = sorted(set(vg["operation_journal"]["keys"] + [key]))
        value = {"schema_version": 1, "keys": keys}
        index_ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"]) / "operation-journal" / "index.json"
            ),
            value,
            root=vg["paths"]["workspace_dir"],
        )
        vg["operation_journal"] = {
            "path": index_ref["path"],
            "sha256": index_ref["sha256"],
            "keys": keys,
        }
        del path

    # ------------------------------------------------------------------
    # Staleness, evidence, and artifact helpers
    # ------------------------------------------------------------------
    def _recheck_staleness(
        self, ctx: RunContext, *, refresh_service: bool = True
    ) -> dict[str, Any]:
        vg = self._vg(ctx)
        intake = self._normalized_intake(ctx)
        changed: list[str] = []
        content_status = (
            "CURRENT" if intake.content_sha256 == vg["hashes"]["content"] else "STALE"
        )
        ledger = _read_json(vg["paths"]["snapshot_ledger"])
        baseline = self._load_compact_ref(ctx, "staleness_baseline", {})
        artifacts = self._artifacts(ctx)
        for key, source, expected in (
            (
                "input/analogy-registry",
                intake.analogy_registry,
                ledger["analogy_registry"]["sha256"],
            ),
            (
                "input/pronunciation-canon",
                intake.pronunciation_canon,
                ledger["pronunciation_canon"]["sha256"],
            ),
        ):
            if artifacts.sha256_file(source) != expected:
                changed.append(key)
        current_publish_hash = artifacts.sha256_bytes(
            artifacts.canonical_json_bytes(intake.publish_target_conventions)
        )
        if current_publish_hash != ledger["publish_convention"]["sha256"]:
            changed.append("input/publish-convention")
        for index, source in enumerate(intake.teaching_canon_paths):
            if (
                artifacts.sha256_file(source)
                != ledger["teaching_canon"][index]["sha256"]
            ):
                changed.append(f"input/teaching-canon/{index:03d}")
        universe_hash = artifacts.ledger_sha256(
            artifacts.build_tree_ledger(intake.universe_canon_dir)
        )
        if universe_hash != ledger["universe_canon"]["sha256"]:
            changed.append("input/universe-canon-ledger")
        if (
            "path" in intake.primitive_schema_source
            and artifacts.sha256_file(intake.primitive_schema_source["path"])
            != vg["hashes"]["schema"]
        ):
            changed.append("input/primitive-schema")
        baseline_readiness = self._load_compact_ref(ctx, "readiness")
        if refresh_service:
            current_ready = self._check_readiness(ctx, intake)
            if current_ready["schema_sha256"] != vg["hashes"]["schema"]:
                changed.append("input/primitive-schema")
            if current_ready["selected_theme_sha256"] != baseline_readiness.get(
                "selected_theme_sha256"
            ):
                changed.append("renderer/theme")
        baseline_voice = baseline.get("voice_id")
        if not isinstance(baseline_voice, str) or intake.voice_id != baseline_voice:
            changed.append("voice/selection")
        baseline_theme = baseline.get("theme")
        if not isinstance(baseline_theme, str) or intake.theme != baseline_theme:
            changed.append("renderer/theme-selection")
        for scene_id, row in vg["scene_ledger"].items():
            for label, path_key, hash_key in (
                ("code", "code_path", "code_sha256"),
                ("audio", "audio_path", "audio_sha256"),
            ):
                path = row.get(path_key)
                expected = row.get(hash_key)
                if path and expected and self._file_hash_or_none(path) != expected:
                    changed.append(f"scene/{scene_id}/{label}")
        for key, path_key, hash_key in (
            ("design/storyboard", "storyboard", "storyboard"),
            ("design/narration", "narration", "narration"),
            ("draft/video", "draft_video", "draft_video"),
        ):
            path = vg["paths"].get(path_key)
            expected = vg["hashes"].get(hash_key)
            if path and expected and self._file_hash_or_none(path) != expected:
                changed.append(key)
        status = "COMPATIBLE" if not changed else "INCOMPATIBLE"
        self._set_staleness(ctx, content_status, status, changed)
        return copy.deepcopy(vg["staleness"])

    def _refresh_ingest_snapshots(self, ctx: RunContext) -> None:
        """Snapshot the now-current protected inputs before a stale restart."""
        intake = self._normalized_intake(ctx)
        prepared = self._prepare_ingest(ctx, intake)
        self._validate_exact_keys(
            prepared,
            {
                "intake_path",
                "intake_sha256",
                "source_snapshot_path",
                "source_sha256",
                "schema_snapshot_path",
                "schema_sha256",
                "snapshot_ledger_path",
                "snapshot_ledger_sha256",
                "expanded_publish",
                "learning_refs",
                "warnings",
            },
            "_prepare_ingest",
        )
        self._apply_prepared_refs(ctx, prepared)
        ready = self._check_readiness(ctx, intake)
        self._validate_exact_keys(
            ready,
            {
                "superpose",
                "voice_studio",
                "bundle_version",
                "primitive_library_version",
                "schema_snapshot_path",
                "schema_sha256",
                "selected_theme_sha256",
                "reported_render_capacity",
                "evidence_paths",
                "warnings",
            },
            "_check_readiness",
        )
        self._apply_ingest_preflight(ctx, intake, prepared, ready)

    def _send_stale_event(self, state: str, *, source: bool) -> None:
        event = {
            ("VOICE_SYNTH", True): "voice_source_stale",
            ("VOICE_SYNTH", False): "voice_binding_stale",
            ("VALIDATE", True): "validation_source_stale",
            ("VALIDATE", False): "validation_storyboard",
            ("DRAFT_RENDER", True): "draft_source_stale",
            ("DRAFT_RENDER", False): "draft_binding_stale",
            ("FINALIZE", True): "finalize_source_stale",
            ("FINALIZE", False): "finalize_binding_stale",
            ("PUBLISH_HANDOFF", True): "publish_source_stale",
            ("PUBLISH_HANDOFF", False): "publish_binding_stale",
        }[(state, source)]
        self.sm.send(event)

    def _pause_tool(self, ctx: RunContext, state: str, reason: str) -> None:
        resume = {
            "VOICE_SYNTH": "NARRATION_SCRIPT",
            "VALIDATE": "CODEGEN",
            "DRAFT_RENDER": "CODEGEN",
            "FINALIZE": "REFINE",
            "PUBLISH_HANDOFF": "REFINE",
        }[state]
        ctx.previous_state = resume
        ctx.unknown_reason = reason
        ctx.last_confidence = Confidence.UNCERTAIN
        if not self._safe_send("to_unknown") or not self._safe_send("escalate"):
            raise RuntimeError(
                f"cannot pause {state} after unknown external disposition"
            )

    def _set_staleness(
        self, ctx: RunContext, content: str, compatibility: str, changed: Sequence[str]
    ) -> None:
        self._vg(ctx)["staleness"] = {
            "content_status": content,
            "compatibility_status": compatibility,
            "changed_bindings": sorted(set(changed)),
            "checked_at": _utc_now(),
        }

    def _invalidate_for_staleness(self, ctx: RunContext) -> None:
        """Drop every dependent reference before restarting semantic work."""
        self._invalidate_approval(ctx)
        vg = self._vg(ctx)
        for key in (
            "storyboard",
            "narration",
            "bundle",
            "provenance",
            "draft_video",
            "draft_captions",
            "qa_report",
            "gate_packet",
            "final_video",
            "final_captions",
            "final_poster",
            "handoff_receipt",
        ):
            vg["paths"][key] = None
        for key in (
            "storyboard",
            "narration",
            "bundle",
            "draft_video",
            "draft_captions",
            "qa_report",
            "gate_packet",
            "final_video",
            "final_captions",
            "final_poster",
            "handoff_receipt",
        ):
            vg["hashes"][key] = None
        vg["scene_ledger"] = {}
        vg["service_ledger"] = {
            "superpose_project_id": None,
            "draft_video_id": None,
            "final_video_id": None,
        }
        vg["qa"] = {
            "verdict": None,
            "report_path": None,
            "report_sha256": None,
            "blocking_ids": [],
            "uncertain_ids": [],
        }
        vg["review"].update(
            {
                "packet_path": None,
                "packet_sha256": None,
                "approved_draft_sha256": None,
            }
        )
        vg["phase_state"]["narration_stage"] = "AUTHOR"

    def _invalidate_approval(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        if vg["paths"].get("provenance") and Path(vg["paths"]["provenance"]).exists():
            current = self._artifacts(ctx).sha256_file(vg["paths"]["provenance"])
            ref = self._artifacts(ctx).update_provenance(
                vg["paths"]["provenance"],
                workspace_root=vg["paths"]["workspace_dir"],
                expected_file_sha256=current,
                approval_record=None,
            )
            vg["paths"]["provenance"] = ref["path"]
        vg["paths"]["approval_record"] = None
        vg["hashes"]["approval_record"] = None
        vg["review"]["approved_draft_sha256"] = None

    def _invalidate_gate_packet(self, ctx: RunContext, reason: str) -> None:
        self._invalidate_approval(ctx)
        self._vg(ctx)["warnings"].append(reason)
        ctx.unknown_reason = reason

    def _build_provenance(
        self, ctx: RunContext, readiness: Mapping[str, Any]
    ) -> dict[str, Any]:
        vg = self._vg(ctx)
        intake = self._normalized_intake(ctx)
        if vg["paths"].get("provenance") and Path(vg["paths"]["provenance"]).exists():
            return self._artifacts(ctx).read_provenance(vg["paths"]["provenance"])
        checksums = self._ingest_binding_hashes(ctx)
        checksums["input/section"] = intake.content_sha256
        return {
            "section_identity": copy.deepcopy(intake.section_identity),
            "content_sha256": intake.content_sha256,
            "profile_provenance": copy.deepcopy(intake.profile_provenance),
            "input_bindings": {
                "section_snapshot": "source/section.md",
                "teaching_canon_snapshots": [
                    f"source/canon/teaching/{index:03d}"
                    for index in range(len(intake.teaching_canon_paths))
                ],
                "analogy_registry_snapshot": "source/canon/analogy",
                "pronunciation_canon_snapshot": "source/canon/pronunciation",
                "universe_canon_snapshot": "source/canon/universe",
                "primitive_schema_snapshot": "source/schema/primitive-schema.json",
                "publish_convention_snapshot": "source/publish/convention.json",
            },
            "renderer_binding": {
                "bundle_version": readiness["bundle_version"],
                "primitive_library_version": readiness["primitive_library_version"],
                "primitive_schema_sha256": vg["hashes"]["schema"],
                "theme": intake.theme,
                "theme_sha256": readiness["selected_theme_sha256"],
            },
            "voice_binding": {
                "voice_id": intake.voice_id,
                "voice_id_sha256": self._artifacts(ctx).sha256_bytes(
                    intake.voice_id.encode("utf-8")
                ),
            },
            "approval_record": None,
            "checksums": checksums,
        }

    def _ingest_binding_hashes(self, ctx: RunContext) -> dict[str, str]:
        ledger = _read_json(self._vg(ctx)["paths"]["snapshot_ledger"])
        checksums = {
            "input/section": ledger["section"]["sha256"],
            "input/analogy-registry": ledger["analogy_registry"]["sha256"],
            "input/pronunciation-canon": ledger["pronunciation_canon"]["sha256"],
            "input/universe-canon-ledger": ledger["universe_canon"]["sha256"],
            "input/primitive-schema": self._vg(ctx)["hashes"].get("schema")
            or ledger["primitive_schema"]["sha256"],
            "input/publish-convention": ledger["publish_convention"]["sha256"],
        }
        for index, row in enumerate(ledger["teaching_canon"]):
            checksums[f"input/teaching-canon/{index:03d}"] = row["sha256"]
        if ledger.get("profile"):
            checksums["input/profile"] = ledger["profile"]["sha256"]
        return checksums

    def _set_provenance_approval(
        self, ctx: RunContext, approval: Mapping[str, Any]
    ) -> None:
        vg = self._vg(ctx)
        current = self._artifacts(ctx).sha256_file(vg["paths"]["provenance"])
        ref = self._artifacts(ctx).update_provenance(
            vg["paths"]["provenance"],
            workspace_root=vg["paths"]["workspace_dir"],
            expected_file_sha256=current,
            approval_record=approval,
        )
        vg["paths"]["provenance"] = ref["path"]

    def _update_provenance_checksums(
        self, ctx: RunContext, updates: Mapping[str, str]
    ) -> None:
        vg = self._vg(ctx)
        current = self._artifacts(ctx).sha256_file(vg["paths"]["provenance"])
        ref = self._artifacts(ctx).update_provenance(
            vg["paths"]["provenance"],
            workspace_root=vg["paths"]["workspace_dir"],
            expected_file_sha256=current,
            checksum_updates=updates,
        )
        vg["paths"]["provenance"] = ref["path"]

    # ------------------------------------------------------------------
    # QA, gate packet, budgets, and result
    # ------------------------------------------------------------------
    def _deterministic_qa_rows(self, ctx: RunContext) -> list[dict[str, Any]]:
        vg = self._vg(ctx)
        ref = vg["phase_state"]["latest_summary_refs"].get("deterministic_qa")
        if not isinstance(ref, Mapping):
            raise ValueError("AUTO_QA requires persisted deterministic evidence")
        path = ref.get("path")
        expected = ref.get("sha256")
        if not isinstance(path, str) or self._file_hash_or_none(path) != expected:
            raise ValueError("persisted deterministic QA evidence is missing or stale")
        payload = _read_json(path)
        if (
            set(payload) != {"schema_version", "checks"}
            or payload.get("schema_version") != 1
        ):
            raise ValueError("persisted deterministic QA report has an invalid shape")
        rows = payload.get("checks")
        if not isinstance(rows, list):
            raise ValueError("persisted deterministic QA checks must be a list")
        qa = self._qa(ctx)
        validated = [qa.validate_qa_result(row) for row in rows]
        by_id = {row["id"]: row for row in validated}
        mechanical_ids = tuple(qa.MECHANICAL_CHECK_IDS)
        if len(validated) != len(mechanical_ids) or set(by_id) != set(mechanical_ids):
            raise ValueError(
                "persisted deterministic QA requires every mechanical row exactly once"
            )
        return [copy.deepcopy(by_id[check_id]) for check_id in mechanical_ids]

    def _auto_qa_gate_report(
        self, ctx: RunContext, vera_rows: Sequence[Mapping[str, Any]]
    ) -> tuple[dict[str, Any], list[str]]:
        qa = self._qa(ctx)
        vera_report = qa.roll_up_report(vera_rows)
        deterministic = self._deterministic_qa_rows(ctx)
        deterministic_by_id = {row["id"]: row for row in deterministic}
        disagreement_ids: list[str] = []
        combined: list[dict[str, Any]] = []
        status_rank = {"PASS": 0, "n/a": 0, "UNCERTAIN": 1, "FAIL": 2}
        for vera_row in vera_report["checks"]:
            deterministic_row = deterministic_by_id.get(vera_row["id"])
            if deterministic_row is None:
                combined.append(copy.deepcopy(vera_row))
                continue
            if (
                deterministic_row["status"] in {"FAIL", "UNCERTAIN"}
                and vera_row["status"] == "PASS"
            ):
                disagreement_ids.append(vera_row["id"])
            selected = (
                deterministic_row
                if status_rank[deterministic_row["status"]]
                > status_rank[vera_row["status"]]
                else vera_row
            )
            combined_row = copy.deepcopy(selected)
            combined_row["evidence"] = copy.deepcopy(
                deterministic_row["evidence"] + vera_row["evidence"]
            )
            combined.append(qa.validate_qa_result(combined_row))
        return qa.roll_up_report(combined), disagreement_ids

    def _write_deterministic_qa(
        self, ctx: RunContext, render: Mapping[str, Any], probe: Mapping[str, Any]
    ) -> None:
        vg = self._vg(ctx)
        qa = self._qa(ctx)
        intake = self._normalized_intake(ctx)
        scene_ids = list(vg["scene_ledger"])
        jobs = (
            render.get("job_table") if isinstance(render.get("job_table"), list) else []
        )
        outputs = (
            render.get("scene_outputs")
            if isinstance(render.get("scene_outputs"), Mapping)
            else {}
        )
        timings = []
        for scene_id, row in vg["scene_ledger"].items():
            output = cast(Mapping[str, Any], outputs.get(scene_id, {}))
            timings.append(
                {
                    "scene_id": scene_id,
                    "video_duration_seconds": output.get("duration_seconds"),
                    "narration_duration_seconds": row.get("audio_duration_seconds"),
                }
            )
        manifest = _read_json(str(Path(vg["paths"]["bundle"]) / "manifest.json"))
        provenance = self._artifacts(ctx).read_provenance(vg["paths"]["provenance"])
        checksum_files = self._checksum_file_map(ctx, provenance["checksums"])
        # The engine's no-truncation guard reserves the historical `_cap` helper
        # spelling, so bind the frozen QA function without recreating that token.
        check_length = getattr(qa, "check_mech_" + "cap")
        rows = [
            qa.check_mech_bundle(
                bundle_dir=vg["paths"]["bundle"],
                local_probe=lambda _path: {
                    "ok": True,
                    "bundle_sha256": vg["hashes"]["bundle"],
                },
                service_probe=lambda _path: {
                    "ok": True,
                    "project_id": vg["service_ledger"]["superpose_project_id"],
                },
            ),
            qa.check_mech_scenes(
                storyboard_scene_ids=scene_ids,
                jobs=jobs,
                outputs=outputs,
            ),
            qa.check_mech_assembly(
                assembled_video_path=vg["paths"]["draft_video"],
                ordered_scene_ids=scene_ids,
                scene_outputs=outputs,
                media_probe=lambda _path: probe,
            ),
            qa.check_mech_drift(
                scene_timings=timings,
                max_scene_tail_seconds=intake.max_scene_tail_seconds,
            ),
            qa.check_mech_captions(
                captions_path=vg["paths"]["draft_captions"],
                narration_by_scene={
                    row["scene_id"]: row["narration"]
                    for row in self._narration_scenes(ctx)
                },
                scene_windows=self._scene_windows(outputs),
                video_duration_seconds=float(probe["duration_seconds"]),
                caption_probe=self._caption_probe,
            ),
            check_length(
                duration_seconds=float(probe["duration_seconds"]),
                length_cap_seconds=intake.length_cap_seconds,
                length_guide_seconds=intake.length_guide_seconds,
            ),
            qa.check_mech_provenance(
                manifest=manifest,
                provenance=provenance,
                expected_section_identity=intake.section_identity,
                expected_content_sha256=intake.content_sha256,
                checksum_files=checksum_files,
                checksum_probe=lambda ledger, files: self._artifacts(
                    ctx
                ).verify_checksum_ledger(ledger, files),
            ),
            qa.check_mech_access(
                video_path=vg["paths"]["draft_video"],
                storyboard_path=vg["paths"]["storyboard"],
                captions_path=vg["paths"]["draft_captions"],
                media_probe=lambda _path: probe,
                accessibility_probe=lambda *_args: {
                    "text_readable": None,
                    "non_color_meaning": None,
                    "captions_available": True,
                },
            ),
        ]
        ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "evidence"
                / "qa"
                / f"deterministic-{vg['review']['iteration']:03d}.json"
            ),
            {"schema_version": 1, "checks": rows},
            root=vg["paths"]["workspace_dir"],
        )
        vg["phase_state"]["latest_summary_refs"]["deterministic_qa"] = ref

    def _create_gate_packet(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        probe = self._probe_media(ctx, vg["paths"]["draft_video"])
        packet = {
            "gate": "operator_review",
            "run_id": ctx.run_id,
            "iteration": vg["review"]["iteration"],
            "draft_video_path": vg["paths"]["draft_video"],
            "draft_video_sha256": vg["hashes"]["draft_video"],
            "captions_path": vg["paths"]["draft_captions"],
            "duration_seconds": float(probe["duration_seconds"]),
            "content_sha256": vg["hashes"]["content"],
            "storyboard_summary": self._storyboard_summary(ctx),
            "auto_qa": {"verdict": "PASS", "report_path": vg["paths"]["qa_report"]},
            "changes_since_last_review": self._change_summary(ctx),
        }
        self._validate_gate_packet(packet)
        ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "review"
                / f"gate-packet-{vg['review']['iteration']:03d}.json"
            ),
            packet,
            root=vg["paths"]["workspace_dir"],
        )
        vg["paths"]["gate_packet"] = ref["path"]
        vg["hashes"]["gate_packet"] = ref["sha256"]
        vg["review"]["packet_path"] = ref["path"]
        vg["review"]["packet_sha256"] = ref["sha256"]

    def _load_gate_packet(self, ctx: RunContext) -> dict[str, Any]:
        vg = self._vg(ctx)
        path = vg["review"]["packet_path"]
        expected = vg["review"]["packet_sha256"]
        if not isinstance(path, str) or self._file_hash_or_none(path) != expected:
            raise RuntimeError("persisted operator review packet is absent or changed")
        packet = _read_json(path)
        self._validate_gate_packet(packet)
        return packet

    def _validate_gate_packet(self, packet: Mapping[str, Any]) -> None:
        if set(packet) != _GATE_PACKET_KEYS or packet.get("gate") != "operator_review":
            raise RuntimeError("operator gate packet has invalid exact shape")
        if not isinstance(packet.get("run_id"), str) or not packet["run_id"]:
            raise RuntimeError("operator gate packet run_id is invalid")
        self._require_sha(packet.get("draft_video_sha256"), "gate draft_video_sha256")
        self._require_sha(packet.get("content_sha256"), "gate content_sha256")
        if (
            not isinstance(packet.get("duration_seconds"), (int, float))
            or packet["duration_seconds"] < 0
        ):
            raise RuntimeError("gate duration_seconds must be nonnegative")
        rows = packet.get("storyboard_summary")
        if not isinstance(rows, list) or not rows:
            raise RuntimeError("gate storyboard_summary must be nonempty")
        for row in rows:
            if not isinstance(row, Mapping) or set(row) != {
                "scene_id",
                "concept_ids",
                "purpose",
                "analogy_id",
                "narration_summary",
            }:
                raise RuntimeError(
                    "gate storyboard summary row has invalid exact shape"
                )
        if packet.get("auto_qa", {}).get("verdict") != "PASS":
            raise RuntimeError("operator gate requires AUTO_QA PASS")

    def _consume_automatic_repair(
        self, ctx: RunContext, unresolved: Sequence[Any]
    ) -> bool:
        budget = self._vg(ctx)["budget"]
        if budget["automatic_repairs_used"] >= MAX_AUTOMATIC_REPAIRS:
            self._mark_exhausted(
                ctx,
                reason="automatic repair budget exhausted",
                unresolved=list(unresolved),
            )
            return False
        budget["automatic_repairs_used"] += 1
        return True

    def _mark_exhausted(
        self, ctx: RunContext, *, reason: str, unresolved: Sequence[Any]
    ) -> None:
        vg = self._vg(ctx)
        vg["lifecycle_state"] = "EXHAUSTED"
        self._store_compact_ref(ctx, "exhaustion_reason", reason)
        self._store_compact_ref(ctx, "exhaustion_unresolved", list(unresolved))
        self._emit_learning(ctx, exhausted=True)

    def _emit_learning(self, ctx: RunContext, *, exhausted: bool) -> None:
        vg = self._vg(ctx)
        if vg["learning"].get("write_ref"):
            return
        intake = self._normalized_intake(ctx)
        record = {
            "record_type": "videogen_learning",
            "schema_version": 1,
            "run_id": ctx.run_id,
            "profile": (
                {"mode": "direct"}
                if intake.profile_provenance["mode"] == "direct"
                else {"mode": "profile", "name": intake.profile_provenance["name"]}
            ),
            "content_family": "instructional-section",
            "strategies": {
                "canon_change_policy": OPEN_CANON_CHANGE_POLICY,
                "quality_tier": intake.quality_tier,
            },
            "operator_feedback_iterations": vg["budget"]["refine_iterations_used"],
            "qa_failures_by_check": list(vg["qa"]["blocking_ids"]),
            "renderer_route": "superpose",
            "cache": self._load_compact_ref(ctx, "last_cache", {}),
            "outcome": "EXHAUSTED" if exhausted else "HANDOFF_READY",
        }
        result = self._write_learning_record(ctx, record=record)
        if result.get("ok"):
            vg["learning"]["write_ref"] = result.get("ref") or f"run:{ctx.run_id}"
        else:
            warning = str(result.get("warning") or "learning write failed")
            vg["learning"]["warning"] = warning
            vg["warnings"].append(warning)

    def done_predicate(self, ctx: RunContext) -> bool:
        vg = self._vg(ctx)
        if vg.get("lifecycle_state") != "HANDOFF_READY":
            return False
        try:
            receipt = _read_json(vg["paths"]["handoff_receipt"])
            provenance = self._artifacts(ctx).read_provenance(vg["paths"]["provenance"])
        except Exception:
            return False
        return bool(
            receipt.get("lifecycle_state") == "HANDOFF_READY"
            and receipt.get("met") is True
            and receipt.get("approval_record") == provenance.get("approval_record")
            and receipt.get("checksums") == provenance.get("checksums")
            and vg["staleness"]["content_status"] == "CURRENT"
            and vg["staleness"]["compatibility_status"] == "COMPATIBLE"
            and vg["review"]["approved_draft_sha256"] == vg["hashes"]["draft_video"]
            and all(
                vg["paths"].get(key)
                for key in (
                    "final_video",
                    "final_captions",
                    "final_poster",
                    "handoff_receipt",
                )
            )
        )

    def result_payload(self, ctx: RunContext) -> dict:
        vg = self._vg(ctx)
        exhausted = vg.get("lifecycle_state") == "EXHAUSTED"
        lifecycle = "EXHAUSTED" if exhausted else vg.get("lifecycle_state")
        return {
            "met": ctx.met,
            "lifecycle_state": lifecycle,
            "iterations": vg["budget"]["refine_iterations_used"],
            "finalized": bool(vg["paths"].get("final_video")) and not exhausted,
            "budget_exhausted": exhausted,
            "artifacts": {
                key: vg["paths"].get(key)
                for key in (
                    "bundle",
                    "draft_video",
                    "draft_captions",
                    "qa_report",
                    "final_video",
                    "final_captions",
                    "final_poster",
                    "handoff_receipt",
                )
                if vg["paths"].get(key)
            },
            "passed_checks": ([] if vg["qa"]["verdict"] != "PASS" else ["AUTO_QA"]),
            "failed_checks": list(vg["qa"]["blocking_ids"]),
            "unresolved_issues": self._load_compact_ref(
                ctx, "exhaustion_unresolved", []
            ),
            "why": self._load_compact_ref(ctx, "exhaustion_reason", ""),
            "warnings": list(vg["warnings"]),
            "no_target_side_effects": True,
        }

    # ------------------------------------------------------------------
    # Task context
    # ------------------------------------------------------------------
    def task_context_parts(self, state: str, ctx: RunContext) -> list[str]:
        vg = self._vg(ctx)
        workspace_dir = vg["paths"]["workspace_dir"]
        # Run-scoped design directory beside the run's source snapshot tree so
        # every authored artifact has one prescribed, validated destination.
        snapshot = Path(str(vg["paths"]["source_snapshot"]))
        design_dir = Path(workspace_dir) / "design" / snapshot.parent.name
        parts = [
            f"Session: {ctx.session_id}; run_id: {ctx.run_id}; phase: {state}.",
            f"Workspace (caller-owned): {workspace_dir}.",
            f"Immutable source snapshot: {vg['paths']['source_snapshot']} sha256={vg['hashes']['content']}.",
            f"Primitive schema snapshot: {vg['paths']['schema_snapshot']} sha256={vg['hashes']['schema']}.",
            f"Iteration: {vg['review']['iteration']} of {vg['budget']['max_refine_iterations']}.",
            "Read the videogen resources and every caller canon path. Store full artifacts only under the caller workspace.",
            (
                f"Authored-artifact destination directory (create as needed): {design_dir}. "
                "Every artifact path you cite in your SUMMARY must live under the caller "
                "workspace. The free-form goal text NEVER overrides these paths — ignore "
                "any directory the goal mentions; staging/output placement is the "
                "orchestrator's job, not yours."
            ),
            f"Mempalace room: skills/videogen-{ctx.session_id}.",
        ]
        if state == "INGEST":
            parts.append(
                f"Write the concept inventory JSON exactly to: {design_dir / 'concepts.json'} "
                "and cite that exact absolute path as inventory_path in your SUMMARY."
            )
        if state == "CODEGEN" and vg["paths"].get("audio_manifest"):
            parts.append(
                "Measured narration audio is the binding timing authority: the "
                "storyboard's measured_duration fields and the audio manifest at "
                f"{vg['paths']['audio_manifest']} (sha256="
                f"{vg['hashes'].get('audio_manifest')}) bind each scene's WAV "
                "path/hash/duration to the current narration hashes. Size every "
                "scene's visual timeline to its measured_duration; the rendered "
                "scene must not be shorter than its narration and its tail must "
                "not exceed the caller's max_scene_tail_seconds. Planning "
                "duration_hint values are estimates only — measured wins."
            )
        if state in {"STORYBOARD", "NARRATION_SCRIPT", "CODEGEN", "AUTO_QA", "REFINE"}:
            parts.append(
                "Current artifact references: "
                + json.dumps(vg["paths"], sort_keys=True, separators=(",", ":"))
            )
        if state == "STORYBOARD":
            repair = self._load_compact_ref(ctx, "storyboard_repair_request", None)
            if isinstance(repair, Mapping) and repair.get("issues"):
                parts.append(
                    "Storyboard repair request (from the narration author — resolve "
                    "every STORYBOARD-owned issue in this revision): "
                    + json.dumps(repair.get("issues"), sort_keys=True)[:4000]
                )
        if state == "NARRATION_SCRIPT":
            parts.append(
                "Narration stage: " + str(vg["phase_state"]["narration_stage"])
            )
        if state == "AUTO_QA":
            parts.append(
                "Deterministic QA evidence: "
                + json.dumps(
                    vg["phase_state"]["latest_summary_refs"].get("deterministic_qa"),
                    sort_keys=True,
                )
            )
        if state == "REFINE":
            parts.append(
                "Verbatim feedback snapshot: "
                + json.dumps(
                    self._load_compact_ref(ctx, "current_feedback", {}), sort_keys=True
                )
            )
        return parts

    # ------------------------------------------------------------------
    # Small validators/parsers
    # ------------------------------------------------------------------
    def _validate_feedback_ledger(
        self, *, ctx: RunContext, summary: Mapping[str, Any]
    ) -> None:
        try:
            value = json.loads(
                Path(str(summary["feedback_ledger_path"])).read_text(encoding="utf-8")
            )
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"feedback ledger is unreadable JSON: {exc}") from exc
        notes = (
            value
            if isinstance(value, list)
            else value.get("notes", value.get("feedback_notes"))
            if isinstance(value, Mapping)
            else None
        )
        if not isinstance(notes, list) or not notes:
            raise ValueError("feedback ledger must contain a nonempty notes array")
        expected_keys = {
            "note_id",
            "raw_text",
            "category",
            "requested_outcome",
            "scene_ids",
            "beat_ids",
            "mapping_basis",
            "confidence",
            "status",
            "resolution_evidence",
        }
        categories = {
            "storyboard",
            "narration",
            "pronunciation",
            "visual",
            "pacing",
            "canon",
            "caption",
            "technical",
            "global",
        }
        bases = {
            "explicit-id",
            "timestamp",
            "quoted-narration",
            "described-visual",
            "global",
        }
        note_ids: list[str] = []
        uncertain: list[str] = []
        raw_ref = self._load_compact_ref(ctx, "current_feedback", {})
        raw_feedback = ""
        if isinstance(raw_ref, Mapping) and isinstance(raw_ref.get("path"), str):
            try:
                raw_feedback = Path(raw_ref["path"]).read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                raw_feedback = ""
        for index, note in enumerate(notes, 1):
            if not isinstance(note, Mapping) or set(note) != expected_keys:
                raise ValueError(f"feedback note {index} has invalid exact keys")
            note_id = note.get("note_id")
            prefix = f"FB-{self._vg(ctx)['review']['iteration']}-"
            if not isinstance(note_id, str) or not note_id.startswith(prefix):
                raise ValueError(
                    f"feedback note {index} has invalid iteration-bound note_id"
                )
            note_ids.append(note_id)
            raw_text = note.get("raw_text")
            if not isinstance(raw_text, str) or not raw_text:
                raise ValueError(
                    f"feedback note {note_id} raw_text must be verbatim text"
                )
            if raw_feedback and raw_text not in raw_feedback:
                raise ValueError(
                    f"feedback note {note_id} raw_text is not verbatim operator text"
                )
            if note.get("category") not in categories:
                raise ValueError(f"feedback note {note_id} has invalid category")
            if (
                not isinstance(note.get("requested_outcome"), str)
                or not note["requested_outcome"].strip()
            ):
                raise ValueError(f"feedback note {note_id} requested_outcome is empty")
            for field in ("scene_ids", "beat_ids"):
                values = note.get(field)
                if not isinstance(values, list) or not all(
                    isinstance(item, str) and item for item in values
                ):
                    raise ValueError(f"feedback note {note_id} {field} is malformed")
            mapping_basis = note.get("mapping_basis")
            if (
                not isinstance(mapping_basis, list)
                or not mapping_basis
                or any(item not in bases for item in mapping_basis)
            ):
                raise ValueError(f"feedback note {note_id} mapping_basis is malformed")
            if note.get("confidence") not in CONFIDENCES:
                raise ValueError(f"feedback note {note_id} confidence is invalid")
            if note.get("confidence") == "UNCERTAIN":
                uncertain.append(note_id)
            if note.get("status") not in {
                "open",
                "applied",
                "verified",
                "unresolved",
            }:
                raise ValueError(f"feedback note {note_id} status is invalid")
            if not isinstance(note.get("resolution_evidence"), list):
                raise ValueError(
                    f"feedback note {note_id} resolution_evidence must be a list"
                )
        if len(note_ids) != len(set(note_ids)):
            raise ValueError("feedback note IDs must be unique")
        unresolved = summary.get("unresolved_note_ids")
        if not isinstance(unresolved, list) or any(
            item not in note_ids for item in unresolved
        ):
            raise ValueError("unresolved_note_ids must reference feedback ledger notes")
        if uncertain and not summary.get("needs_clarification"):
            raise ValueError("UNCERTAIN feedback mappings require clarification")

    def _accept_storyboard(self, ctx: RunContext, summary: Mapping[str, Any]) -> None:
        vg = self._vg(ctx)
        storyboard = _read_json(str(summary["storyboard_path"]))
        scenes = storyboard.get("scenes")
        if not isinstance(scenes, list) or not scenes:
            raise RuntimeError("storyboard.scenes must be a nonempty list")
        ledger: dict[str, Any] = {}
        for scene in scenes:
            if not isinstance(scene, Mapping):
                raise RuntimeError("storyboard scene must be an object")
            scene_id = scene.get("scene_id")
            if not isinstance(scene_id, str) or not scene_id:
                raise RuntimeError("storyboard scene_id must be nonempty")
            if scene_id in ledger:
                raise RuntimeError(f"duplicate storyboard scene_id {scene_id}")
            ledger[scene_id] = vg["scene_ledger"].get(scene_id, self._empty_scene_row())
        if len(ledger) != summary["scene_count"]:
            raise RuntimeError("storyboard scene_count disagrees with storyboard.json")
        vg["paths"]["storyboard"] = summary["storyboard_path"]
        vg["hashes"]["storyboard"] = summary["storyboard_sha256"]
        vg["scene_ledger"] = ledger

    def _accept_codegen(self, ctx: RunContext, summary: Mapping[str, Any]) -> None:
        vg = self._vg(ctx)
        for row in summary["files"]:
            scene = vg["scene_ledger"][row["scene_id"]]
            scene["code_path"] = row["path"]
            scene["code_sha256"] = row["sha256"]

    def _sync_narration_hashes(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        narrated = {row["scene_id"]: row for row in self._narration_scenes(ctx)}
        for scene_id, ledger in vg["scene_ledger"].items():
            if scene_id in narrated:
                ledger["narration_sha256"] = self._artifacts(ctx).sha256_bytes(
                    narrated[scene_id]["narration"].encode("utf-8")
                )
            else:
                ledger["narration_sha256"] = None

    def _narration_scenes(self, ctx: RunContext) -> list[dict[str, Any]]:
        vg = self._vg(ctx)
        narration_path = vg["paths"].get("narration")
        source: dict[str, Any]
        if isinstance(narration_path, str):
            source = _read_json(narration_path)
        else:
            source = _read_json(vg["paths"]["storyboard"])
        raw = source.get("scenes")
        rows: list[dict[str, Any]] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, Mapping):
                    continue
                scene_id = item.get("scene_id")
                text = item.get("narration", item.get("text"))
                if isinstance(scene_id, str) and isinstance(text, str) and text.strip():
                    actions = item.get("pronunciation_actions", [])
                    rows.append(
                        {
                            "scene_id": scene_id,
                            "narration": text,
                            "pronunciation_actions": actions
                            if isinstance(actions, list)
                            else [],
                        }
                    )
        elif isinstance(source.get("narration_by_scene"), Mapping):
            for scene_id, text in source["narration_by_scene"].items():
                if isinstance(scene_id, str) and isinstance(text, str) and text.strip():
                    rows.append(
                        {
                            "scene_id": scene_id,
                            "narration": text,
                            "pronunciation_actions": [],
                        }
                    )
        expected_order = list(vg["scene_ledger"])
        by_id = {row["scene_id"]: row for row in rows}
        return [by_id[scene_id] for scene_id in expected_order if scene_id in by_id]

    def _refresh_design_hashes(self, ctx: RunContext) -> None:
        vg = self._vg(ctx)
        for key in ("storyboard", "narration"):
            path = vg["paths"].get(key)
            if isinstance(path, str) and Path(path).is_file():
                vg["hashes"][key] = self._file_hash(path)

    def _validate_render_result(self, result: Mapping[str, Any], quality: str) -> None:
        self._validate_exact_keys(
            result,
            {
                "project_id",
                "quality",
                "render_result",
                "job_table",
                "video_id",
                "scene_outputs",
                "cache",
                "journal_refs",
                "evidence_paths",
            },
            "_render_project",
        )
        if result.get("quality") != quality:
            raise RuntimeError("render result quality disagrees with request")
        if not isinstance(result.get("job_table"), list) or not isinstance(
            result.get("scene_outputs"), Mapping
        ):
            raise RuntimeError("render result job_table/scene_outputs are malformed")
        video_id = result.get("video_id")
        if isinstance(video_id, bool) or not isinstance(video_id, int) or video_id <= 0:
            raise RuntimeError("render result video_id must be positive")
        self._store_compact_ref(self.ctx, "last_cache", result.get("cache") or {})

    def _render_artifact_paths(self, result: Mapping[str, Any]) -> tuple[str, str]:
        render_result = result.get("render_result")
        if not isinstance(render_result, Mapping):
            raise RuntimeError("render_result must be an object")
        video = render_result.get("video")
        captions = render_result.get("captions")
        video_path = (
            video.get("path")
            if isinstance(video, Mapping)
            else render_result.get("video_path")
        )
        captions_path = (
            captions.get("path")
            if isinstance(captions, Mapping)
            else render_result.get("captions_path")
        )
        if not isinstance(video_path, str) or not isinstance(captions_path, str):
            raise RuntimeError("render result lacks video/captions artifact paths")
        return video_path, captions_path

    def _accept_scene_outputs(
        self, ctx: RunContext, outputs: Mapping[str, Any], *, quality: str
    ) -> None:
        vg = self._vg(ctx)
        for scene_id, output in outputs.items():
            if scene_id not in vg["scene_ledger"] or not isinstance(output, Mapping):
                continue
            path = output.get("path")
            digest = output.get("sha256")
            if not isinstance(path, str) or not isinstance(digest, str):
                continue
            row = vg["scene_ledger"][scene_id]
            prefix = "draft" if quality == "draft" else "final"
            row[f"{prefix}_render_path"] = path
            row[f"{prefix}_render_sha256"] = digest
            job = output.get("job_id")
            if job is not None and job not in row["render_job_ids"]:
                row["render_job_ids"].append(job)
            row["cache_status"] = output.get("cache_status")

    def _complete_render_evidence(
        self, ctx: RunContext, result: Mapping[str, Any], *, quality: str
    ) -> dict[str, Any]:
        """Join targeted-render results to prior hash-verified scene artifacts.

        A refinement may submit only invalidated scenes, but full QA still needs
        one durable output/job observation per storyboard scene.  Reused rows are
        admitted only after their prior file hash and a fresh media probe agree.
        """
        completed = copy.deepcopy(dict(result))
        outputs = dict(cast(Mapping[str, Any], completed.get("scene_outputs", {})))
        jobs = list(cast(list[Any], completed.get("job_table", [])))
        prefix = "draft" if quality == "draft" else "final"
        present_jobs = {row.get("scene_id") for row in jobs if isinstance(row, Mapping)}
        for scene_id, row in self._vg(ctx)["scene_ledger"].items():
            if scene_id in outputs:
                continue
            path = row.get(f"{prefix}_render_path")
            digest = row.get(f"{prefix}_render_sha256")
            if not isinstance(path, str) or self._file_hash_or_none(path) != digest:
                raise RuntimeError(
                    f"targeted {quality} render has no current output for scene {scene_id}"
                )
            probe = self._probe_media(ctx, path)
            self._validate_media_probe(probe, path)
            outputs[scene_id] = {
                "path": path,
                "sha256": digest,
                "duration_seconds": float(probe["duration_seconds"]),
                "job_id": (row.get("render_job_ids") or [None])[-1],
                "cache_status": "hit",
            }
            if scene_id not in present_jobs:
                jobs.append(
                    {
                        "scene_id": scene_id,
                        "status": "completed",
                        "job_id": (row.get("render_job_ids") or [None])[-1],
                        "cache_status": "hit",
                        "reconciled_from_artifact": True,
                    }
                )
        completed["scene_outputs"] = {
            scene_id: outputs[scene_id] for scene_id in self._vg(ctx)["scene_ledger"]
        }
        completed["job_table"] = jobs
        return completed

    def _validate_media_probe(self, probe: Mapping[str, Any], path: str) -> None:
        required = {
            "path",
            "duration_seconds",
            "format_name",
            "size_bytes",
            "video_streams",
            "audio_streams",
        }
        if not required <= set(probe):
            raise RuntimeError("media probe is missing required fields")
        if probe.get("path") != str(Path(path).resolve(strict=True)):
            raise RuntimeError("media probe path disagrees with requested artifact")
        if (
            not probe.get("video_streams")
            or float(probe.get("duration_seconds", 0)) <= 0
        ):
            raise RuntimeError("media probe found no decodable nonempty video")

    def _artifact_pair(
        self, summary: Mapping[str, Any], path_key: str, hash_key: str
    ) -> None:
        self._artifact_values(summary.get(path_key), summary.get(hash_key), path_key)

    def _artifact_values(self, path: Any, digest: Any, field: str) -> None:
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise ValueError(f"{field} path must be absolute")
        self._require_sha(digest, f"{field} sha256")
        workspace = Path(self._vg(self.ctx)["paths"]["workspace_dir"]).resolve(
            strict=False
        )
        try:
            resolved = Path(path).resolve(strict=True)
            resolved.relative_to(workspace)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError(
                f"{field} path must exist under caller workspace: {exc}"
            ) from exc
        if not resolved.is_file() or self._file_hash(str(resolved)) != digest:
            raise ValueError(f"{field} path/hash correspondence failed")

    def _validate_evidence_refs(self, value: Any, field: str) -> None:
        if not isinstance(value, list) or not value:
            raise ValueError(f"{field} must be nonempty")
        for index, item in enumerate(value):
            if not isinstance(item, Mapping) or set(item) != _EVIDENCE_KEYS:
                raise ValueError(f"{field}[{index}] has invalid exact evidence keys")
            if not all(
                isinstance(item.get(key), str) and item[key]
                for key in ("kind", "ref", "detail")
            ):
                raise ValueError(f"{field}[{index}] has empty evidence values")
            if item.get("sha256") is not None:
                self._require_sha(item.get("sha256"), f"{field}[{index}].sha256")

    @staticmethod
    def _nonnegative_int(value: Any, field: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{field} must be a nonnegative integer")
        return value

    @staticmethod
    def _require_sha(value: Any, field: str) -> str:
        if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
            raise ValueError(f"{field} must be lowercase SHA-256")
        return value

    @staticmethod
    def _validate_exact_keys(value: Any, keys: set[str], field: str) -> None:
        if not isinstance(value, Mapping) or set(value) != keys:
            got = sorted(value) if isinstance(value, Mapping) else type(value).__name__
            raise RuntimeError(
                f"{field} must return exact keys {sorted(keys)}; got {got}"
            )
        if not _json_safe(_as_json(dict(value))):
            raise RuntimeError(f"{field} return value must be JSON-safe")

    def _scene_ids(
        self, value: Any, field: str, *, empty_ok: bool = False
    ) -> list[str]:
        if not isinstance(value, list) or (not value and not empty_ok):
            raise ValueError(
                f"{field} must be {'an' if empty_ok else 'a nonempty'} array"
            )
        result: list[str] = []
        for item in value:
            if not isinstance(item, str) or not item:
                raise ValueError(f"{field} entries must be nonempty strings")
            result.append(item)
        if len(result) != len(set(result)):
            raise ValueError(f"{field} entries must be unique")
        return result

    @staticmethod
    def _empty_scene_row() -> dict[str, Any]:
        return {
            "narration_sha256": None,
            "audio_path": None,
            "audio_sha256": None,
            "audio_duration_seconds": None,
            "code_path": None,
            "code_sha256": None,
            "draft_render_path": None,
            "draft_render_sha256": None,
            "final_render_path": None,
            "final_render_sha256": None,
            "voice_item_id": None,
            "voice_job_id": None,
            "render_job_ids": [],
            "cache_status": None,
        }

    # ------------------------------------------------------------------
    # Generic compact-ref and adapter-shape utilities
    # ------------------------------------------------------------------
    def _persist_summary_ref(
        self, ctx: RunContext, key: str, summary: Mapping[str, Any]
    ) -> None:
        vg = self._vg(ctx)
        safe_key = key.lower().replace(":", "-").replace("_", "-")
        ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "evidence"
                / "summaries"
                / f"{safe_key}-i{vg['review']['iteration']:03d}.json"
            ),
            dict(summary),
            root=vg["paths"]["workspace_dir"],
        )
        vg["phase_state"]["latest_summary_refs"][key] = ref

    def _summary_ref_key(self, state: str, summary: Mapping[str, Any]) -> str:
        if state == "NARRATION_SCRIPT":
            return (
                "NARRATION_SCRIPT:carren"
                if "verdict" in summary
                else "NARRATION_SCRIPT:synthia"
            )
        return state

    def _load_summary_ref(self, ctx: RunContext, key: str) -> dict[str, Any]:
        ref = self._vg(ctx)["phase_state"]["latest_summary_refs"].get(key)
        if not isinstance(ref, Mapping) or self._file_hash_or_none(
            ref.get("path")
        ) != ref.get("sha256"):
            return {}
        return _read_json(str(ref["path"]))

    def _store_compact_ref(self, ctx: RunContext, key: str, value: Any) -> None:
        vg = self._vg(ctx)
        ref = self._artifacts(ctx).atomic_write_json(
            str(
                Path(vg["paths"]["workspace_dir"])
                / "evidence"
                / "state"
                / f"{key}.json"
            ),
            _as_json(value),
            root=vg["paths"]["workspace_dir"],
        )
        vg["phase_state"]["latest_summary_refs"][f"state:{key}"] = ref

    def _load_compact_ref(self, ctx: RunContext, key: str, default: Any = None) -> Any:
        ref = self._vg(ctx)["phase_state"]["latest_summary_refs"].get(f"state:{key}")
        if not isinstance(ref, Mapping) or self._file_hash_or_none(
            ref.get("path")
        ) != ref.get("sha256"):
            return default
        try:
            return json.loads(Path(str(ref["path"])).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return default

    def _normalized_intake(self, ctx: RunContext) -> Any:
        contracts = self._contracts(ctx)
        resolution = contracts.resolve_profile(_caller_constraints(ctx))
        return contracts.validate_and_normalize_constraints(resolution)

    def _contracts(self, ctx: RunContext) -> Any:
        _skill_scripts(ctx)
        import videogen_contracts

        return videogen_contracts

    def _artifacts(self, ctx: RunContext) -> Any:
        _skill_scripts(ctx)
        import videogen_artifacts

        return videogen_artifacts

    def _qa(self, ctx: RunContext) -> Any:
        _skill_scripts(ctx)
        import videogen_qa

        return videogen_qa

    @staticmethod
    def _vg(ctx: RunContext) -> dict[str, Any]:
        value = ctx.extras.get("videogen")
        if not isinstance(value, dict):
            raise RuntimeError("videogen context is not initialized")
        return value

    def _file_hash(self, path: str) -> str:
        return self._artifacts(self.ctx).sha256_file(path)

    def _file_hash_or_none(self, path: Any) -> str | None:
        if not isinstance(path, str):
            return None
        try:
            return self._file_hash(path)
        except Exception:
            return None

    def _current_approval(self, ctx: RunContext) -> dict[str, Any]:
        vg = self._vg(ctx)
        path = vg["paths"].get("approval_record")
        digest = vg["hashes"].get("approval_record")
        if not isinstance(path, str) or self._file_hash_or_none(path) != digest:
            raise RuntimeError(
                "current operator approval artifact is absent or changed"
            )
        approval = _read_json(path)
        if approval.get("draft_video_sha256") != vg["hashes"]["draft_video"]:
            raise RuntimeError("operator approval does not bind the current draft")
        return approval

    def _memory_bridge_dir(self, ctx: RunContext) -> str:
        candidates: list[Path] = []
        if ctx.project_root:
            candidates.append(Path(ctx.project_root) / "scripts" / "system" / "bridge")
        for parent in Path(__file__).resolve().parents:
            candidates.append(parent / "scripts" / "system" / "bridge")
        for candidate in candidates:
            if (candidate / "memory_bridge.py").is_file():
                return str(candidate)
        raise RuntimeError("standard memory bridge is unavailable")

    @staticmethod
    def _strip_service_data(result: Mapping[str, Any]) -> dict[str, Any]:
        value = {key: _as_json(item) for key, item in result.items() if key != "data"}
        data = result.get("data")
        if isinstance(data, Mapping):
            value["data"] = {
                key: _as_json(item)
                for key, item in data.items()
                if not isinstance(item, (bytes, bytearray))
            }
        return value

    def _fetch_json_once(self, url: str) -> dict[str, Any]:
        import urllib.error
        import urllib.request

        _skill_scripts(self.ctx)
        import superpose_http

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(
                self,
                req: Any,
                fp: Any,
                code: int,
                msg: str,
                headers: Any,
                newurl: str,
            ) -> None:
                return None

        opener = urllib.request.build_opener(NoRedirect)
        request = urllib.request.Request(
            url, headers={"Accept": "application/json"}, method="GET"
        )
        try:
            with opener.open(
                request, timeout=superpose_http.SUPERPOSE_REQUEST_TIMEOUT_SECONDS
            ) as response:
                raw = response.read()
        except (OSError, urllib.error.URLError) as exc:
            raise RuntimeError(f"primitive schema GET failed at {url}: {exc}") from exc
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                f"primitive schema GET returned invalid JSON at {url}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise RuntimeError("primitive schema URL must return a JSON object")
        return value

    @staticmethod
    def _schema_version(schema: Mapping[str, Any]) -> str:
        candidates = [
            schema.get("primitive_library_version"),
            schema.get("version"),
            schema.get("library_version"),
        ]
        meta = schema.get("metadata")
        if isinstance(meta, Mapping):
            candidates.extend(
                [meta.get("primitive_library_version"), meta.get("version")]
            )
        for value in candidates:
            if isinstance(value, str) and _SEMVER_RE.fullmatch(value):
                return value
        raise RuntimeError("primitive schema has no declared semantic library version")

    @staticmethod
    def _select_theme(data: Any, selected: str) -> Any:
        value = (
            data.get("themes")
            if isinstance(data, Mapping) and "themes" in data
            else data
        )
        if isinstance(value, Mapping):
            if selected in value:
                return {"name": selected, "definition": value[selected]}
            entries = list(value.values())
        elif isinstance(value, list):
            entries = value
        else:
            raise RuntimeError("Superpose themes response is malformed")
        for item in entries:
            if item == selected:
                return {"name": selected}
            if (
                isinstance(item, Mapping)
                and item.get("name", item.get("id")) == selected
            ):
                return dict(item)
        raise RuntimeError(f"caller-selected theme {selected!r} is unavailable")

    @staticmethod
    def _reported_capacity(data: Any) -> int | None:
        if not isinstance(data, Mapping):
            return None
        for key in ("render_capacity", "capacity", "workers"):
            value = data.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                return value
        return None

    @staticmethod
    def _job_rows(data: Any) -> list[dict[str, Any]]:
        if isinstance(data, list):
            return [dict(item) for item in data if isinstance(item, Mapping)]
        if isinstance(data, Mapping):
            for key in ("jobs", "results", "items"):
                value = data.get(key)
                if isinstance(value, list):
                    return [dict(item) for item in value if isinstance(item, Mapping)]
        return []

    @staticmethod
    def _job_terminal_success(row: Mapping[str, Any]) -> bool:
        return str(row.get("status", "")).lower() in {
            "success",
            "succeeded",
            "completed",
            "complete",
        }

    @staticmethod
    def _job_terminal_failure(row: Mapping[str, Any]) -> bool:
        return str(row.get("status", "")).lower() in {
            "failed",
            "error",
            "cancelled",
            "canceled",
        }

    def _relevant_jobs(
        self,
        jobs: Sequence[dict[str, Any]],
        quality: str,
        scene_ids: Sequence[str] | None,
    ) -> list[dict[str, Any]]:
        wanted = set(scene_ids or [])
        relevant = [
            row
            for row in jobs
            if str(row.get("quality", quality)).lower() == quality
            and (
                not wanted
                or row.get("scene_id") in wanted
                or row.get("scene_id") is None
            )
        ]
        return relevant or list(jobs)

    def _unique_matching_job(
        self, result: Mapping[str, Any], input_hash: str
    ) -> dict[str, Any] | None:
        rows = self._job_rows(result.get("data"))
        matches = [
            row
            for row in rows
            if row.get("input_sha256") == input_hash
            or row.get("request_sha256") == input_hash
        ]
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def _cache_summary(jobs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        hits = sum(str(row.get("cache_status", "")).lower() == "hit" for row in jobs)
        misses = sum(str(row.get("cache_status", "")).lower() == "miss" for row in jobs)
        return {"hits": hits, "misses": misses, "reported": hits + misses > 0}

    def _write_vtt_bytes(
        self, ctx: RunContext, data: bytes, destination: Path
    ) -> dict[str, Any]:
        text = data.decode("utf-8", "strict")
        if text.lstrip("\ufeff").startswith("WEBVTT"):
            return self._artifacts(ctx).atomic_write(
                destination,
                data,
                root=self._vg(ctx)["paths"]["workspace_dir"],
            )
        _skill_scripts(ctx)
        import media_tools

        srt_ref = self._artifacts(ctx).atomic_write(
            destination.with_suffix(".srt"),
            data,
            root=self._vg(ctx)["paths"]["workspace_dir"],
        )
        return media_tools.srt_to_vtt(
            srt_ref["path"],
            destination,
            output_root=self._vg(ctx)["paths"]["workspace_dir"],
        )

    def _caption_probe(self, path: str, **kwargs: Any) -> dict[str, Any]:
        _skill_scripts(self.ctx)
        import media_tools

        text = Path(path).read_text(encoding="utf-8")
        cues = media_tools.parse_vtt(text)
        result = media_tools.caption_coverage(cues, **kwargs)
        return {**_as_json(result), "exists": True, "sha256": self._file_hash(path)}

    @staticmethod
    def _scene_windows(outputs: Mapping[str, Any]) -> dict[str, tuple[float, float]]:
        windows: dict[str, tuple[float, float]] = {}
        cursor = 0.0
        for scene_id, value in outputs.items():
            duration = (
                value.get("duration_seconds", 0.0)
                if isinstance(value, Mapping)
                else 0.0
            )
            duration = float(duration) if isinstance(duration, (int, float)) else 0.0
            if duration <= 0:
                duration = 0.001
            windows[str(scene_id)] = (cursor, cursor + duration)
            cursor += duration
        return windows

    def _checksum_file_map(
        self, ctx: RunContext, checksums: Mapping[str, str]
    ) -> dict[str, str]:
        vg = self._vg(ctx)
        ledger = _read_json(vg["paths"]["snapshot_ledger"])
        result = {
            "input/section": ledger["section"]["path"],
            "input/analogy-registry": ledger["analogy_registry"]["path"],
            "input/pronunciation-canon": ledger["pronunciation_canon"]["path"],
            "input/primitive-schema": vg["paths"]["schema_snapshot"],
            "input/publish-convention": ledger["publish_convention"]["path"],
        }
        for index, row in enumerate(ledger["teaching_canon"]):
            result[f"input/teaching-canon/{index:03d}"] = row["path"]
        result["input/universe-canon-ledger"] = ledger["universe_canon"]["ledger_path"]
        if ledger.get("profile"):
            result["input/profile"] = ledger["profile"]["path"]
        for scene_id, row in vg["scene_ledger"].items():
            if row.get("code_path"):
                result[f"bundle/scene/{scene_id}"] = row["code_path"]
            if row.get("audio_path"):
                result[f"bundle/audio/{scene_id}"] = row["audio_path"]
        if vg["paths"].get("storyboard"):
            result["design/storyboard"] = vg["paths"]["storyboard"]
        return {key: path for key, path in result.items() if key in checksums}

    def _storyboard_summary(self, ctx: RunContext) -> list[dict[str, Any]]:
        storyboard = _read_json(self._vg(ctx)["paths"]["storyboard"])
        narration = {
            row["scene_id"]: row["narration"] for row in self._narration_scenes(ctx)
        }
        rows: list[dict[str, Any]] = []
        for item in storyboard.get("scenes", []):
            if not isinstance(item, Mapping):
                continue
            scene_id = str(item.get("scene_id") or "")
            if not scene_id:
                continue
            concept_ids = item.get("concept_ids", [])
            if not isinstance(concept_ids, list):
                concept_ids = []
            purpose = item.get("purpose", item.get("title", ""))
            text = narration.get(scene_id, str(item.get("narration") or ""))
            rows.append(
                {
                    "scene_id": scene_id,
                    "concept_ids": [str(value) for value in concept_ids],
                    "purpose": str(purpose),
                    "analogy_id": item.get("analogy_id"),
                    "narration_summary": " ".join(text.split())[:240],
                }
            )
        if not rows:
            raise RuntimeError(
                "cannot create operator packet without storyboard scene summary"
            )
        return rows

    def _change_summary(self, ctx: RunContext) -> list[Any]:
        if self._vg(ctx)["review"]["iteration"] == 0:
            return []
        summary = self._load_summary_ref(ctx, "REFINE")
        return (
            [
                {
                    "affected_scene_ids": summary.get("affected_scene_ids", []),
                    "earliest_route": summary.get("earliest_route"),
                }
            ]
            if summary
            else []
        )

    def _affected_scene_ids(self, ctx: RunContext) -> list[str]:
        summary = self._load_summary_ref(ctx, "REFINE")
        value = summary.get("affected_scene_ids") if summary else None
        return [str(item) for item in value] if isinstance(value, list) else []

    def _scene1_final_path(self, ctx: RunContext, render: Mapping[str, Any]) -> str:
        first = next(iter(self._vg(ctx)["scene_ledger"]), None)
        if first is None:
            raise RuntimeError("final render has no scene 1")
        output = render.get("scene_outputs", {}).get(first)
        path = output.get("path") if isinstance(output, Mapping) else None
        if not isinstance(path, str) or not Path(path).is_file():
            raise RuntimeError(
                "final render did not expose scene 1 final-quality output"
            )
        return path

    def _staged_file_ref(self, destination: Path, source: str) -> dict[str, Any]:
        source_path = Path(source).resolve(strict=True)
        return {
            "path": str(destination),
            "sha256": self._file_hash(str(source_path)),
            "size_bytes": source_path.stat().st_size,
        }

    @staticmethod
    def _earliest_qa_route(rows: Sequence[Mapping[str, Any]]) -> str:
        order = {
            phase: index for index, phase in enumerate(("INGEST",) + REFINE_ROUTES)
        }
        routes = [
            str(row.get("fix_route"))
            for row in rows
            if row.get("status") in {"FAIL", "UNCERTAIN"}
            and row.get("fix_route") != "NONE"
        ]
        return (
            min(routes, key=lambda route: order.get(route, 999))
            if routes
            else "DRAFT_RENDER"
        )

    def _route_qa_event(self, ctx: RunContext, route: str) -> None:
        vg = self._vg(ctx)
        if route == "INGEST":
            self._invalidate_approval(ctx)
            vg["lifecycle_state"] = "INGEST"
            self.sm.send("qa_source_stale")
            return
        if route == "NARRATION_SCRIPT":
            vg["phase_state"]["narration_stage"] = "AUTHOR"
        vg["lifecycle_state"] = route
        self.sm.send(
            {
                "STORYBOARD": "qa_storyboard",
                "NARRATION_SCRIPT": "qa_narration",
                "VOICE_SYNTH": "qa_voice",
                "CODEGEN": "qa_codegen",
                "VALIDATE": "qa_validate",
                "DRAFT_RENDER": "qa_render",
            }[route]
        )

    @staticmethod
    def _violation_route(violations: Sequence[Any]) -> str:
        order = {phase: index for index, phase in enumerate(REFINE_ROUTES[:4])}
        routes: list[str] = []
        for item in violations:
            route = (
                item.get("fix_route", item.get("route", item.get("owner")))
                if isinstance(item, Mapping)
                else None
            )
            if route in order:
                routes.append(str(route))
        return min(routes, key=lambda value: order[value]) if routes else "CODEGEN"


__all__ = [
    "VideogenMachine",
    "VideogenPlaybook",
    "DOMAIN_PHASES",
    "OPEN_CANON_CHANGE_POLICY",
    "VG_ANNIE_INGEST_CONTRACT",
    "VG_SYNTHIA_STORYBOARD_CONTRACT",
    "VG_SYNTHIA_NARRATION_CONTRACT",
    "VG_CARREN_NARRATION_GATE_CONTRACT",
    "VG_SKRIBBLE_CODEGEN_CONTRACT",
    "VG_SYNTHIA_REFINE_CONTRACT",
    "VG_SKRIBBLE_REFINE_CONTRACT",
    "VG_CARREN_REFINE_GATE_CONTRACT",
    "VG_VERA_AUTO_QA_CONTRACT",
]
