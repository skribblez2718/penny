"""ImagegenPlaybook — the imagegen local-image-generation skill on the shared engine.

A ``BasePlaybook`` FSM that drives one image-generation run against a locally
running ComfyUI HTTP API (``http://127.0.0.1:8188``):

  intake → framing → composing → generating → critiquing
                                     ▲              │
                                     └── adjusting ─┘   (bounded revise loop)
                                                    │
                                                 presenting → complete

State roster:
  * **framing** (agent ``annie``) — interpret the request + confirm the routed
    preset and clamped candidate count. Routing itself is a DETERMINISTIC pure
    function (``route_preset``) computed at ``initial_transition`` so the 4-way
    preset matrix is testable and misroute-free; readiness (a fail-fast ComfyUI
    probe) also runs before ``framing`` so a dead service errors in the readiness
    check, never as a silent hang.
  * **composing** (agent ``synthia``) — build the wordless-negative positive/negative
    prompt pair (raw-override passthrough when the caller supplies a prompt), capped
    at ``MAX_PROMPT_CHARS`` before generating is ever reached.
  * **generating** (TOOL_STATE) — submit each candidate ONE AT A TIME (never
    concurrent), poll, fetch, write a provenance manifest. On a revise loop only the
    FAILED candidate indices are regenerated (the good ones are kept). A partial
    batch (ComfyUI dies mid-run) persists what completed + surfaces the error.
  * **critiquing** (PARALLEL vera + carren) — two independent critics; the batch
    is NEEDS_REVISION if EITHER flags an issue (never a fabricated APPROVE).
  * **adjusting** (agent ``synthia``) — propose prompt tweaks for the failed
    candidates, then regenerate only those. Bounded by ``max_iterations`` (default
    2); on exhaustion the run presents the best vera-valid candidate with
    ``met=False`` and itemized unresolved issues — honest, never a faked pass.
  * **presenting** (TOOL_STATE) — pick the best vera-valid candidate and emit the
    dual-format (human + machine) result.

External effects live behind three overridable seams (``_check_readiness``,
``_comfy_generate``, ``_ensure_output_dir``) so the full pytest suite runs with
ZERO live-service dependency (mirrors jsa's ``_domain_run`` seam). Only file paths
+ metadata ever leave the skill — raw image bytes are never stored in mempalace.
"""

from __future__ import annotations

import os
import random
import sys
from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..loans import loan_enabled
from ..primitives.spec import ParallelSpec, PrimitiveSpec

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WING = "penny"  # run metadata lives in penny wing (paths + metadata only)
DEFAULT_HOST = "127.0.0.1:8188"  # LOCKED — the SSRF allow-list default
DEFAULT_CANDIDATE_COUNT = 3  # locked correction
DEFAULT_MAX_ITERATIONS = 2  # locked correction: bounded revise loop
MAX_CANDIDATES = 10
MAX_PROMPT_CHARS = 4000
_SEED_MAX = 2**32 - 1

VERDICT_APPROVE = "APPROVE"
VERDICT_NEEDS_REVISION = "NEEDS_REVISION"
_VERDICTS = frozenset({VERDICT_APPROVE, VERDICT_NEEDS_REVISION})

# Applied to every negative prompt regardless of preset/raw override — we never
# bake text into an image (labels are an HTML/SVG overlay downstream).
WORDLESS_NEGATIVE = (
    "text, words, letters, numbers, labels, captions, typography, " "watermark, signature"
)

PRESETS: tuple[str, ...] = (
    "blog-flux-steampunk",
    "learning-qwen",
    "hero-flux",
    "general-flux",
)

# Deterministic routing heuristic keyword sets (post type -> preset).
_ROUTE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "blog-flux-steampunk",
        ("steampunk", "brass", "clockwork", "blog", "branded", "graphic-novel"),
    ),
    (
        "learning-qwen",
        (
            "lesson",
            "concept",
            "learn",
            "explain",
            "diagram",
            "flowchart",
            "teach",
            "mechanism",
            "tutorial",
            "educational",
        ),
    ),
    ("hero-flux", ("hero", "abstract", "header", "banner", "cover", "minimal")),
)


