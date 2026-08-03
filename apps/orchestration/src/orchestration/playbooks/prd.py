"""PrdPlaybook — the prd skill on the shared engine.

A faithful behavioral port of the legacy ~1500-line ``.pi/skills/prd`` orchestrator
onto ``BasePlaybook``: custom-named states (generating[synthia, three modes]→
validating[vera]⇄generating), clarify-first HITL (the first generate always runs in
CLARIFICATION QUESTIONS mode and escalates with synthia's questions), and vera's
bounded evaluator-optimizer revision loop.

The legacy ``classify`` state is dropped deliberately: the legacy ``start()``
auto-skipped it on every fresh run, so echo never actually ran. Domain selection
is now **model-owned** (bitter-lesson: the keyword ``detect_domain`` table was
deleted): the code lists the available guidance packs under ``resources/`` and
synthia declares the best-fit ``domain`` in its SUMMARY; a caller
``constraints["domain"]`` short-circuits the choice. Resolved domain is stashed
in ``ctx.extras["prd"]``.

Control-flow dial: code-owned evaluator-optimizer (generating ⇄ validating). The
verdict (``valid``) is a rules-tier wire signal the engine routes on; there is no
free routing choice for the model, so ``fire_model_route`` is deliberately not
used. ``validating`` is evidence-gated (Rec 4): vera's PASS must carry captured
evidence or the engine's contract rejects it.

Three deliberate behavior fixes vs. the legacy runtime:
  * the revision loop no longer force-sets ``valid=True`` at the iteration cap
    ("Max iterations reached — forcing completion"). True budget exhaustion now
    completes HONESTLY with ``met=False`` and the unresolved issues reported, and
    a stalled loop (the same issues persisting) escalates to the user instead;
  * ``_write_placeholder_artifacts`` — which force-completed by inserting
    metadata-only placeholders HARDCODED to an unrelated past project
    ("simply-rag") straight into chroma's sqlite tables — is deleted, not ported;
  * UNCERTAIN from vera now escalates coherently (validating has a real
    ``to_unknown`` edge and ``clarify`` resumes generation); the legacy path drove
    the FSM into terminal error while still presenting unusable resume options.

The direct chroma.sqlite3 artifact-verification gate is not ported either (it
silently passed whenever no DB was found or any exception fired); vera's
``ideal_state_valid`` verdict is the artifact oracle on the engine path.

Domain guidance stays in ``.pi/skills/prd/assets/prompts/<agent>.md``; the
mempalace room ``skills/prd-{session_id}`` and the task-message wording that
drives the drawer headers are preserved verbatim — the code skill reads
IDEAL_STATE from that room when chained (an optional dependency — code also
runs standalone, synthesizing criteria from the goal).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from statemachine import State, StateMachine

from ..context import RunContext
from ..contracts import VERDICT_FAIL, VERDICT_PASS
from ..engine import BasePlaybook, tier_budget
from ..loans import loan_enabled
from ..paths import penny_file
from ..paths import skill_root as _skill_root
from ..primitives.spec import PrimitiveSpec

# Sentinel: "no IDEAL_STATE was passed in" (distinct from "read it, got None"),
# so route_after can hand its already-loaded copy to the schema floor instead of
# paying for a second MemPalace read.
_UNREAD = object()


def _c(required: dict, optional: dict | None = None, evidence: list | None = None) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        contract["evidence"] = evidence
    return contract


# ---------------------------------------------------------------------------
# Domain packs (model-owned selection). Code lists what guidance EXISTS under
# the skill's resources/; the model chooses. This is an interface (a directory
# listing), not the deleted keyword router.
# ---------------------------------------------------------------------------


def skill_root(ctx: RunContext) -> str:
    """Absolute path to the prd skill directory, or "" when unresolvable.

    Thin alias over the shared resolver (``orchestration.paths``) — agents spawn with
    ``cwd = project_root``, which for a run against another repo is NOT this repo, so
    every path handed to an agent must be absolute or it silently misses."""
    return _skill_root(ctx, "prd")


def validator_path() -> str:
    """Absolute path to ``scripts/validate_ideal_state.py`` (the artifact oracle), or
    "" when unresolvable. Handed to vera so the executed-evidence tier works
    regardless of the agent's cwd."""
    return penny_file("scripts", "validate_ideal_state.py")


