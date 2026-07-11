"""RezPlaybook — the rez (resume tailoring) skill on the shared engine.

Linear five-lane pipeline with a bounded evaluator-optimizer loop:
analyzing[annie] → aligning[echo] → tailoring[synthia] ⇄ validating[vera]
→ exporting[skribble] → complete.

Hard behavioral guarantees (mirrors .pi/skills/rez/SKILL.md):
  * **No JD → error.** ``initial_transition`` rejects an empty goal; an
    analyzing pass that cannot load a usable job description aborts with the
    canonical error message.
  * **No base resume → error.** Tailoring never proceeds from nothing.
  * **No accomplishments → proceed** with the base resume only (noted in the
    result payload — not an error).
  * **Fresh NICE lookup every run.** ``aligning`` always dispatches; there is
    no cached-alignment shortcut. If echo reports the NIST/NICCS sources
    unavailable, the run proceeds UNALIGNED — tailoring is instructed to prefix
    bullets with ``[UNALIGNED]`` — and the result payload reports the skip.
  * **Anti-fabrication is the validation oracle.** vera must emit
    ``fabrication_free`` (required, never defaulted); a resume that fails the
    trace check is revised (bounded) or the run completes HONESTLY with
    ``met=False`` and the unresolved issues — it is NEVER exported.
  * **Export failure → error, no fallback.** A missing word extension (or a
    failed generate) aborts; the skill never silently emits another format.

The mempalace room ``skills/rez-{session_id}`` (wing=penny) carries all
artifacts between lanes: gap analysis, NICE alignment digest, the tailored
resume markdown, the validation report, and the export record. Source
materials under ``.pi/skills/rez/resources/`` are read-only for every lane.
"""

from __future__ import annotations

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import PrimitiveSpec


def _c(required: dict, optional: dict | None = None) -> dict:
    return {"required": required, "optional": optional or {}}