def route_preset(goal: str, requested: str | None = None) -> str:
    """Route a request to one of the 4 presets.

    An explicit valid ``requested`` preset always wins (caller-specified). The
    keyword heuristic over the goal text is a **tagged LOAN**
    (``imagegen_preset_keyword_router``): preset selection picks the generation
    model/workflow, so it is resolved before any agent runs — the router is the
    fallback. Ablated, an unspecified preset falls straight to the
    ``general-flux`` catch-all instead of keyword routing. Pure + total so the
    4-way matrix is misroute-testable without an agent.
    """
    if requested and requested in PRESETS:
        return requested
    if loan_enabled("imagegen_preset_keyword_router"):
        text = (goal or "").lower()
        for preset, keywords in _ROUTE_KEYWORDS:
            if any(word in text for word in keywords):
                return preset
    return "general-flux"


def _clamp_count(count: Any, default: int = DEFAULT_CANDIDATE_COUNT) -> tuple[int, str | None]:
    """Clamp a requested candidate count into ``[1, MAX_CANDIDATES]``."""
    try:
        value = int(count)
    except (TypeError, ValueError):
        return default, None
    if value < 1:
        return default, None
    if value > MAX_CANDIDATES:
        return MAX_CANDIDATES, f"requested {value} candidates; clamped to {MAX_CANDIDATES}"
    return value, None


def _cap_prompt(text: Any) -> tuple[str, str | None]:
    """Enforce the prompt char cap (truncate + warn) before it reaches a graph."""
    value = "" if text is None else str(text)
    if len(value) > MAX_PROMPT_CHARS:
        return value[:MAX_PROMPT_CHARS], f"prompt exceeded {MAX_PROMPT_CHARS} chars; truncated"
    return value, None