def available_domains(ctx: RunContext) -> list[str]:
    """Domain guidance packs available to synthia: the directory names under the
    prd skill's ``resources/`` (always including ``generic``). Best-effort: a scan
    failure degrades to ``['generic']`` (never raises — domain selection must not
    wedge a run)."""
    names: set[str] = {"generic"}
    root = skill_root(ctx)
    if root:
        try:
            for p in (Path(root) / "resources").iterdir():
                if p.is_dir():
                    names.add(p.name)
        except Exception:  # noqa: BLE001 — best-effort listing
            pass
    return sorted(names)


# ---------------------------------------------------------------------------
# Item 11 — deterministic ARTIFACT FACTS: a rules-tier floor beneath vera's
# judgement, covering the things she previously COUNTED and self-reported.
#
# Motivation (measured 2026-07-28): vera's evidence asserted "success_criteria map
# 1:1 onto Narrative SM1-SM6" when it was 5 criteria vs 6 metrics. A countable fact,
# asserted rather than computed, wrong, and unchecked. Anything derivable from the
# artifacts should be derived by CODE and handed to the verifier as a given, leaving
# her to judge only what cannot be counted (prose quality, measurability).
#
# Structure is DERIVED, never a hardcoded vocabulary: the narrative's expected
# sections are read from prd-template.md at runtime, and the catalog/matrix checks
# are set comparisons between the artifacts themselves, so they keep working if the
# schema changes (which item 16 will do).
# ---------------------------------------------------------------------------

_SECTION_RE = re.compile(r"(?m)^#{2,3}\s*(\d+)\.")


def _extract_json(text: str):
    """First JSON array/object embedded in a drawer body, or None. Drawers carry a
    header line before the payload, so this scans for the first bracket and parses
    the balanced span. Never raises."""
    if not text:
        return None
    # Scan from the EARLIEST bracket of either kind. Trying "[" first regardless of
    # position makes a JSON *object* whose values contain arrays parse as the inner
    # array (e.g. {"REQ-001": {"unit_tests": ["t"]}} -> ["t"]), silently losing the
    # whole matrix.
    candidates = sorted(
        (text.find(o), o, c) for o, c in (("[", "]"), ("{", "}")) if text.find(o) != -1
    )
    for start, opener, closer in candidates:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except Exception:  # noqa: BLE001
                        break
    return None


# The drawer headers are the skill's documented output CONTRACT (SKILL.md §Mempalace
# Output Contract), so matching them exactly is an interface check — not a heuristic.
_ARTIFACT_MARKERS = (
    ("narrative", "prd narrative"),
    ("requirement catalog", "requirement catalog"),
    ("verification matrix", "verification matrix"),
)


def select_artifacts(drawers) -> dict:
    """Pick the CURRENT narrative / catalog / matrix from a room's drawers.

    ``drawers`` is an iterable of ``(text, filed_at)``. A revising run leaves several
    versions of each artifact in the room plus verifier reports and notes, so:

      * match the drawer's HEADER LINE only, against the exact contract name — a loose
        substring scan over the first 200 chars matched the ``Validate`` report (which
        discusses the narrative) and a ``Synthia Diagnostic Note - narrative-...`` note,
        both of which contain no sections, yielding a false "0 sections found";
      * skip verifier reports outright — they are commentary ON the artifacts;
      * keep the NEWEST by ``filed_at`` — otherwise an arbitrary earlier revision wins.
    """
    best: dict = {}
    for text, filed in drawers:
        if not text:
            continue
        header = text.split("\n", 1)[0].strip().lstrip("#").strip().lower()
        if "validate" in header:
            continue  # a verifier report is not an artifact
        for name, marker in _ARTIFACT_MARKERS:
            if marker in header:
                prior = best.get(name)
                if prior is None or str(filed) >= prior[1]:
                    best[name] = (text, str(filed))
                break
    return {name: text for name, (text, _) in best.items()}


