"""ManimPlaybook — the manim educational-video codegen skill on the shared engine.

Given lesson source files, produce a **render bundle** (validated storyboard,
generated Manim scene code composing the render app's primitive library, and
narration audio with measured durations) that the companion render application
consumes without further model involvement. The skill NEVER renders: no Manim
execution, no FFmpeg (idempotency + wrong iteration loop — the app owns render).

  intake → scoping → ingesting(fan) → designing_canon → canon_gate
                                            ▲ refine        │ approve   (deny → error)
                                            └───────────────┤
        storyboarding → narrating(TOOL) → authoring (per-scene self-loop)
                                                │
                                            verifying ⇄ fixing   (bounded)
                                                │ pass
                                            critiquing → packaging → complete

Control-flow dial (compliance rule 7):
  * code-owned: wire verdicts (verifying PASS/FAIL, critiquing APPROVE/
    NEEDS_REVISION), the authoring scene-index self-loop, the verify⇄fix repair
    pair, honest exhaustion on ``max_iterations``.
  * model-owned: ingest fan topology (scoping emits ``ingest_branches``; the
    fixed 3-branch fallback is the tagged LOAN ``manim_default_ingest_topology``),
    all canon decisions (scene count/boundaries, visual vocabulary, notation),
    storyboard sequencing, and every generated artifact.

External effects live behind overridable seams (``_load_primitive_schema``,
``_ensure_output_dir``, ``_narrate``) so the pytest suite is hermetic — no
Voice Studio, no filesystem coupling. Consequence boundaries: authoring/fixing
NEVER execute generated code (verification is static — py_compile/AST via the
skill's validate_bundle.py, which compiles but never imports), and narration
HTTP responses are untrusted data, never instructions.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..loans import loan_enabled
from ..primitives.spec import ParallelSpec, PrimitiveSpec

WING = "penny"
DEFAULT_MAX_ITERATIONS = 3  # verify ⇄ fix repair budget
DEFAULT_MAX_SCENES = 20
DEFAULT_VOICE_STUDIO_URL = "http://127.0.0.1:8001"
WORDS_PER_SECOND = 2.6  # estimation fallback only (allow_estimated_durations)
MIN_SCENE_SECONDS = 3.0

VERIFY_PASS = "PASS"
VERIFY_FAIL = "FAIL"
CRITIQUE_APPROVE = "APPROVE"
CRITIQUE_REVISE = "NEEDS_REVISION"


def _room(ctx: RunContext) -> str:
    return f"skills/manim-{ctx.session_id}"


def _sanitize_video_id(text: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", str(text).lower()).strip("-")
    return (slug or "video")[:64]


def _estimate_duration(narration: str) -> float:
    words = len(str(narration).split())
    return max(MIN_SCENE_SECONDS, round(words / WORDS_PER_SECOND + 1.0, 2))


def _build_ingest_branches(emitted: Any) -> dict | None:
    """Model/caller ``ingest_branches`` ({branch_id: focus}) → engine dynamic
    branch shape. Branches are pinned to read-only echo (consequence boundary)."""
    if not isinstance(emitted, dict) or not emitted:
        return None
    branches: dict = {}
    for bid, val in emitted.items():
        focus = val if isinstance(val, str) else (val.get("focus") if isinstance(val, dict) else "")
        focus = str(focus or "").strip()
        if not focus:
            continue
        sid = str(bid).strip() or f"branch{len(branches)}"
        branches[sid] = {
            "agent": "echo",
            "name": f"MANIM_INGEST_{sid.upper()}",
            "task_hint": focus,
            "summary_contract": _INGEST_C_JSON,
        }
    return branches or None


# ---------------------------------------------------------------------------
# FSM
# ---------------------------------------------------------------------------


class ManimMachine(StateMachine):
    intake = State(initial=True)
    scoping = State()          # echo: quick scan -> emit ingest topology
    ingesting = State()        # parallel echo fan (model-emitted branches)
    designing_canon = State()  # annie: THE global-decision state
    canon_gate = State()       # HITL: approve before the expensive span
    storyboarding = State()    # piper: sequence scenes/beats against the canon
    narrating = State()        # TOOL: Voice Studio synth + measured durations
    authoring = State()        # skribble: one scene per pass (self-loop)
    verifying = State()        # vera: static evidence-gated checks
    fixing = State()           # skribble: repair; ALWAYS re-verifies
    critiquing = State()       # carren: pedagogy/pacing judgment
    packaging = State()        # synthia: manifest + report + bundle assembly
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_scope = intake.to(scoping)
    start_ingest = intake.to(ingesting)  # caller-supplied topology skips scoping
    scope_done = scoping.to(ingesting)
    ingest_done = ingesting.to(designing_canon)
    design_done = designing_canon.to(canon_gate)
    gate_approve = canon_gate.to(storyboarding)
    gate_refine = canon_gate.to(designing_canon)
    gate_deny = canon_gate.to(error)
    storyboard_done = storyboarding.to(narrating)
    narrate_done = narrating.to(authoring)
    author_next = authoring.to.itself()
    author_done = authoring.to(verifying)
    verify_fix = verifying.to(fixing)
    verify_clean = verifying.to(critiquing)
    verify_exhausted = verifying.to(packaging)  # honest exhaustion; met=False
    fix_done = fixing.to(verifying)
    critique_fix = critiquing.to(fixing)
    critique_pass = critiquing.to(packaging)
    critique_exhausted = critiquing.to(packaging)
    package_done = packaging.to(complete)

    to_unknown = (
        scoping.to(unknown)
        | ingesting.to(unknown)
        | designing_canon.to(unknown)
        | storyboarding.to(unknown)
        | authoring.to(unknown)
        | verifying.to(unknown)
        | fixing.to(unknown)
        | critiquing.to(unknown)
        | packaging.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(designing_canon)
    abort = (
        intake.to(error)
        | scoping.to(error)
        | ingesting.to(error)
        | designing_canon.to(error)
        | canon_gate.to(error)
        | storyboarding.to(error)
        | narrating.to(error)
        | authoring.to(error)
        | verifying.to(error)
        | fixing.to(error)
        | critiquing.to(error)
        | packaging.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------


def _c(required: dict, optional: dict | None = None, evidence: tuple[str, ...] = ()) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        contract["evidence"] = evidence
    return contract


_COMMON_OPT = {
    "mempalace_drawer": str,
    "needs_clarification": bool,
    "clarifying_questions": list,
}

_INGEST_C = _c(
    {"ingest_complete": bool, "confidence": str},
    {"concepts": list, "equations": list, "notes": str, **_COMMON_OPT},
)
_INGEST_C_JSON = {
    "required": {"ingest_complete": "bool", "confidence": "str"},
    "optional": {"concepts": "list", "equations": "list", "notes": "str"},
}

MANIM_SCOPE = PrimitiveSpec(
    "MANIM_SCOPE",
    "echo",
    _c(
        {"scope_complete": bool, "ingest_branches": dict, "confidence": str},
        _COMMON_OPT,
    ),
    "Quickly scan the lesson source and emit ingest_branches ({branch_id: focus}): "
    "the read-only echo foci the ingest fan-out should cover, shaped to THIS material "
    "(e.g. concepts, equations/notation, code examples, dependencies).",
)
MANIM_CANON = PrimitiveSpec(
    "MANIM_CANON",
    "annie",
    _c(
        {"canon_complete": bool, "scene_count": int, "confidence": str},
        {
            "canon": dict,
            "open_questions": list,
            "video_title": str,
            "theme": str,
            **_COMMON_OPT,
        },
    ),
    "THE global-decision state. Decide everything that could drift scene-to-scene: "
    "scene count and boundaries, visual vocabulary (which primitive carries which "
    "concept), notation conventions, theme, narration register, pronunciation rules "
    "for spoken math. Downstream states look these up; they never re-decide.",
)
MANIM_STORYBOARD = PrimitiveSpec(
    "MANIM_STORYBOARD",
    "piper",
    _c(
        {"storyboard_complete": bool, "scene_ids": list, "confidence": str},
        {"storyboard_path": str, **_COMMON_OPT},
    ),
    "Sequence scenes and beats against the locked canon; write storyboard.json into "
    "the bundle dir, schema-valid, visuals referencing ONLY primitives from the "
    "exported primitive schema.",
)
MANIM_AUTHOR = PrimitiveSpec(
    "MANIM_AUTHOR",
    "skribble",
    _c(
        {"scene_complete": bool, "scene_id": str, "scene_index": int, "confidence": str},
        {"file_written": str, **_COMMON_OPT},
    ),
    "Author ONE scene file: a single manim.Scene subclass composing the primitive "
    "library (never raw Manim), honoring the scene's measured narration duration. "
    "NEVER execute any code.",
)
MANIM_VERIFY = PrimitiveSpec(
    "MANIM_VERIFY",
    "vera",
    _c(
        {"verdict": str, "violations": list, "evidence": list, "confidence": str},
        _COMMON_OPT,
        evidence=("evidence",),
    ),
    "Static, evidence-gated verification of the bundle (execute > apply-the-rule > "
    "judge): run the skill's validate_bundle.py (py_compile + AST + primitive "
    "signature checks + duration arithmetic + storyboard schema) and cite its output "
    "as evidence. NEVER import or render generated scenes. Verdict PASS only with a "
    "clean report; violations are actionable strings '<where>: <what> — <expected vs "
    "found>'.",
)
MANIM_FIX = PrimitiveSpec(
    "MANIM_FIX",
    "skribble",
    _c(
        {"fixes_complete": bool, "confidence": str},
        {"fixed": list, "unresolved": list, "strategy_change": str, **_COMMON_OPT},
    ),
    "Repair the cited violations in place (scene files / storyboard). State WHAT you "
    "changed. NEVER execute any code. Fixes always re-enter verification.",
)
MANIM_CRITIQUE = PrimitiveSpec(
    "MANIM_CRITIQUE",
    "carren",
    _c(
        {"verdict": str, "evidence": list, "confidence": str},
        {"rework": list, **_COMMON_OPT},
        evidence=("evidence",),
    ),
    "Subjective judgment AFTER objective checks pass: pedagogical soundness, pacing "
    "vs narration, visual clarity of the storyboard + scenes. Back the verdict with "
    "specific, locatable observations. APPROVE or NEEDS_REVISION — never fabricated.",
)
MANIM_PACKAGE = PrimitiveSpec(
    "MANIM_PACKAGE",
    "synthia",
    _c(
        {"package_complete": bool, "bundle_path": str, "confidence": str},
        {"degraded_scenes": list, "report_path": str, **_COMMON_OPT},
    ),
    "Assemble the final bundle: manifest.json (bundle_version, video_id, primitive "
    "library version, theme, degraded scene flags) and report.md (what was generated, "
    "what is degraded, open questions).",
)

# Fallback ingest topology — tagged LOAN ``manim_default_ingest_topology``:
# used only when scoping emits no valid topology AND the loan is enabled.
MANIM_INGEST_DEFAULT = ParallelSpec(
    branches={
        "concepts": PrimitiveSpec(
            "MANIM_INGEST_CONCEPTS", "echo", _INGEST_C,
            "concept inventory: ideas taught, their order and dependencies",
        ),
        "equations": PrimitiveSpec(
            "MANIM_INGEST_EQUATIONS", "echo", _INGEST_C,
            "equations and notation: every formula, symbol conventions, derivations",
        ),
        "code": PrimitiveSpec(
            "MANIM_INGEST_CODE", "echo", _INGEST_C,
            "code examples and figures: runnable snippets, diagrams, outputs",
        ),
    }
)


# ---------------------------------------------------------------------------
# Playbook
# ---------------------------------------------------------------------------


class ManimPlaybook(BasePlaybook):
    NAME = "manim"
    machine_cls = ManimMachine
    STEP_CAP = 120  # per-scene self-loop needs headroom
    TOOL_STATES = frozenset({"narrating"})
    GATE_STATES = frozenset({"canon_gate"})
    # Fallback fan topology for ingesting — active only when scoping emits no
    # topology AND the ``manim_default_ingest_topology`` LOAN is enabled.
    PARALLEL_BY_STATE = {"ingesting": MANIM_INGEST_DEFAULT}
    PRIMITIVE_BY_STATE = {
        "scoping": MANIM_SCOPE,
        "designing_canon": MANIM_CANON,
        "storyboarding": MANIM_STORYBOARD,
        "authoring": MANIM_AUTHOR,
        "verifying": MANIM_VERIFY,
        "fixing": MANIM_FIX,
        "critiquing": MANIM_CRITIQUE,
        "packaging": MANIM_PACKAGE,
    }
    ESCALATABLE_STATES = frozenset(
        {"scoping", "designing_canon", "storyboarding", "authoring", "verifying",
         "fixing", "critiquing", "packaging"}
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        constraints = ctx.constraints or {}
        if "max_iterations" not in constraints:
            ctx.max_iterations = DEFAULT_MAX_ITERATIONS

        lesson_path = str(constraints.get("lesson_path", "")).strip()
        if not lesson_path:
            raise ValueError(
                "manim skill requires constraints.lesson_path (directory or file of "
                "lesson source material)"
            )
        output_dir = str(constraints.get("output_dir", "")).strip()
        if not output_dir:
            raise ValueError(
                "manim skill requires constraints.output_dir (where the render bundle "
                "is written)"
            )
        schema_path = str(constraints.get("primitive_schema", "")).strip()
        if not schema_path:
            raise ValueError(
                "manim skill requires constraints.primitive_schema (path to the render "
                "app's exported primitive-library schema JSON — GET /api/primitives/schema)"
            )

        mm = ctx.extras.setdefault("manim", {})
        mm["lesson_path"] = lesson_path
        mm["warnings"] = []

        schema = self._load_primitive_schema(ctx, schema_path)
        mm["primitive_schema_path"] = schema_path
        mm["primitive_version"] = str(schema.get("version", ""))
        mm["primitive_names"] = sorted(
            str(p.get("name", "")) for p in schema.get("primitives", [])
        )
        mm["theme_names"] = sorted((schema.get("themes") or {}).keys())

        video_id = _sanitize_video_id(
            constraints.get("video_id") or Path(lesson_path).stem or "video"
        )
        mm["video_id"] = video_id
        mm["output_dir"] = self._ensure_output_dir(ctx, output_dir)
        mm["bundle_dir"] = str(Path(mm["output_dir"]) / video_id)

        try:
            max_scenes = int(constraints.get("max_scenes", DEFAULT_MAX_SCENES))
        except (TypeError, ValueError):
            max_scenes = DEFAULT_MAX_SCENES
        mm["max_scenes"] = max(1, min(max_scenes, 60))
        mm["theme"] = str(constraints.get("theme", "")) or None
        mm["voice_id"] = str(constraints.get("voice_id", "")) or None
        mm["allow_estimated_durations"] = bool(constraints.get("allow_estimated_durations"))

        ctx.success_criteria = [
            f"bundle at {mm['bundle_dir']}",
            "storyboard schema-valid",
            "every scene passes static verification or is flagged degraded",
        ]

        caller_topology = _build_ingest_branches(constraints.get("ingest_branches"))
        if caller_topology:
            ctx.extras.setdefault("dynamic_branches", {})["ingesting"] = caller_topology
            self.sm.send("start_ingest")
            return "ingesting"
        self.sm.send("start_scope")
        return "scoping"

    # -- seams (overridden in tests) ---------------------------------------
    def _load_primitive_schema(self, ctx: RunContext, schema_path: str) -> dict:
        """Read + parse the exported primitive schema. Raises an actionable error
        when missing/invalid — fail-fast before any agent runs."""
        path = Path(schema_path).expanduser()
        if not path.is_file():
            raise RuntimeError(
                f"primitive schema not found at '{path}'. Export it from the render "
                "app (GET /api/primitives/schema) and pass its path as "
                "constraints.primitive_schema."
            )
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"primitive schema at '{path}' is unreadable: {exc}") from exc
        if not schema.get("primitives"):
            raise RuntimeError(
                f"primitive schema at '{path}' lists no primitives — wrong file?"
            )
        return schema

    def _ensure_output_dir(self, ctx: RunContext, requested: str) -> str:
        """Resolve + create a writable output dir; never inside the project tree."""
        path = str(requested).strip()
        root = ctx.project_root or ""
        if root and os.path.abspath(path).startswith(os.path.abspath(root)):
            path = f"/tmp/manim-{ctx.session_id}"
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as exc:
            raise RuntimeError(f"output dir '{path}' is not creatable: {exc}") from exc
        if not os.access(path, os.W_OK):
            raise RuntimeError(f"output dir '{path}' is not writable")
        return path

    def _narrate(self, ctx: RunContext, scenes: list[dict], voice_id: str | None) -> dict:
        """THE narration seam. Default: Voice Studio over loopback HTTP via the
        skill's voice_client module; fetches each scene's WAV into the bundle
        (durable store) and returns {scene_id: duration_seconds}. Tests override.

        Raises RuntimeError with an actionable message when Voice Studio is
        unreachable (unless allow_estimated_durations, handled by the caller)."""
        scripts = os.path.join(
            ctx.project_root or os.getcwd(), ".pi", "skills", "manim", "scripts"
        )
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import voice_client  # lazy: skill-dir module

        mm = ctx.extras["manim"]
        base_url = str(
            (ctx.constraints or {}).get("voice_studio_url", DEFAULT_VOICE_STUDIO_URL)
        )
        client = voice_client.VoiceStudioClient(base_url)
        audio_dir = Path(mm["bundle_dir"]) / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        durations: dict[str, float] = {}
        for scene in scenes:
            sid = str(scene.get("scene_id", ""))
            wav = audio_dir / f"{sid}.wav"
            durations[sid] = client.synthesize(
                text=str(scene.get("narration", "")), voice_id=voice_id, dest=wav
            )
        return durations

    # -- TOOL state: narrating --------------------------------------------
    def run_tool_state(self, state: str, ctx: RunContext) -> None:
        if state != "narrating":  # pragma: no cover - guarded by TOOL_STATES
            raise RuntimeError(f"no tool runner for state '{state}'")
        self._run_narrating(ctx)
        self.sm.send("narrate_done")

    def _run_narrating(self, ctx: RunContext) -> None:
        """Audio-first synchronization: synthesize (or estimate) narration BEFORE
        authoring, and attach measured durations to the storyboard as hard timing
        constraints."""
        mm = ctx.extras["manim"]
        storyboard_path = Path(mm["bundle_dir"]) / "storyboard.json"
        try:
            storyboard = json.loads(storyboard_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                f"storyboarding did not leave a readable storyboard.json at "
                f"'{storyboard_path}': {exc}"
            ) from exc
        scenes = list(storyboard.get("scenes", []))

        estimated = False
        try:
            durations = self._narrate(ctx, scenes, mm.get("voice_id"))
        except RuntimeError as exc:
            if not mm.get("allow_estimated_durations"):
                raise RuntimeError(
                    f"narration synthesis failed: {exc}. Start Voice Studio, or pass "
                    "constraints.allow_estimated_durations=true to proceed with "
                    "word-count duration estimates (scenes will be flagged degraded)."
                ) from exc
            estimated = True
            durations = {
                str(s.get("scene_id", "")): _estimate_duration(s.get("narration", ""))
                for s in scenes
            }
            mm["warnings"].append(f"narration estimated, not synthesized: {exc}")

        for scene in scenes:
            sid = str(scene.get("scene_id", ""))
            scene["measured_duration"] = durations.get(sid)
            if estimated:
                scene["narration_estimated"] = True
        storyboard["scenes"] = scenes
        storyboard_path.write_text(
            json.dumps(storyboard, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        mm["durations"] = durations
        mm["narration_estimated"] = estimated

    # -- gate --------------------------------------------------------------
    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        mm = ctx.extras.setdefault("manim", {})
        open_qs = mm.get("open_questions") or []
        open_block = (
            "\n\n**Open questions from the designer:** " + "; ".join(str(q) for q in open_qs)
            if open_qs
            else ""
        )
        return [
            {
                "id": "canon_action",
                "label": "Approve Canon",
                "prompt": (
                    "The video canon is ready. Everything downstream (storyboard + "
                    f"{mm.get('scene_count', '?')} generated scenes + narration) builds "
                    "against it, so review before the expensive span.\n\n"
                    f"**Video:** {mm.get('video_title') or mm.get('video_id', '?')} — "
                    f"**Scenes:** {mm.get('scene_count', '?')} — "
                    f"**Theme:** {mm.get('theme') or '(designer default)'}\n\n"
                    f"Full canon is in mempalace room {_room(ctx)}."
                    f"{open_block}"
                ),
                "options": [
                    {"value": "approve", "label": "Approve",
                     "description": "Generate the storyboard, narration, and all scenes"},
                    {"value": "refine", "label": "Refine",
                     "description": "Send the canon back to design with a note"},
                    {"value": "deny", "label": "Deny",
                     "description": "Terminate the run; nothing is generated"},
                ],
                "allowOther": True,
            }
        ]

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:
        value = (
            response.get("user_response") or response.get("answer")
            if isinstance(response, dict)
            else str(response)
        ) or ""
        value = str(value).strip().lower()
        intent = self.classify_gate_intent(value)
        if intent == "approve":
            self.sm.send("gate_approve")
        elif intent == "deny":
            self.sm.send("gate_deny")
        else:
            if value != "refine" and value:
                ctx.clarification_text = value
            self.sm.send("gate_refine")

    # -- escalation --------------------------------------------------------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        mm = ctx.extras.setdefault("manim", {})
        handler = {
            "scoping": self._route_scoping,
            "ingesting": self._route_ingesting,
            "designing_canon": self._route_designing,
            "storyboarding": self._route_storyboarding,
            "authoring": self._route_authoring,
            "verifying": self._route_verifying,
            "fixing": self._route_fixing,
            "critiquing": self._route_critiquing,
            "packaging": self._route_packaging,
        }.get(state)
        if handler is None:  # pragma: no cover - guarded by PRIMITIVE membership
            raise ValueError(f"route_after: unexpected state '{state}'")
        handler(ctx, mm, summary)

    def _route_scoping(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        branches = _build_ingest_branches(summary.get("ingest_branches"))
        dyn = ctx.extras.setdefault("dynamic_branches", {})
        if branches:
            dyn["ingesting"] = branches
        elif loan_enabled("manim_default_ingest_topology"):
            dyn.pop("ingesting", None)  # falls back to PARALLEL_BY_STATE default
            mm["warnings"].append(
                "scoping emitted no ingest topology; using the default 3-branch fan (LOAN)"
            )
        else:
            raise ValueError(
                "scoping emitted no valid ingest_branches and the fallback topology "
                "loan is ablated — cannot fan out"
            )
        self.sm.send("scope_done")

    def _route_ingesting(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        branches = summary.get("branches", {})
        mm["ingest_branchcount"] = len(branches)
        incomplete = [
            bid for bid, b in branches.items() if not (b or {}).get("ingest_complete")
        ]
        if incomplete:
            mm["warnings"].append(f"ingest branches incomplete: {incomplete}")
        self.sm.send("ingest_done")

    def _route_designing(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        count = int(summary.get("scene_count") or 0)
        cap = mm.get("max_scenes", DEFAULT_MAX_SCENES)
        if count > cap:
            mm["warnings"].append(f"designer proposed {count} scenes; clamped to {cap}")
            count = cap
        mm["scene_count"] = count
        mm["canon"] = summary.get("canon") or {}
        mm["open_questions"] = summary.get("open_questions") or []
        mm["video_title"] = summary.get("video_title", "")
        theme = summary.get("theme") or mm.get("theme")
        if theme and mm.get("theme_names") and theme not in mm["theme_names"]:
            mm["warnings"].append(
                f"canon theme '{theme}' not in schema themes {mm['theme_names']}; kept anyway"
            )
        mm["theme"] = theme
        self.sm.send("design_done")

    def _route_storyboarding(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        scene_ids = [str(s) for s in (summary.get("scene_ids") or []) if str(s).strip()]
        if not scene_ids:
            raise ValueError("storyboarding emitted no scene_ids — nothing to author")
        cap = mm.get("max_scenes", DEFAULT_MAX_SCENES)
        if len(scene_ids) > cap:
            mm["warnings"].append(
                f"storyboard has {len(scene_ids)} scenes; clamped to max_scenes={cap}"
            )
            scene_ids = scene_ids[:cap]
        mm["scene_ids"] = scene_ids
        mm["authored"] = 0
        self.sm.send("storyboard_done")

    def _route_authoring(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        mm["authored"] = int(mm.get("authored", 0)) + 1
        files = mm.setdefault("files_written", [])
        if summary.get("file_written"):
            files.append(str(summary["file_written"]))
        if mm["authored"] < len(mm.get("scene_ids", [])):
            self.sm.send("author_next")
        else:
            self.sm.send("author_done")

    def _route_verifying(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        verdict = str(summary.get("verdict", "")).upper()
        if verdict not in (VERIFY_PASS, VERIFY_FAIL):
            raise ValueError(f"verifying: unknown verdict '{summary.get('verdict')}'")
        violations = [str(v) for v in (summary.get("violations") or [])]
        mm["violations"] = violations
        if verdict == VERIFY_PASS and not violations:
            mm["verified_clean"] = True
            self.sm.send("verify_clean")
            return
        if ctx.iteration + 1 < ctx.max_iterations:
            self.record_iteration(
                ctx, gaps=violations, confidence=summary.get("confidence", "")
            )
            ctx.iteration += 1
            self.sm.send("verify_fix")
        else:
            mm["verified_clean"] = False
            mm["exhausted"] = True
            mm["unresolved"] = violations
            self.sm.send("verify_exhausted")

    def _route_fixing(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        mm["last_fixed"] = summary.get("fixed") or []
        self.sm.send("fix_done")

    def _route_critiquing(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        verdict = str(summary.get("verdict", "")).upper()
        if verdict not in (CRITIQUE_APPROVE, CRITIQUE_REVISE):
            raise ValueError(f"critiquing: unknown verdict '{summary.get('verdict')}'")
        mm["critique_verdict"] = verdict
        if verdict == CRITIQUE_APPROVE:
            self.sm.send("critique_pass")
            return
        rework = [str(r) for r in (summary.get("rework") or [])]
        mm["violations"] = rework
        if ctx.iteration + 1 < ctx.max_iterations:
            self.record_iteration(ctx, gaps=rework, confidence=summary.get("confidence", ""))
            ctx.iteration += 1
            self.sm.send("critique_fix")
        else:
            mm["exhausted"] = True
            mm["unresolved"] = rework
            self.sm.send("critique_exhausted")

    def _route_packaging(self, ctx: RunContext, mm: dict, summary: dict) -> None:
        mm["packaged"] = bool(summary.get("package_complete"))
        mm["bundle_path"] = summary.get("bundle_path", mm.get("bundle_dir", ""))
        mm["degraded_scenes"] = summary.get("degraded_scenes") or []
        mm["report_path"] = summary.get("report_path", "")
        self.sm.send("package_done")

    def done_predicate(self, ctx: RunContext) -> bool:
        mm = ctx.extras.get("manim", {})
        return bool(mm.get("packaged")) and not mm.get("exhausted")

    # -- per-state skill context -------------------------------------------
    _PROMPT_BY_STATE = {
        "scoping": "echo-scope",
        "ingesting": "echo-ingest",
        "designing_canon": "annie-canon",
        "storyboarding": "piper-storyboard",
        "authoring": "skribble-author",
        "fixing": "skribble-fix",
        "verifying": "vera-verify",
        "critiquing": "carren-critique",
        "packaging": "synthia-package",
    }

    def skill_context(self, state: str, ctx: RunContext) -> str | None:
        name = self._PROMPT_BY_STATE.get(state)
        return f"assets/prompts/{name}.md" if name else None

    # -- task builders -----------------------------------------------------
    def _paths(self, ctx: RunContext) -> str:
        mm = ctx.extras.get("manim", {})
        return (
            f"Lesson source: {mm.get('lesson_path')}. Bundle dir: {mm.get('bundle_dir')}. "
            f"Primitive schema: {mm.get('primitive_schema_path')} "
            f"(library v{mm.get('primitive_version')})."
        )

    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        mm = ctx.extras.get("manim", {})
        room = _room(ctx)
        builders = {
            "scoping": lambda: (
                f"Session: {ctx.session_id}. Goal: {self._cap(ctx.goal)}. {self._paths(ctx)} "
                f"{spec.task_hint} Emit ingest_branches in your SUMMARY."
            ),
            "ingesting": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} Focus: {spec.task_hint}. "
                f"READ-ONLY: inventory your focus area across the lesson source. Write full "
                f"findings to wing={WING} room={room} with header: "
                f"{ctx.session_id} Ingest."
            ),
            "designing_canon": lambda: (
                f"Session: {ctx.session_id}. Goal: {self._cap(ctx.goal)}. {self._paths(ctx)} "
                f"Read the ingest findings in wing={WING} room={room}. {spec.task_hint} "
                f"Budget: at most {mm.get('max_scenes')} scenes"
                + (f"; requested theme: {mm['theme']}" if mm.get("theme") else "")
                + (
                    f"; target duration ≈ {ctx.constraints.get('target_duration_minutes')} min"
                    if (ctx.constraints or {}).get("target_duration_minutes")
                    else ""
                )
                + f". Available primitives: {', '.join(mm.get('primitive_names', []))}. "
                f"Available themes: {', '.join(mm.get('theme_names', []))}. "
                f"Write the full canon to wing={WING} room={room} with header: "
                f"{ctx.session_id} Canon."
            ),
            "storyboarding": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} Read the approved Canon "
                f"from wing={WING} room={room} — it is binding; never re-decide it. "
                f"{spec.task_hint} video_id: {mm.get('video_id')}. Theme: "
                f"{mm.get('theme') or '(from canon)'}. Scene count: {mm.get('scene_count')}. "
                f"Emit scene_ids (kebab-case, stable, content-derived) in your SUMMARY."
            ),
            "authoring": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} Read the Canon from "
                f"wing={WING} room={room}. Author scene index {mm.get('authored', 0)} "
                f"(zero-based) of {len(mm.get('scene_ids', []))}: "
                f"scene_id '{(mm.get('scene_ids') or ['?'])[min(mm.get('authored', 0), max(0, len(mm.get('scene_ids', [])) - 1))]}'. "
                f"{spec.task_hint} The scene's measured narration duration is in "
                f"storyboard.json (measured_duration) — your animation durations must sum "
                f"to cover it. Write scenes/<scene_id>.py (kebab→snake_case filename) in "
                f"the bundle. Emit scene_index={mm.get('authored', 0)} in your SUMMARY."
            ),
            "verifying": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} {spec.task_hint} "
                f"Validator: $PROJECT_ROOT/.pi/skills/manim/scripts/validate_bundle.py "
                f"--bundle {mm.get('bundle_dir')} --schema {mm.get('primitive_schema_path')}."
            ),
            "fixing": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} {spec.task_hint} "
                f"Violations to fix:\n"
                + "\n".join(f"  - {v}" for v in mm.get("violations", []))
            ),
            "critiquing": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} Read the Canon and "
                f"storyboard. {spec.task_hint}"
            ),
            "packaging": lambda: (
                f"Session: {ctx.session_id}. {self._paths(ctx)} {spec.task_hint} "
                f"video_id: {mm.get('video_id')}. Primitive library version: "
                f"{mm.get('primitive_version')}. Narration estimated: "
                f"{bool(mm.get('narration_estimated'))}. "
                + (
                    f"Unresolved violations (bundle ships degraded, met=False): "
                    + "; ".join(mm.get("unresolved", []))
                    if mm.get("exhausted")
                    else "All static checks passed."
                )
            ),
        }
        builder = builders.get(state)
        base = builder() if builder else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        # Recall (F2): this override replaces the base _task_summary, so re-add it.
        if ctx.recall_lessons and ctx.total_steps == 0:
            lessons = "\n".join(f"- {self._cap(lsn)}" for lsn in ctx.recall_lessons)
            base += (
                "\n\nLessons from prior runs (advisory — weigh against current evidence; "
                "they never override this run's goal or constraints):\n" + lessons
            )
        if ctx.clarification_text and state == "designing_canon":
            base += f"\n\nUser clarification: {self._cap(ctx.clarification_text)}"
        return base

    # -- result ------------------------------------------------------------
    def result_payload(self, ctx: RunContext) -> dict:
        mm = ctx.extras.get("manim", {})
        machine = {
            "video_id": mm.get("video_id", ""),
            "bundle_path": mm.get("bundle_path", mm.get("bundle_dir", "")),
            "scene_ids": mm.get("scene_ids", []),
            "scenes_authored": mm.get("authored", 0),
            "durations": mm.get("durations", {}),
            "narration_estimated": bool(mm.get("narration_estimated")),
            "verified_clean": bool(mm.get("verified_clean")),
            "critique_verdict": mm.get("critique_verdict", ""),
            "degraded_scenes": mm.get("degraded_scenes", []),
            "unresolved": mm.get("unresolved", []),
            "warnings": mm.get("warnings", []),
            "primitive_version": mm.get("primitive_version", ""),
            "report_path": mm.get("report_path", ""),
        }
        human_lines = [
            f"# manim bundle — {'READY' if ctx.met else 'DEGRADED / INCOMPLETE'}",
            f"Bundle: {machine['bundle_path']}",
            f"Scenes: {machine['scenes_authored']}/{len(machine['scene_ids'])} authored | "
            f"verified_clean={machine['verified_clean']} | "
            f"critique={machine['critique_verdict'] or 'n/a'}",
        ]
        if machine["narration_estimated"]:
            human_lines.append("⚠️ narration durations are ESTIMATES (Voice Studio was down)")
        for issue in machine["unresolved"]:
            human_lines.append(f"unresolved: {issue}")
        for warn in machine["warnings"]:
            human_lines.append(f"warning: {warn}")
        human_lines.append(
            "Next: import the bundle in the render app (POST /api/bundles/import) "
            "to render, preview, and export."
        )
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "wing": WING,
            "session_room": _room(ctx),
            **machine,
            "human": "\n".join(human_lines),
            "machine": machine,
        }