def _ensure_skill_scripts(project_root: str) -> None:
    """Put the imagegen skill's ``scripts/`` on sys.path so the seams can lazily
    ``import comfy_http``. Never called in tests (the seams are overridden)."""
    scripts = os.path.join(project_root or os.getcwd(), ".pi", "skills", "imagegen", "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class ImagegenMachine(StateMachine):
    intake = State(initial=True)
    framing = State()  # annie
    composing = State()  # synthia
    generating = State()  # TOOL — submit/poll/fetch sequentially
    critiquing = State()  # PARALLEL — vera + carren
    adjusting = State()  # synthia
    presenting = State()  # TOOL — pick best + dual-format result
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_frame = intake.to(framing)
    frame_done = framing.to(composing)
    compose_done = composing.to(generating)
    generate_done = generating.to(critiquing)
    critique_pass = critiquing.to(presenting)  # both critics APPROVE
    critique_revise = critiquing.to(adjusting)  # either flags + budget remains
    critique_exhausted = critiquing.to(presenting)  # either flags + budget spent
    adjust_done = adjusting.to(generating)  # regenerate only the failed candidates
    present_done = presenting.to(complete)

    to_unknown = (
        framing.to(unknown) | composing.to(unknown) | critiquing.to(unknown) | adjusting.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(framing)
    abort = (
        intake.to(error)
        | framing.to(error)
        | composing.to(error)
        | generating.to(error)
        | critiquing.to(error)
        | adjusting.to(error)
        | presenting.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts
# ---------------------------------------------------------------------------


def _c(
    required: dict,
    optional: dict | None = None,
    evidence: tuple[str, ...] = (),
) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        # Named fields the engine additionally enforces as present + non-empty
        # (externally-grounded verdict: a critic must cite what it observed).
        contract["evidence"] = evidence
    return contract


IMG_FRAME = PrimitiveSpec(
    "IMG_FRAME",
    "annie",
    _c(
        {"frame_complete": bool, "confidence": str},
        {
            "candidate_count": int,
            "brief": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Confirm the interpreted request: routed preset, candidate count (1-10), and a one-line "
    "composition brief. Flag needs_clarification if the request is ambiguous. Always emit confidence.",
)
IMG_COMPOSE = PrimitiveSpec(
    "IMG_COMPOSE",
    "synthia",
    _c(
        {"compose_complete": bool, "confidence": str},
        {
            "positive_prompt": str,
            "negative_prompt": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Compose the positive prompt (subject + the preset's detail scaffold) and a wordless negative. "
    "If a raw prompt override was supplied, pass it through verbatim. Never request text in the image. "
    "Always emit confidence.",
)
IMG_CRITIQUE_VERA = PrimitiveSpec(
    "IMG_CRITIQUE_VERA",
    "vera",
    _c(
        {"verdict": str, "confidence": str, "evidence": list},
        {
            "issues": list,
            "failed_candidates": list,
            "valid_candidates": list,
            "best_candidate": int,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
        # Technical validity is checkable against the real files, so the verdict
        # is externally grounded: one cited observation per candidate.
        evidence=("evidence",),
    ),
    "Technical validity critique of the batch: is each candidate a valid render matching the preset "
    "(dimensions, no baked-in text, no artifacts)? Report failed_candidates + valid_candidates by index. "
    "Back the verdict with `evidence`: one concrete per-candidate observation you actually saw in the "
    "file (e.g. 'cand0: 1024x1024, no text, clean' / 'cand1: garbled text baked in top-left') — a bare "
    "verdict with no cited observations is rejected. Emit APPROVE only if every candidate is valid, "
    "else NEEDS_REVISION. Always emit confidence.",
)
IMG_CRITIQUE_CARREN = PrimitiveSpec(
    "IMG_CRITIQUE_CARREN",
    "carren",
    _c(
        {"verdict": str, "confidence": str, "evidence": list},
        {
            "issues": list,
            "failed_candidates": list,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
        # Aesthetic judgment is subjective, so ground it in specific, locatable
        # citations (which candidate, what feature) rather than a bare verdict.
        evidence=("evidence",),
    ),
    "Aesthetic + brief-fidelity critique of the batch: does each candidate satisfy the composition "
    "brief and the site style? Report failed_candidates by index. Back the verdict with `evidence`: "
    "one specific, locatable observation per candidate (which candidate, what you saw — e.g. "
    "'cand1: subject off-centre, breaks the brief's rule-of-thirds' / 'cand0: on-brief, balanced') — "
    "never a bare verdict. Emit APPROVE only if all pass, else NEEDS_REVISION — never fabricate an "
    "APPROVE. Always emit confidence.",
)
IMG_ADJUST = PrimitiveSpec(
    "IMG_ADJUST",
    "synthia",
    _c(
        {"adjust_complete": bool, "confidence": str},
        {
            "positive_prompt": str,
            "negative_prompt": str,
            "strategy_change": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Given the critics' issues, propose concrete prompt tweaks (state WHAT you changed in "
    "strategy_change) for the failed candidates only. Always emit confidence.",
)


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class ImagegenPlaybook(BasePlaybook):
    NAME = "imagegen"
    machine_cls = ImagegenMachine
    STEP_CAP = 40
    TOOL_STATES = frozenset({"generating", "presenting"})
    PRIMITIVE_BY_STATE = {
        "framing": IMG_FRAME,
        "composing": IMG_COMPOSE,
        "adjusting": IMG_ADJUST,
    }
    PARALLEL_BY_STATE = {
        "critiquing": ParallelSpec(
            branches={"vera": IMG_CRITIQUE_VERA, "carren": IMG_CRITIQUE_CARREN}
        )
    }
    ESCALATABLE_STATES = frozenset({"framing", "composing", "critiquing", "adjusting"})

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        """Fail-fast setup BEFORE any agent runs: deterministic routing, candidate
        clamp, readiness probe (raises an actionable error if ComfyUI is
        unreachable or a required checkpoint is missing), and a safe output dir."""
        constraints = ctx.constraints or {}
        if "max_iterations" not in constraints:
            ctx.max_iterations = DEFAULT_MAX_ITERATIONS

        img = ctx.extras.setdefault("imagegen", {})
        warnings: list[str] = img.setdefault("warnings", [])

        preset = route_preset(ctx.goal, constraints.get("preset"))
        img["preset"] = preset

        count, warn = _clamp_count(constraints.get("count"), DEFAULT_CANDIDATE_COUNT)
        img["count"] = count
        if warn:
            warnings.append(warn)

        # Seed: fixed if supplied, else random-once (recorded for reproduction).
        seed = constraints.get("seed")
        img["base_seed"] = int(seed) if seed is not None else random.randint(0, _SEED_MAX)
        img["seed_was_random"] = seed is None

        img["raw_prompt"] = constraints.get("raw_prompt") or constraints.get("prompt") or ""
        img["width"] = constraints.get("width")
        img["height"] = constraints.get("height")
        img["host"] = DEFAULT_HOST  # LOCKED — never caller-overridable

        img["output_dir"] = self._ensure_output_dir(ctx, constraints.get("output_dir"))

        # Fail-fast readiness (seam). Raises -> start() returns an actionable error.
        readiness = self._check_readiness(ctx, preset)
        img["readiness"] = readiness
        img["comfy_version"] = readiness.get("comfy_version", "")
        img["lora_fallback"] = bool(readiness.get("lora_fallback"))
        if img["lora_fallback"]:
            missing = ", ".join(readiness.get("missing_optional", []))
            warnings.append(
                f"optional LoRA(s) missing for preset '{preset}' ({missing}); "
                "falling back to base model"
            )

        ctx.success_criteria = [f"preset={preset}", f"candidates={count}"]
        self.sm.send("start_frame")
        return "framing"

    # -- readiness seam (fail-fast) ----------------------------------------
    def _check_readiness(self, ctx: RunContext, preset: str) -> dict:
        """Probe ComfyUI: reachable? required checkpoint present? optional LoRA
        present? Raises ``RuntimeError`` (actionable) on unreachable / missing
        required model. Overridable — tests inject a canned readiness dict."""
        _ensure_skill_scripts(ctx.project_root)
        import comfy_http as ch  # skill-dir module (lazy)

        client = ch.ComfyClient(DEFAULT_HOST)
        try:
            stats = client.system_stats()
        except ch.ComfyError as exc:
            raise RuntimeError(
                f"ComfyUI is not reachable at http://{DEFAULT_HOST} ({exc}). "
                "Is comfy-ui.service running? — aborting before any generation."
            ) from exc
        try:
            available = ch.extract_model_filenames(client.object_info())
        except ch.ComfyError as exc:
            raise RuntimeError(f"ComfyUI /object_info failed: {exc}") from exc

        required = ch.PRESET_REQUIRED_MODELS.get(preset, ())
        missing_required = [m for m in required if m not in available]
        if missing_required:
            raise RuntimeError(
                f"preset '{preset}' requires model file(s) not installed in ComfyUI: "
                f"{', '.join(missing_required)}. Install them under the ComfyUI models dir."
            )
        optional = ch.PRESET_OPTIONAL_MODELS.get(preset, ())
        missing_optional = [m for m in optional if m not in available]
        return {
            "reachable": True,
            "comfy_version": (stats.get("system") or {}).get("comfyui_version", ""),
            "missing_optional": missing_optional,
            "lora_fallback": bool(missing_optional),
        }

    def _ensure_output_dir(self, ctx: RunContext, requested: str | None) -> str:
        """Resolve + create a writable output dir. A path inside the project tree
        is redirected to /tmp (never write into the repo). Overridable in tests."""
        default = f"/tmp/imagegen-{ctx.session_id}"
        path = str(requested).strip() if requested else default
        # Never write inside the project tree.
        root = ctx.project_root or ""
        if root and os.path.abspath(path).startswith(os.path.abspath(root)):
            path = default
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as exc:
            raise RuntimeError(f"output dir '{path}' is not creatable/writable: {exc}") from exc
        if not os.access(path, os.W_OK):
            raise RuntimeError(f"output dir '{path}' is not writable")
        return path

    # -- deterministic TOOL states -----------------------------------------
    def run_tool_state(self, state: str, ctx: RunContext) -> None:
        if state == "generating":
            self._run_generating(ctx)
            self.sm.send("generate_done")
        elif state == "presenting":
            self._run_presenting(ctx)
            self.sm.send("present_done")
        else:  # pragma: no cover - guarded by TOOL_STATES membership
            raise RuntimeError(f"no tool runner for state '{state}'")

    def _run_generating(self, ctx: RunContext) -> None:
        """Build the candidate plan (all indices on first pass, only the failed
        ones on a revise loop), run the generate seam, merge results, and fail loud
        only if ZERO candidates exist."""
        img = ctx.extras["imagegen"]
        regen = img.get("regenerate_only")
        indices = list(regen) if regen else list(range(img["count"]))
        plan = {
            "preset": img["preset"],
            "positive": img.get("positive", img.get("raw_prompt", "")),
            "negative": img.get("negative", WORDLESS_NEGATIVE),
            "base_seed": img["base_seed"],
            "width": img.get("width"),
            "height": img.get("height"),
            "lora_fallback": img.get("lora_fallback", False),
            "indices": indices,
            "output_dir": img["output_dir"],
            "host": img["host"],
        }
        result = self._comfy_generate(ctx, plan) or {}
        self._merge_candidates(img, result.get("candidates", []))
        errors = result.get("errors", []) or []
        if errors:
            img.setdefault("partial_errors", []).extend(errors)
        if result.get("manifest_path"):
            img["manifest_path"] = result["manifest_path"]
        img["regenerate_only"] = None  # consumed
        if not img.get("candidates_by_index"):
            raise RuntimeError(
                "generating produced 0 candidates: " + "; ".join(errors)
                if errors
                else "generating produced 0 candidates and no error detail"
            )

    @staticmethod
    def _merge_candidates(img: dict, candidates: list) -> None:
        """Merge candidate records by index — a revise loop overwrites only the
        regenerated indices, keeping the previously-good candidates."""
        by_index = img.setdefault("candidates_by_index", {})
        for record in candidates:
            if isinstance(record, dict) and "index" in record:
                by_index[str(record["index"])] = record

    def _comfy_generate(self, ctx: RunContext, plan: dict) -> dict:
        """THE overridable generate seam. Default: submit each candidate ONE at a
        time via the hardened client, poll, download, write a manifest. Tests
        override this so no live ComfyUI is ever touched."""
        _ensure_skill_scripts(ctx.project_root)
        import json as _json

        import comfy_http as ch

        host = plan["host"]
        client = ch.ComfyClient(host)
        candidates: list[dict] = []
        errors: list[str] = []
        for index in plan["indices"]:
            seed = (plan["base_seed"] + index) % (_SEED_MAX + 1)
            try:
                graph = ch.build_graph(
                    plan["preset"],
                    positive=plan["positive"],
                    negative=plan["negative"],
                    seed=seed,
                    width=plan.get("width"),
                    height=plan.get("height"),
                    lora_fallback=plan.get("lora_fallback", False),
                )
                prompt_id = client.submit(graph)
                images = self._poll_images(client, prompt_id)
                files: list[str] = []
                for img_ref in images:
                    dest = os.path.join(plan["output_dir"], f"cand{index}_{img_ref['filename']}")
                    files.append(
                        client.download_image(
                            filename=img_ref["filename"],
                            subfolder=img_ref.get("subfolder", ""),
                            type=img_ref.get("type", "output"),
                            dest=dest,
                        )
                    )
                candidates.append(
                    {
                        "index": index,
                        "seed": seed,
                        "prompt_id": prompt_id,
                        "graph_sha256": ch.graph_hash(graph),
                        "files": files,
                    }
                )
            except ch.ComfyError as exc:
                errors.append(f"candidate {index} (seed {seed}) failed: {exc}")

        manifest_path = os.path.join(plan["output_dir"], "manifest.json")
        manifest = {
            "schema": "imagegen/manifest@1",
            "preset": plan["preset"],
            "positive": plan["positive"],
            "negative": plan["negative"],
            "base_seed": plan["base_seed"],
            "lora_fallback": plan.get("lora_fallback", False),
            "host": host,
            "candidates": candidates,
        }
        try:
            with open(manifest_path, "w", encoding="utf-8") as handle:
                _json.dump(manifest, handle, indent=2)
        except OSError:
            manifest_path = ""
        return {"candidates": candidates, "errors": errors, "manifest_path": manifest_path}

    @staticmethod
    def _poll_images(client: Any, prompt_id: str, timeout: int = 300) -> list[dict]:
        import time as _time

        deadline = _time.time() + timeout
        while _time.time() < deadline:
            _time.sleep(2)
            record = (client.history(prompt_id) or {}).get(prompt_id)
            if not record:
                continue
            images: list[dict] = []
            for out in (record.get("outputs") or {}).values():
                images.extend(out.get("images", []) or [])
            if images:
                return images
        raise RuntimeError(f"timed out waiting for prompt {prompt_id}")

    def _run_presenting(self, ctx: RunContext) -> None:
        """Pick the best vera-valid candidate for the result."""
        img = ctx.extras["imagegen"]
        candidates = self._candidate_list(img)
        valid = img.get("vera_valid_candidates")
        best_hint = img.get("best_candidate")
        img["best"] = self._pick_best(candidates, valid, best_hint)

    @staticmethod
    def _candidate_list(img: dict) -> list[dict]:
        by_index = img.get("candidates_by_index", {})
        return [by_index[k] for k in sorted(by_index, key=lambda x: int(x))]

    @staticmethod
    def _pick_best(candidates: list[dict], valid: list | None, best_hint: Any) -> dict | None:
        if not candidates:
            return None
        by_index = {c["index"]: c for c in candidates}
        if isinstance(best_hint, int) and best_hint in by_index:
            return by_index[best_hint]
        if valid:
            for idx in valid:
                if idx in by_index:
                    return by_index[idx]
        return candidates[0]

    # -- progress / needs_clarification gate -------------------------------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        """Single-agent states (framing/composing/adjusting) escalate on an
        explicit needs_clarification. Parallel critiquing expresses uncertainty via
        UNCERTAIN confidence (handled by the engine's parallel fan-in), so this
        gate is not consulted there."""
        if summary.get("needs_clarification"):
            qs = summary.get("clarifying_questions") or []
            detail = f": {'; '.join(str(q) for q in qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        if state == "framing":
            self._route_framing(ctx, summary)
        elif state == "composing":
            self._route_composing(ctx, summary)
        elif state == "critiquing":
            self._route_critiquing(ctx, summary)
        elif state == "adjusting":
            self._route_adjusting(ctx, summary)
        else:  # pragma: no cover - guarded by PRIMITIVE/PARALLEL membership
            raise ValueError(f"route_after: unexpected state '{state}'")

    def _route_framing(self, ctx: RunContext, summary: dict) -> None:
        img = ctx.extras["imagegen"]
        # annie may re-validate the candidate count within bounds.
        proposed = summary.get("candidate_count")
        if proposed is not None:
            count, warn = _clamp_count(proposed, img["count"])
            img["count"] = count
            if warn:
                img.setdefault("warnings", []).append(warn)
        img["brief"] = summary.get("brief", "")
        self.sm.send("frame_done")

    def _route_composing(self, ctx: RunContext, summary: dict) -> None:
        img = ctx.extras["imagegen"]
        warnings = img.setdefault("warnings", [])
        # Raw-override passthrough: a caller-supplied prompt wins the positive slot.
        raw = img.get("raw_prompt", "")
        positive_source = raw if raw else summary.get("positive_prompt", "")
        positive, warn = _cap_prompt(positive_source)
        if warn:
            warnings.append(warn)
        img["positive"] = positive
        # Wordless negative ALWAYS applies (even over a raw override).
        negative = summary.get("negative_prompt") or WORDLESS_NEGATIVE
        img["negative"], neg_warn = _cap_prompt(negative)
        if neg_warn:
            warnings.append(neg_warn)
        self.sm.send("compose_done")

    def _route_critiquing(self, ctx: RunContext, summary: dict) -> None:
        img = ctx.extras["imagegen"]
        branches = summary.get("branches", {})
        vera = branches.get("vera", {})
        carren = branches.get("carren", {})
        for critic in (vera, carren):
            verdict = critic.get("verdict")
            if verdict not in _VERDICTS:
                raise ValueError(f"critiquing: unknown verdict '{verdict}'")

        needs_revision = any(
            critic.get("verdict") == VERDICT_NEEDS_REVISION for critic in (vera, carren)
        )
        failed = sorted(
            {int(i) for i in (vera.get("failed_candidates") or [])}
            | {int(i) for i in (carren.get("failed_candidates") or [])}
        )
        issues = list(vera.get("issues") or []) + list(carren.get("issues") or [])
        img["unresolved_issues"] = issues
        img["failed_candidates"] = failed
        # vera is the technical-validity oracle -> presenting picks a vera-valid one.
        vera_valid = vera.get("valid_candidates")
        if vera_valid is None:
            all_idx = {int(k) for k in img.get("candidates_by_index", {})}
            vera_valid = sorted(
                all_idx - set(int(i) for i in (vera.get("failed_candidates") or []))
            )
        img["vera_valid_candidates"] = list(vera_valid)
        img["best_candidate"] = vera.get("best_candidate")

        if not needs_revision:
            img["approved"] = True
            img["exhausted"] = False
            self.sm.send("critique_pass")
            return
        # NEEDS_REVISION — either bounded revise, or honest exhaustion.
        if ctx.iteration + 1 < ctx.max_iterations:
            self.record_iteration(ctx, gaps=issues, confidence=summary.get("confidence", ""))
            ctx.iteration += 1
            # Regenerate ONLY the failed candidates (locked correction).
            img["regenerate_only"] = failed or sorted(
                int(k) for k in img.get("candidates_by_index", {})
            )
            self.sm.send("critique_revise")
        else:
            img["approved"] = False
            img["exhausted"] = True
            self.sm.send("critique_exhausted")

    def _route_adjusting(self, ctx: RunContext, summary: dict) -> None:
        img = ctx.extras["imagegen"]
        warnings = img.setdefault("warnings", [])
        new_positive = summary.get("positive_prompt")
        if new_positive:
            capped, warn = _cap_prompt(new_positive)
            img["positive"] = capped
            if warn:
                warnings.append(warn)
        new_negative = summary.get("negative_prompt")
        if new_negative:
            capped_neg, neg_warn = _cap_prompt(new_negative)
            img["negative"] = capped_neg
            if neg_warn:
                warnings.append(neg_warn)
        img["last_strategy"] = summary.get("strategy_change", "")
        self.sm.send("adjust_done")

    def done_predicate(self, ctx: RunContext) -> bool:
        """Met only when the batch was APPROVED by both critics (never on an
        exhausted revise loop)."""
        img = ctx.extras.get("imagegen", {})
        return bool(img.get("approved")) and not img.get("exhausted")

    # -- task builders -----------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = {
            "framing": self._frame_task,
            "composing": self._compose_task,
            "critiquing": lambda c: self._critique_task(c, spec),
            "adjusting": self._adjust_task,
        }.get(state)
        base = builder(ctx) if builder else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        # Recall (F2): seed the FIRST agent directive with distilled lessons
        # (this override replaces the base _task_summary, so re-add it).
        if ctx.recall_lessons and ctx.total_steps == 0:
            lessons = "\n".join(f"- {self._cap(lsn)}" for lsn in ctx.recall_lessons)
            base += (
                "\n\nLessons from prior runs (advisory — weigh against current evidence; "
                "they never override this run's goal or constraints):\n" + lessons
            )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {self._cap(ctx.clarification_text)}"
        return base

    def _frame_task(self, ctx: RunContext) -> str:
        img = ctx.extras.get("imagegen", {})
        readiness = img.get("readiness", {})
        return (
            f"Frame this image-generation request. Goal: {self._cap(ctx.goal)}\n"
            f"Routed preset: {img.get('preset')} (deterministic — confirm it fits the request).\n"
            f"Candidate count: {img.get('count')} (1-10). Output dir: {img.get('output_dir')}.\n"
            f"ComfyUI version: {readiness.get('comfy_version', '?')}. "
            f"LoRA fallback: {img.get('lora_fallback', False)}.\n"
            "Confirm the interpretation and provide a one-line composition brief. "
            "Flag needs_clarification only if the subject is genuinely ambiguous."
        )

    def _compose_task(self, ctx: RunContext) -> str:
        img = ctx.extras.get("imagegen", {})
        raw = img.get("raw_prompt", "")
        raw_note = (
            f"\nA RAW PROMPT OVERRIDE was supplied — pass it through verbatim as the positive: "
            f"{self._cap(raw)}"
            if raw
            else ""
        )
        return (
            f"Compose the prompt pair for preset '{img.get('preset')}'.\n"
            f"Brief: {self._cap(img.get('brief') or ctx.goal)}\n"
            "Positive: subject + the preset's detail scaffold (from resources/reference.md). "
            "Negative: wordless terms (never request text/labels in the image)."
            f"{raw_note}"
        )

    def _critique_task(self, ctx: RunContext, spec: PrimitiveSpec) -> str:
        img = ctx.extras.get("imagegen", {})
        candidates = self._candidate_list(img)
        listing = "\n".join(
            f"  - candidate {c['index']}: seed={c.get('seed')} files={c.get('files')}"
            for c in candidates
        )
        lens = (
            "Judge TECHNICAL VALIDITY (valid render, correct dimensions, NO baked-in text, "
            "no artifacts). Report valid_candidates + failed_candidates by index."
            if spec.agent == "vera"
            else "Judge AESTHETIC + BRIEF FIDELITY (does it satisfy the brief and site style?). "
            "Report failed_candidates by index."
        )
        return (
            f"Critique the generated batch for preset '{img.get('preset')}'.\n"
            f"Brief: {self._cap(img.get('brief') or ctx.goal)}\n"
            f"Candidates:\n{listing}\n{lens}\n"
            "Back your verdict with `evidence`: one specific observation PER CANDIDATE that you "
            "actually saw (name the candidate + what you observed) — a bare verdict with no cited "
            "observations is rejected.\n"
            "Emit APPROVE only if ALL candidates pass; otherwise NEEDS_REVISION. "
            "Never fabricate an APPROVE."
        )

    def _adjust_task(self, ctx: RunContext) -> str:
        img = ctx.extras.get("imagegen", {})
        issues = img.get("unresolved_issues", [])
        failed = img.get("failed_candidates", [])
        return (
            f"The critics flagged issues on candidates {failed}. Propose concrete prompt tweaks "
            f"(positive/negative) to fix them. Issues:\n"
            + "\n".join(f"  - {i}" for i in issues)
            + "\nState WHAT you changed in strategy_change. Only the failed candidates regenerate."
        )

    # -- dual-format result ------------------------------------------------
    def result_payload(self, ctx: RunContext) -> dict:
        img = ctx.extras.get("imagegen", {})
        candidates = self._candidate_list(img)
        best = img.get("best")
        approved = bool(img.get("approved"))
        exhausted = bool(img.get("exhausted"))
        machine = {
            "preset": img.get("preset"),
            "approved": approved,
            "exhausted": exhausted,
            "candidate_count": len(candidates),
            "candidates": candidates,
            "best_candidate": best,
            "output_dir": img.get("output_dir"),
            "manifest_path": img.get("manifest_path", ""),
            "base_seed": img.get("base_seed"),
            "lora_fallback": img.get("lora_fallback", False),
            "unresolved_issues": img.get("unresolved_issues", []),
            "warnings": img.get("warnings", []),
            "partial_batch_errors": img.get("partial_errors", []),
        }
        human = self._human_summary(ctx, img, candidates, best, approved, exhausted)
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "wing": WING,
            "preset": img.get("preset"),
            "approved": approved,
            "exhausted": exhausted,
            "output_dir": img.get("output_dir"),
            "manifest_path": img.get("manifest_path", ""),
            "candidates": candidates,
            "best_candidate": best,
            "unresolved_issues": img.get("unresolved_issues", []),
            "warnings": img.get("warnings", []),
            "partial_batch_errors": img.get("partial_errors", []),
            "human": human,
            "machine": machine,
        }

    @staticmethod
    def _human_summary(
        ctx: RunContext,
        img: dict,
        candidates: list,
        best: dict | None,
        approved: bool,
        exhausted: bool,
    ) -> str:
        lines = [
            f"# Image generation — {'APPROVED' if approved else 'NOT APPROVED'}",
            f"Preset: {img.get('preset')}  |  candidates: {len(candidates)}  "
            f"|  iterations: {ctx.iteration}",
            f"Output: {img.get('output_dir')}",
        ]
        if best:
            lines.append(
                f"Best candidate: #{best.get('index')} (seed {best.get('seed')}) "
                f"→ {', '.join(best.get('files', []))}"
            )
        if exhausted:
            lines.append(
                "⚠️ Revise budget exhausted — presenting the best vera-valid candidate "
                "with unresolved issues:"
            )
            for issue in img.get("unresolved_issues", []):
                lines.append(f"  - {issue}")
        for warn in img.get("warnings", []):
            lines.append(f"warning: {warn}")
        for err in img.get("partial_errors", []):
            lines.append(f"partial-batch: {err}")
        return "\n".join(lines)