def declared_sections(skill_dir: str) -> set:
    """The section numbers prd-template.md DECLARES. Read at runtime so the count is
    the template's, not a constant baked into code (change the template, the check
    follows). Empty set when unreadable -> section facts are simply omitted."""
    if not skill_dir:
        return set()
    try:
        text = (Path(skill_dir) / "resources" / "prd-template.md").read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return set()
    return {int(n) for n in _SECTION_RE.findall(text)}


def artifact_facts(
    narrative: str = "", catalog=None, matrix=None, ideal=None, declared: set | None = None
) -> dict:
    """Deterministically computed facts about one run's four artifacts. Pure.

    Every value here is a COUNT or a SET COMPARISON — no judgement, no field-name
    vocabulary beyond the id key the catalog and matrix must agree on to be joinable
    at all. Missing/unparseable artifacts simply omit their facts.
    """
    facts: dict = {}

    if narrative:
        found = {int(n) for n in _SECTION_RE.findall(narrative)}
        facts["narrative_sections_found"] = len(found)
        if declared:
            facts["narrative_sections_declared"] = len(declared)
            facts["narrative_sections_missing"] = sorted(declared - found)

    ids: list = []
    if isinstance(catalog, list):
        for item in catalog:
            if isinstance(item, dict):
                # The id key is discovered, not assumed: whichever key holds a
                # REQ-like token. Keeps working if the catalog schema is renamed.
                for key, value in item.items():
                    if isinstance(value, str) and re.fullmatch(r"[A-Za-z]+-\d+", value.strip()):
                        ids.append(value.strip())
                        facts.setdefault("catalog_id_key", key)
                        break
        facts["requirement_count"] = len(catalog)
        facts["catalog_ids"] = len(ids)
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        facts["catalog_duplicate_ids"] = dupes
        # Field-set consistency WITHOUT naming fields: the majority key-set is the
        # de-facto declared shape; report entries that deviate from it.
        keysets = [frozenset(i) for i in catalog if isinstance(i, dict)]
        if keysets:
            common = max(set(keysets), key=keysets.count)
            facts["catalog_entries_with_odd_fields"] = sum(1 for k in keysets if k != common)

    if isinstance(matrix, dict):
        keys = {str(k) for k in matrix}
        facts["matrix_keys"] = len(keys)
        if ids:
            idset = set(ids)
            facts["matrix_missing_ids"] = sorted(idset - keys)
            facts["matrix_unknown_ids"] = sorted(keys - idset)
        empty = []
        for key, value in matrix.items():
            if isinstance(value, dict):
                if not any(bool(v) for v in value.values()):
                    empty.append(str(key))
            elif not value:
                empty.append(str(key))
        facts["matrix_ids_without_strategy"] = sorted(empty)

    if isinstance(ideal, dict):
        criteria = ideal.get("success_criteria")
        if isinstance(criteria, list):
            facts["ideal_success_criteria"] = len(criteria)
        deliverables = ideal.get("deliverables")
        if isinstance(deliverables, list):
            facts["ideal_deliverables"] = len(deliverables)

    return facts