NO_JD_ERROR = (
    "ERROR: No job description provided. Pass a URL, a JD file path, or the "
    "job description text."
)
NO_RESUME_ERROR = (
    "ERROR: No base resume found in resources/resume/. Add the base resume "
    "before running rez."
)
EXPORT_ERROR = (
    "ERROR: word extension (word_generate tool) unavailable or export failed — "
    "cannot export .docx. Aborting (no fallback format)."
)


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class RezMachine(StateMachine):
    intake = State(initial=True)
    analyzing = State()  # annie: JD ingest + source load + gap analysis
    aligning = State()  # echo: fresh NIST NICE lookup (every run)
    tailoring = State()  # synthia: STAR/ATS/NICE bullet tailoring + assembly
    validating = State()  # vera: anti-fabrication trace + compliance
    exporting = State()  # skribble: .docx export to /tmp/resumes/
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_analyze = intake.to(analyzing)
    analyze_done = analyzing.to(aligning)
    align_done = aligning.to(tailoring)  # fires aligned OR unaligned
    tailor_done = tailoring.to(validating)
    validate_pass = validating.to(exporting)
    revise = validating.to(tailoring)  # issues found && within budget
    validate_exhausted = validating.to(complete)  # honest met=False; NO export
    export_done = exporting.to(complete)

    to_unknown = (
        analyzing.to(unknown)
        | aligning.to(unknown)
        | tailoring.to(unknown)
        | validating.to(unknown)
        | exporting.to(unknown)
    )
    escalate = unknown.to(awaiting_clarification)
    # clarify re-enters at analyzing and re-runs the pipeline from the top:
    # the gap analysis may change with the clarification, and the NICE lookup
    # is required to be fresh anyway, so the re-run is correct by construction.
    clarify = awaiting_clarification.to(analyzing)
    abort = (
        intake.to(error)
        | analyzing.to(error)
        | aligning.to(error)
        | tailoring.to(error)
        | validating.to(error)
        | exporting.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts
# ---------------------------------------------------------------------------

REZ_ANALYZE = PrimitiveSpec(
    "REZ_ANALYZE",
    "annie",
    _c(
        {"complete": bool, "jd_loaded": bool, "base_resume_found": bool},
        {
            "company": str,
            "role": str,
            "accomplishments_found": bool,
            "match_count": int,
            "miss_count": int,
            "transferable_count": int,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Ingest the job description (fetch URL / read file / use inline text), read "
    "the base resume and accomplishments READ-ONLY, and produce the gap analysis "
    "(matches / misses / transferables). Write it to mempalace.",
)
REZ_ALIGN = PrimitiveSpec(
    "REZ_ALIGN",
    "echo",
    _c(
        {"complete": bool, "nice_available": bool},
        {
            "nice_version": str,
            "work_roles": list,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Perform a FRESH NIST NICE Framework lookup (never cached): current "
    "components version + TKS verbiage for the JD-relevant work roles. Write the "
    "alignment digest to mempalace.",
)
REZ_TAILOR = PrimitiveSpec(
    "REZ_TAILOR",
    "synthia",
    _c(
        {"complete": bool},
        {
            "bullet_count": int,
            "unaligned": bool,
            "resolved_issues": list,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Tailor the resume: STAR-format bullets, ATS keywords, NICE verbiage, zero "
    "fabrication. Write the full assembled resume markdown to mempalace.",
)
REZ_VALIDATE = PrimitiveSpec(
    "REZ_VALIDATE",
    "vera",
    _c(
        {"valid": bool, "fabrication_free": bool},
        {
            "issues": list,
            "star_compliant": bool,
            "ats_ok": bool,
            "complete": bool,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "confidence": str,
        },
    ),
    "Validate the tailored resume: trace EVERY bullet to the source materials "
    "(anti-fabrication), STAR structure, ATS safety, NICE alignment markers. "
    "Emit valid + fabrication_free + issues.",
)
REZ_EXPORT = PrimitiveSpec(
    "REZ_EXPORT",
    "skribble",
    _c(
        {"export_ok": bool},
        {
            "output_path": str,
            "word_extension_available": bool,
            "error": str,
            "confidence": str,
        },
    ),
    "Materialize the validated resume markdown and render it to a .docx in "
    "/tmp/resumes/ via the word extension generator. Verify the file exists.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders
# ---------------------------------------------------------------------------


def _room(ctx: RunContext) -> str:
    return f"skills/rez-{ctx.session_id}"


def _skill_dir(ctx: RunContext) -> str:
    root = (ctx.project_root or "").rstrip("/")
    return f"{root}/.pi/skills/rez" if root else ".pi/skills/rez"


def _build_analyze(pb: "RezPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    return (
        f"Session: {ctx.session_id}. "
        f"Mempalace room: {_room(ctx)}. "
        f"Skill dir: {_skill_dir(ctx)}. "
        f"Job description input (URL, file path, or inline text): {pb._cap(ctx.goal)}. "
        f"Ingest the JD (web_fetch a URL; read a file path; use inline text as-is). "
        f"Read the base resume from {_skill_dir(ctx)}/resources/resume/ and "
        f"accomplishments from {_skill_dir(ctx)}/resources/accomplishments/ "
        f"(ignore README.md files; READ-ONLY — never modify them). "
        f"Produce the gap analysis: skill matches, skill misses, transferable "
        f"skills; select the strongest matches and strongest transferables. "
        f"Write the JD digest + gap analysis to mempalace wing=penny room={_room(ctx)}. "
        f"Return SUMMARY with jd_loaded, base_resume_found, accomplishments_found, "
        f"company, role, match_count, miss_count, transferable_count."
    )


def _build_align(pb: "RezPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    return (
        f"Session: {ctx.session_id}. "
        f"Mempalace room: {_room(ctx)}. "
        f"Perform a FRESH NIST NICE Framework lookup — never rely on cached, "
        f"remembered, or bundled data. Fetch "
        f"https://www.nist.gov/itl/applied-cybersecurity/nice/nice-framework-resource-center/nice-framework-current-versions "
        f"to record the current NICE Framework Components version and date. "
        f"Read the gap analysis from mempalace wing=penny room={_room(ctx)}, "
        f"identify the 1-3 Work Roles matching the target job, and fetch their "
        f"Task/Knowledge/Skill (TKS) statements via the page's links (CPRT, "
        f"NICCS) or targeted web_search. "
        f"Write the alignment digest (version, work role IDs, canonical TKS "
        f"verbiage relevant to the JD) to mempalace wing=penny room={_room(ctx)}. "
        f"If ALL live sources are unreachable, return nice_available: false with "
        f"the reason — do NOT substitute remembered framework data. "
        f"Return SUMMARY with nice_available, nice_version, work_roles."
    )


def _build_tailor(pb: "RezPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    rez = ctx.extras.get("rez", {})
    room = _room(ctx)
    aligned = rez.get("nice_available", False)
    alignment = (
        "Use the canonical NICE TKS verbiage from the alignment digest in the room."
        if aligned
        else (
            "NICE alignment is UNAVAILABLE this run: prefix EVERY tailored bullet "
            "with [UNALIGNED] and do not invent framework verbiage."
        )
    )
    base = (
        f"Session: {ctx.session_id}. "
        f"Mempalace room: {room}. "
        f"Skill dir: {_skill_dir(ctx)}. "
        f"Read the gap analysis, NICE alignment digest, and source materials "
        f"digest from mempalace wing=penny room={room}; read the raw source "
        f"files under {_skill_dir(ctx)}/resources/ READ-ONLY as needed. "
        f"{alignment} "
        f"Tailor the resume for the target job: rewrite the strongest matches "
        f"and strongest transferables as STAR-format bullets (Situation/Task, "
        f"Action, Result in one fluent line), quantified only with numbers that "
        f"exist in the sources, strong qualitative results otherwise; mirror the "
        f"JD's exact keyword phrases for ATS only where the evidence supports "
        f"them. NEVER fabricate or exaggerate — every claim must trace to a "
        f"source statement; unsupported JD requirements stay misses. "
        f"Assemble the complete resume as markdown (header, summary, skills, "
        f"certifications, experience, projects, education) and write it to "
        f"mempalace wing=penny room={room} under a '## {ctx.session_id} Tailored Resume' header. "
        f"Return SUMMARY with complete and bullet_count."
    )
    if rez.get("mode") == "revision":
        issues_str = "; ".join(str(i) for i in rez.get("issues", []))
        base = (
            f"Mode: REVISION. Fix the following validation issues, then re-emit "
            f"the FULL tailored resume markdown to the room: {issues_str}. " + base
        )
    return base


def _build_validate(pb: "RezPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. "
        f"Mempalace room: {room}. "
        f"Skill dir: {_skill_dir(ctx)}. "
        f"Read the tailored resume markdown and the gap analysis from mempalace "
        f"wing=penny room={room}; read the source files under "
        f"{_skill_dir(ctx)}/resources/ READ-ONLY. "
        f"Validate: (a) ANTI-FABRICATION — every bullet, metric, title, date, "
        f"certification, and tool traces to the base resume or accomplishments; "
        f"flag anything invented, inflated, or unsupported; "
        f"(b) STAR structure per bullet; (c) ATS safety (single column, standard "
        f"headings, JD keywords only where evidenced); (d) NICE alignment — "
        f"canonical verbiage when alignment ran, [UNALIGNED] prefixes when it "
        f"did not. "
        f"Write the validation report to mempalace wing=penny room={room}. "
        f"Return SUMMARY with valid, fabrication_free, issues."
    )


def _build_export(pb: "RezPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    rez = ctx.extras.get("rez", {})
    room = _room(ctx)
    return (
        f"Session: {ctx.session_id}. "
        f"Mempalace room: {room}. "
        f"Read the VALIDATED tailored resume markdown from mempalace wing=penny "
        f"room={room}. "
        f"1) FIRST confirm the word extension tool `word_generate` is available in "
        f"your toolset. If it is not, return export_ok: false, "
        f"word_extension_available: false, error: 'word_generate tool unavailable' "
        f"— do NOT fall back to another format. "
        f"2) Invoke the `word_generate` tool with: markdown=<the VERBATIM validated "
        f"resume markdown>, output_path='/tmp/resumes/"
        f"<CandidateName>_<Company>_<Role>_<YYYY-MM-DD>.docx' (company/role from "
        f"the room's gap analysis; underscores, no spaces), theme='modern', "
        f"font_size_pt=10.5, margin_inches=0.7, line_spacing=1.05, "
        f"include_page_numbers=false, table_style='minimal'. The tool writes the "
        f".docx via the project venv and returns the path; a tool error means "
        f"export_ok: false with the error text. "
        f"3) Verify the returned .docx exists on disk and is non-empty. "
        f"Write the export record (path, size) to mempalace wing=penny room={room}. "
        f"Return SUMMARY with export_ok, word_extension_available, output_path."
    )


_TASK_BUILDERS = {
    "analyzing": _build_analyze,
    "aligning": _build_align,
    "tailoring": _build_tailor,
    "validating": _build_validate,
    "exporting": _build_export,
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class RezPlaybook(BasePlaybook):
    NAME = "rez"
    machine_cls = RezMachine
    PRIMITIVE_BY_STATE = {
        "analyzing": REZ_ANALYZE,
        "aligning": REZ_ALIGN,
        "tailoring": REZ_TAILOR,
        "validating": REZ_VALIDATE,
        "exporting": REZ_EXPORT,
    }
    ESCALATABLE_STATES = frozenset(
        {"analyzing", "aligning", "tailoring", "validating", "exporting"}
    )

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError(NO_JD_ERROR)
        if "max_iterations" not in (ctx.constraints or {}):
            ctx.max_iterations = 3  # bounded tailor⇄validate revision budget
        rez = ctx.extras.setdefault("rez", {})
        rez["mode"] = "tailor"
        self.sm.send("start_analyze")
        return "analyzing"

    # -- progress / escalation gate ----------------------------------------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            qs = [str(q) for q in (summary.get("clarifying_questions") or [])]
            detail = f": {'; '.join(qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        if state == "validating" and not (
            summary.get("valid") and summary.get("fabrication_free")
        ):
            if self.is_stalled(ctx, summary.get("issues", [])):
                return (
                    "the same resume validation issues have persisted across revisions "
                    "with no measurable progress — escalating rather than exporting an "
                    "unverified resume"
                )
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        rez = ctx.extras.setdefault("rez", {})
        if state == "analyzing":
            if not summary.get("jd_loaded"):
                ctx.errors.append(NO_JD_ERROR)
                self.sm.send("abort")
                return
            if not summary.get("base_resume_found"):
                ctx.errors.append(NO_RESUME_ERROR)
                self.sm.send("abort")
                return
            rez["company"] = summary.get("company", "")
            rez["role"] = summary.get("role", "")
            rez["accomplishments_found"] = summary.get("accomplishments_found", False)
            rez["match_count"] = summary.get("match_count", 0)
            rez["miss_count"] = summary.get("miss_count", 0)
            rez["transferable_count"] = summary.get("transferable_count", 0)
            self.sm.send("analyze_done")
        elif state == "aligning":
            # Proceeds either way — an unavailable NIST is a degraded run
            # ([UNALIGNED] bullets), never a fabricated alignment.
            rez["nice_available"] = bool(summary.get("nice_available"))
            rez["nice_version"] = summary.get("nice_version", "")
            rez["work_roles"] = summary.get("work_roles", [])
            self.sm.send("align_done")
        elif state == "tailoring":
            rez["bullet_count"] = summary.get("bullet_count", 0)
            self.sm.send("tailor_done")
        elif state == "validating":
            valid = summary["valid"]
            fabrication_free = summary["fabrication_free"]
            issues = summary.get("issues", [])
            rez["valid"] = bool(valid and fabrication_free)
            rez["issues"] = issues
            if valid and fabrication_free:
                self.sm.send("validate_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                self.record_iteration(ctx, gaps=issues, confidence=summary.get("confidence", ""))
                ctx.iteration += 1
                rez["mode"] = "revision"
                self.sm.send("revise")
            else:
                # Honest exhaustion: complete with met=False and the unresolved
                # issues. An unverified resume is NEVER exported.
                rez["exhausted"] = True
                self.sm.send("validate_exhausted")
        elif state == "exporting":
            if summary["export_ok"] and summary.get("output_path"):
                rez["exported"] = True
                rez["output_path"] = summary["output_path"]
                self.sm.send("export_done")
            else:
                detail = str(summary.get("error", "")).strip()
                ctx.errors.append(f"{EXPORT_ERROR} {detail}".strip())
                self.sm.send("abort")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        rez = ctx.extras.get("rez", {})
        return bool(rez.get("valid")) and bool(rez.get("exported"))

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(self, ctx, spec)
            if builder
            else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def result_payload(self, ctx: RunContext) -> dict:
        rez = ctx.extras.get("rez", {})
        exhausted = bool(rez.get("exhausted", False))
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "rez_summary": {
                "company": rez.get("company", ""),
                "role": rez.get("role", ""),
                "output_path": rez.get("output_path", ""),
                "nice_aligned": rez.get("nice_available", False),
                "nice_version": rez.get("nice_version", ""),
                "work_roles": rez.get("work_roles", []),
                "match_count": rez.get("match_count", 0),
                "miss_count": rez.get("miss_count", 0),
                "transferable_count": rez.get("transferable_count", 0),
                "accomplishments_used": rez.get("accomplishments_found", False),
                "bullet_count": rez.get("bullet_count", 0),
                "session_id": ctx.session_id,
            },
            "session_room": _room(ctx),
            "mempalace_drawers": {"wing": "penny", "room": _room(ctx)},
            "exhausted": exhausted,
            "unresolved_issues": rez.get("issues", []) if exhausted else [],
        }