def hard_contradictions(facts: dict) -> list[str]:
    """Objective, non-negotiable inconsistencies — the rules-tier FLOOR.

    Deliberately narrow: only facts that are wrong under ANY reading of the schema.
    Section coverage is reported but NOT floored (whether every template section is
    mandatory is still under review — a live run showed sections are used as thinking
    prompts, not padding), and a criteria/metric count difference is reported as a
    fact for the verifier rather than failed, since merging two metrics into one
    criterion is defensible.
    """
    out: list[str] = []
    if facts.get("catalog_duplicate_ids"):
        out.append(f"catalog has duplicate ids: {facts['catalog_duplicate_ids']}")
    if facts.get("matrix_missing_ids"):
        out.append(
            f"verification matrix omits requirement(s): {facts['matrix_missing_ids']}"
        )
    if facts.get("matrix_unknown_ids"):
        out.append(
            f"verification matrix references unknown id(s): {facts['matrix_unknown_ids']}"
        )
    if facts.get("matrix_ids_without_strategy"):
        out.append(
            "requirement(s) with no verification strategy: "
            f"{facts['matrix_ids_without_strategy']}"
        )
    return out


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class PrdMachine(StateMachine):
    intake = State(initial=True)
    generating = State()  # synthia: clarification-questions / synthesis / revision
    validating = State()  # vera: schema + quality + traceability
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_generate = intake.to(generating)
    synthesize = generating.to.itself()  # clarification pass yielded nothing -> full synthesis
    generate_done = generating.to(validating)
    validate_pass = validating.to(complete)
    revise = validating.to(generating)  # issues found && within budget
    validate_exhausted = validating.to(complete)  # budget spent; met=False

    to_unknown = generating.to(unknown) | validating.to(unknown)
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(generating)
    abort = (
        intake.to(error)
        | generating.to(error)
        | validating.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts. Only ``complete`` / ``valid`` are required — the
# synthia prompt's three modes share ``complete`` but differ on everything else,
# and escalation rides needs_clarification via progress_check (plus the
# confidence field when the agent emits it).
# ---------------------------------------------------------------------------

PRD_GENERATE = PrimitiveSpec(
    "PRD_GENERATE",
    "synthia",
    _c(
        {"complete": bool},
        {
            "domain": str,  # model-declared best-fit guidance pack (R1)
            "requirement_count": int,
            "narrative_sections": int,
            "verification_matrix_complete": bool,
            "ideal_state_valid": bool,
            "needs_clarification": bool,
            "clarifying_questions": list,
            "resolved_issues": list,
            "confidence": str,
        },
    ),
    "Produce the layered PRD to the artifact interface in your guidance; the mode is "
    "signaled in the task. Write every artifact to mempalace.",
)
PRD_VALIDATE = PrimitiveSpec(
    "PRD_VALIDATE",
    "vera",
    _c(
        # Evidence-gated (Rec 4): a PASS must carry captured evidence (schema-check
        # output, section/coverage counts) or the engine's contract rejects it.
        {"valid": bool, "evidence": list, "confidence": str},
        {
            "ideal_state_valid": bool,
            "issues": list,
            "complete": bool,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
        evidence=["evidence"],
    ),
    "Validate the PRD artifacts against the check obligations in your guidance; emit "
    "valid + issues + the evidence you captured.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders (legacy wording preserved verbatim; the room +
# the wing=penny mempalace instructions drive the drawer headers the synthia/vera
# prompts write, which the code skill depends on)
# ---------------------------------------------------------------------------


def _room(ctx: RunContext) -> str:
    return f"skills/prd-{ctx.session_id}"


def _effective_mode(ctx: RunContext) -> str:
    """The synthia mode for the NEXT generating dispatch. ``mode`` lives in
    ctx.extras['prd']; a clarify resume (which sets ctx.clarification_text)
    promotes the clarify-first mode to a full synthesis."""
    prd = ctx.extras.get("prd", {})
    mode = prd.get("mode", "clarification")
    if mode == "clarification" and ctx.clarification_text:
        return "synthesis"
    return mode


def _domain_line(prd: dict) -> str:
    """Run fact: the resolved domain, or an instruction to declare one from the
    available packs (model-owned selection). No keyword table."""
    domain = prd.get("domain") or ""
    if domain:
        return f"Domain: {domain}. "
    available = prd.get("available_domains") or ["generic"]
    return (
        f"Available domain guidance packs: {', '.join(available)}. Choose the best fit "
        f"for the goal and declare it as `domain` in your SUMMARY. "
    )


def _guidance_line(prd: dict) -> str:
    """Run fact: the ABSOLUTE guidance root. Agents run with ``cwd = project_root``,
    so a repo-relative path like ``resources/prd-template.md`` resolves against the
    wrong tree on any run whose project_root is not this repo."""
    root = prd.get("skill_root") or ""
    if not root:
        return ""
    return (
        f"Guidance root (ABSOLUTE — read from here, not from your cwd): {root}/resources/. "
        f"Always read {root}/resources/prd-template.md; for a matched domain also read "
        f"{root}/resources/<domain>/. "
    )


def _build_generate(pb: "PrdPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    """Run facts only (R3): session, goal, domain, room, mode, absolute paths. The
    artifact interface lives once in synthia.md — not restated here as procedure."""
    prd = ctx.extras.get("prd", {})
    room = _room(ctx)
    mode = _effective_mode(ctx)
    head = f"Session: {ctx.session_id}. Goal: {ctx.goal}. {_domain_line(prd)}"
    tail = f"Mempalace room: {room} (wing=penny). " + _guidance_line(prd)
    if mode == "clarification":
        return head + tail + "Mode: CLARIFICATION QUESTIONS."
    if mode == "revision":
        issues_str = "; ".join(str(i) for i in prd.get("issues", []))
        return (
            head + tail + "Mode: REVISION. Address every issue below, and address it "
            f"differently from the attempt that failed: {issues_str}."
        )
    return head + tail + "Mode: SYNTHESIS."


def _build_validate(pb: "PrdPlaybook", ctx: RunContext, spec: PrimitiveSpec) -> str:
    """Run facts only (R3): the check obligations live once in vera.md."""
    prd = ctx.extras.get("prd", {})
    room = _room(ctx)
    base = (
        f"Session: {ctx.session_id}. Goal: {ctx.goal}. "
        f"Domain: {prd.get('domain') or 'generic'}. "
        f"Mempalace room: {room} (wing=penny). " + _guidance_line(prd)
    )
    oracle = prd.get("validator_path") or ""
    if oracle:
        base += (
            f"Artifact oracle (ABSOLUTE — invoke exactly this, your cwd is not this repo): "
            f"`python3 {oracle} --stdin`. "
        )
    computed = prd.get("artifact_facts") or {}
    if computed:
        # Item 11: hand vera the counts CODE derived, so a verdict is judged against
        # computed truth instead of her own re-counting (a live run showed a
        # confidently-asserted "1:1" mapping that was actually 5 vs 6).
        rendered = "; ".join(f"{k}={v}" for k, v in sorted(computed.items()))
        base += (
            "Counts already computed deterministically from the artifacts (treat these as "
            f"GIVEN — do not re-derive or contradict them without saying why): {rendered}. "
            "Spend your judgement on what cannot be counted: prose quality, whether criteria "
            "are genuinely measurable, and cross-artifact meaning. "
        )
    if prd.get("schema_checked") is False:
        # T4 fail-loud (item 9): last round the deterministic floor could not read
        # the IDEAL_STATE, so vera's verdict was the ONLY oracle on it. Say so.
        base += (
            "NOTE: the engine's deterministic schema floor could NOT read your IDEAL_STATE last "
            "round, so your executed check is the only oracle for it — run it and paste the "
            "captured output as evidence. "
        )
    return base + "Validate the PRD artifacts and emit valid + issues + captured evidence."


_TASK_BUILDERS = {
    "generating": _build_generate,
    "validating": _build_validate,
}


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class PrdPlaybook(BasePlaybook):
    NAME = "prd"
    machine_cls = PrdMachine
    PRIMITIVE_BY_STATE = {
        "generating": PRD_GENERATE,
        "validating": PRD_VALIDATE,
    }
    ESCALATABLE_STATES = frozenset({"generating", "validating"})

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        if not (ctx.goal or "").strip():
            raise RuntimeError("prd skill requires a non-empty goal")
        if "max_iterations" not in (ctx.constraints or {}):
            # Tagged LOAN ``prd_revision_budget``: the base 5 is a human guess tuned to a
            # past model, so it rides tier_budget (PI_MODEL_TIER) with a hard ceiling
            # rather than sitting frozen. Ablated, the engine's generic default stands.
            if loan_enabled("prd_revision_budget"):
                ctx.max_iterations = tier_budget(5, ceiling=8)
        prd = ctx.extras.setdefault("prd", {})
        prd["available_domains"] = available_domains(ctx)
        # Resolve the absolute paths ONCE and checkpoint them: agents spawn with
        # cwd = project_root, so cwd-relative guidance/validator paths silently miss
        # on any run targeting another repo.
        prd["skill_root"] = skill_root(ctx)
        prd["validator_path"] = validator_path()
        # Caller constraint wins; otherwise the domain is model-declared (captured
        # in route_after from synthia's SUMMARY). No keyword detection.
        caller_domain = str((ctx.constraints or {}).get("domain", ""))
        prd["domain"] = caller_domain if caller_domain else ""
        prd["mode"] = "clarification"  # clarify-first HITL: questions before artifacts
        self.sm.send("start_generate")
        return "generating"

    # -- progress / escalation gate (needs_clarification + stall) ----------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if summary.get("needs_clarification"):
            prd = ctx.extras.setdefault("prd", {})
            qs = [str(q) for q in (summary.get("clarifying_questions") or [])]
            if qs:
                prd["clarifying_questions"] = qs
            detail = f": {'; '.join(qs)}" if qs else ""
            return f"{state} agent requested clarification{detail}"
        if state == "validating" and not (
            summary.get("valid") and summary.get("ideal_state_valid", False)
        ):
            if self.is_stalled(ctx, summary.get("issues", [])):
                return (
                    "the same PRD validation issues have persisted across revisions with no "
                    "measurable progress — escalating rather than fabricating a valid PRD"
                )
        return None

    # -- routing -----------------------------------------------------------
    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:
        prd = ctx.extras.setdefault("prd", {})
        if state == "generating":
            # Capture the model-declared domain (R1) unless a caller constraint
            # already fixed it. Unknown declarations fall back to generic
            # (fail-safe, not fail-loud — an odd domain must not kill a run).
            if not prd.get("domain"):
                declared = str(summary.get("domain") or "")
                available = prd.get("available_domains") or ["generic"]
                prd["domain"] = declared if declared in available else "generic"
            prd["requirement_count"] = summary.get("requirement_count", 0)
            prd["narrative_sections"] = summary.get("narrative_sections", 0)
            prd["verification_matrix_complete"] = summary.get("verification_matrix_complete", False)
            prd["ideal_state_valid"] = summary.get("ideal_state_valid", False)
            if _effective_mode(ctx) == "clarification" and prd["requirement_count"] == 0:
                # A clarification pass that produced neither questions
                # (needs_clarification would have escalated in progress_check)
                # nor artifacts: dispatch a full synthesis instead of sending
                # vera an empty room. One-shot — mode leaves "clarification"
                # permanently, so this self-loop cannot spin.
                prd["mode"] = "synthesis"
                self.sm.send("synthesize")
            else:
                prd["mode"] = "synthesis"
                self.sm.send("generate_done")
        elif state == "validating":
            valid = summary["valid"]
            ideal_ok = summary.get("ideal_state_valid", False)
            issues = list(summary.get("issues", []) or [])
            # T4: a deterministic CODE schema-floor beneath vera's quality judgement — a
            # schema-malformed IDEAL_STATE is rejected by RULES (validate_ideal_state), never
            # on vera's say-so. Unreadable (not yet written / test) -> skipped, vera stands.
            # Read ONCE here and share it with the floor + the learning-loop capture below.
            ideal = self._read_ideal_state(ctx)
            schema_ok, schema_errors = self._schema_check_ideal_state(ctx, ideal)
            if schema_ok is False:
                ideal_ok = False
                issues = issues + [f"schema: {e}" for e in schema_errors]
                prd["schema_evidence"] = schema_errors
            prd["schema_checked"] = schema_ok is not None
            # Item 11: rules-tier facts + floor. Objective contradictions (duplicate ids,
            # matrix/catalog mismatch, a requirement with no verification strategy) are
            # decided by CODE and cannot pass on the verifier's say-so.
            facts = self._artifact_facts(ctx, ideal)
            if facts:
                prd["artifact_facts"] = facts
                contradictions = hard_contradictions(facts)
                if contradictions:
                    valid = False
                    issues = issues + [f"artifact: {c}" for c in contradictions]
                    prd["artifact_contradictions"] = contradictions
            prd["valid"] = valid
            prd["ideal_state_valid"] = ideal_ok  # code schema-floor stacked on vera's verdict
            prd["issues"] = issues
            # Learning-loop signal (item 6): downstream readers use the STANDARD context
            # fields, not ctx.extras. Without this every prd run landed with empty
            # verify_gaps and no verdict, so a failure carried no usable signal.
            # vera's issues and the spec's own criteria ARE the signal; publish them.
            ctx.verify_gaps = [str(i) for i in issues]
            ctx.verify_verdict = VERDICT_PASS if (valid and ideal_ok) else VERDICT_FAIL
            if isinstance(ideal, dict):
                criteria = ideal.get("success_criteria")
                if isinstance(criteria, list) and criteria:
                    ctx.success_criteria = [str(c) for c in criteria]
            if valid and ideal_ok:
                self.sm.send("validate_pass")
            elif ctx.iteration + 1 < ctx.max_iterations:
                # Record the iteration digest so the next validation's
                # progress_check can detect a stalled revision loop (Rec 2).
                self.record_iteration(ctx, gaps=issues, confidence=summary.get("confidence", ""))
                ctx.iteration += 1
                prd["mode"] = "revision"
                self.sm.send("revise")
            else:
                # Honest exhaustion (fix vs. legacy "forcing completion"):
                # complete with met=False + the unresolved issues, never a
                # fabricated valid=True.
                prd["exhausted"] = True
                self.sm.send("validate_exhausted")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    # -- T4: deterministic IDEAL_STATE schema-floor beneath vera's judgement ------
    def _read_ideal_state(self, ctx: RunContext):
        """The IDEAL_STATE this prd run produced, read from its mempalace room, or None.
        Skipped under pytest (hermetic) unless a test overrides this; production reuses the
        code skill's loader (room read + chunk reassembly). Best-effort, never raises."""
        if "PYTEST_CURRENT_TEST" in os.environ:
            return None
        try:
            from .code import load_ideal_state
            return load_ideal_state({"prd_room": f"skills/prd-{ctx.session_id}"}, ctx.project_root)
        except Exception:
            return None

    def _schema_check_ideal_state(self, ctx: RunContext, ideal: object = _UNREAD):
        """(True, []) valid / (False, [errors]) schema-malformed / (None, []) unreadable => skip.
        The rules-tier floor: validate_ideal_state.validate_json is deterministic CODE, so a
        schema-malformed IDEAL_STATE cannot pass on vera's say-so. Never raises.

        ``ideal`` may be supplied by a caller that already loaded it (route_after), avoiding a
        second MemPalace read; omitted, it is read here."""
        if ideal is _UNREAD:
            ideal = self._read_ideal_state(ctx)
        if not isinstance(ideal, dict):
            return None, []
        try:
            path = validator_path()
            if path:
                parent = str(Path(path).parent)
                if parent not in sys.path:
                    sys.path.insert(0, parent)
                from validate_ideal_state import validate_json  # type: ignore[import-not-found]
                ok, errors = validate_json(ideal)
                return bool(ok), [str(e) for e in (errors or [])]
        except Exception:
            return None, []
        return None, []

    def model_for_state(self, state: str, ctx: RunContext) -> str | None:
        """Opt-in cross-model verification hook (REQ-001/REQ-002).

        ``independence.py`` classifies prd's synthia->vera edge SAME_MODEL: both agents
        run sonnet, so vera's PASS is a same-model bare judgement over synthia's own
        work, and correlated single-model errors can slip a false PASS through. This
        gives a caller (or ops) a hook to pull, mirroring jsa/sca.

        Precedence for ``validating``: ``constraints['validate_model']`` -> the
        ``PRD_VERA`` / ``PRD_DEFAULT`` env tier -> ``None`` (vera's own configured
        model). The key is ``validate_model``, not jsa/sca's ``reverify_model``: prd has
        no reverify pass, ``validating`` is its only verify state.

        UNSET IS UNCHANGED: with no constraint and no env var, this returns ``None`` for
        every state, so vera and synthia run exactly the models their own
        ``.pi/agents/*.md`` frontmatter declares. This is an opt-in hook, never a default
        reassignment (a default change would be a cost/latency shift needing loan
        registration + ablation). The edge therefore stays SAME_MODEL and remains a
        registered exception.
        """
        if state == "validating":
            chosen = str((ctx.constraints or {}).get("validate_model", "")).strip()
            if chosen:
                return chosen
        return self._env_model_override("PRD", state)

    # -- item 11: deterministic artifact facts ----------------------------------
    def _read_artifacts(self, ctx: RunContext) -> dict:
        """The run's narrative / catalog / matrix drawer bodies, keyed by artifact.

        Skipped under pytest (hermetic) unless a test overrides this; production reads
        the session room and reassembles chunked drawers. Best-effort, never raises.
        """
        if "PYTEST_CURRENT_TEST" in os.environ:
            return {}
        try:
            import chromadb

            penny = os.environ.get("PROJECT_ROOT") or ctx.project_root or "."
            client = chromadb.PersistentClient(path=str(Path(penny) / ".mempalace"))
            drawers = client.get_collection("mempalace_drawers")
            res = drawers.get(
                where={"$and": [{"room": _room(ctx)}, {"wing": "penny"}]}, limit=1000
            ) or {}
            docs = res.get("documents") or []
            metas = res.get("metadatas") or []
            # Reassemble chunked drawers (non-overlapping, ordered by chunk_index).
            groups: dict = {}
            for i, doc in enumerate(docs):
                if not doc:
                    continue
                meta = (metas[i] if i < len(metas) else None) or {}
                key = meta.get("drawer_key") or f"__solo_{i}"
                try:
                    idx = int(meta.get("chunk_index", 0))
                except (TypeError, ValueError):
                    idx = 0
                chunks, filed = groups.setdefault(key, ([], ""))
                chunks.append((idx, doc))
                groups[key] = (chunks, max(filed, str(meta.get("filed_at", ""))))
            return select_artifacts(
                [
                    ("".join(t for _, t in sorted(chunks, key=lambda p: p[0])), filed)
                    for chunks, filed in groups.values()
                ]
            )
        except Exception:  # noqa: BLE001 — best-effort; facts are additive
            return {}

    def _artifact_facts(self, ctx: RunContext, ideal=None) -> dict:
        """Compute this run's artifact facts, or {} when the artifacts are unreadable."""
        try:
            arts = self._read_artifacts(ctx)
            if not arts and not isinstance(ideal, dict):
                return {}
            prd = ctx.extras.get("prd", {})
            return artifact_facts(
                narrative=arts.get("narrative", ""),
                catalog=_extract_json(arts.get("requirement catalog", "")),
                matrix=_extract_json(arts.get("verification matrix", "")),
                ideal=ideal,
                declared=declared_sections(prd.get("skill_root", "")),
            )
        except Exception:  # noqa: BLE001 — never break a run on a facts failure
            return {}

    def done_predicate(self, ctx: RunContext) -> bool:
        prd = ctx.extras.get("prd", {})
        return bool(prd.get("valid")) and bool(prd.get("ideal_state_valid"))

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(self, ctx, spec)
            if builder
            else f"{spec.task_hint}\nGoal: {ctx.goal}"
        )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def result_payload(self, ctx: RunContext) -> dict:
        prd = ctx.extras.get("prd", {})
        return {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "prd_summary": {
                "goal": ctx.goal,
                "domain": prd.get("domain", "generic"),
                "requirement_count": prd.get("requirement_count", 0),
                "narrative_sections": prd.get("narrative_sections", 0),
                "verification_matrix_complete": prd.get("verification_matrix_complete", False),
                "ideal_state_valid": prd.get("ideal_state_valid", False),
                "session_id": ctx.session_id,
                "requires_approval": True,
            },
            # T4 fail-loud (item 9): whether the deterministic floor actually RAN is part
            # of the result, not a silent internal. A run whose oracle was skipped must not
            # look identical to one where it passed.
            "schema_checked": bool(prd.get("schema_checked", False)),
            "schema_evidence": prd.get("schema_evidence", []),
            # Item 11: the counts CODE derived (supersede the agent's self-report) and
            # any objective contradiction the rules floor caught.
            "artifact_facts": prd.get("artifact_facts", {}),
            "artifact_contradictions": prd.get("artifact_contradictions", []),
            "session_room": _room(ctx),
            # legacy parity: the extension's chain handler injects prd_room into
            # the next chain step's constraints from session_room/room.
            "mempalace_drawers": {"wing": "penny", "room": _room(ctx)},
            "exhausted": prd.get("exhausted", False),
            "unresolved_issues": prd.get("issues", []) if prd.get("exhausted") else [],
        }
