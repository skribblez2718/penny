"""CodePlaybook — the code skill on the shared engine.

A faithful behavioral port of the legacy 1895-line ``.pi/skills/code`` orchestrator
onto ``BasePlaybook``: custom-named states (exploring→analyzing→checking_criteria
→[criteria_gate]→planning→plan_gate→implementing→verifying⇄learning), per-state
SUMMARY contracts, the implement⇄verify Ralph-Wiggum loop, both HITL gates on the
engine's planned-gate seam, and an OPTIONAL PRD/IDEAL_STATE resolved at start()
(present → its criteria drive the run; absent → criteria are synthesized from the goal).

Two deliberate behavior fixes vs. the legacy runtime (which routed on an imperative
walk, not its dead declared FSM): plan-deny now terminates in ``error`` instead of a
false "IDEAL STATE achieved" complete; and a failing FINAL verify loops back to
``learning`` instead of completing regardless. The domain value — framework
detection and the rich per-state prompts — is preserved verbatim (detection in
``code_detection.py``; prompts in the task builders below).
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from statemachine import State, StateMachine

from ..context import RunContext
from ..engine import BasePlaybook
from ..primitives.spec import PrimitiveSpec
from . import code_detection

# ---------------------------------------------------------------------------
# PRD dependency (OPTIONAL) — IDEAL_STATE resolution
# ---------------------------------------------------------------------------


def _find_embedded_ideal_state(text: str) -> dict | None:
    """Scan ``text`` for the first embedded JSON object that is an IDEAL_STATE.

    Used when a drawer wraps its JSON body in a human-readable title line
    and/or a prose CHANGE-LOG preface, so the drawer as a whole is not valid
    JSON. Walks each ``{`` position, attempts a ``raw_decode`` there, and
    returns the first decoded object exposing a truthy top-level
    ``success_criteria``. Advances past each successfully decoded object so
    unrelated JSON (e.g. a Requirement Catalog array of REQ dicts) is skipped
    rather than re-parsed; braces inside prose that do not open valid JSON
    fail fast and are stepped over one character at a time.
    """
    decoder = json.JSONDecoder()
    idx = text.find("{")
    while idx != -1:
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            idx = text.find("{", idx + 1)
            continue
        if isinstance(obj, dict) and obj.get("success_criteria"):
            return obj
        # Decoded a non-IDEAL_STATE object; resume scanning after it.
        idx = text.find("{", max(end, idx + 1))
    return None


def _try_ideal_state(text: str) -> dict | None:
    """Return the IDEAL_STATE dict embedded in ``text`` (a dict with a truthy
    ``success_criteria``), or None.

    Tolerant by design. The prd skill stores each artifact drawer with a
    human-readable title line, and revised artifacts additionally carry a
    prose CHANGE-LOG preface *before* the JSON body. A strict ``json.loads``
    of the whole drawer therefore fails on exactly the drawers that DO hold a
    valid IDEAL_STATE. We first try a strict parse (pure-JSON drawers, the
    common case, behaviour unchanged), then fall back to scanning for the
    first embedded IDEAL_STATE object. Non-IDEAL_STATE artifacts (Requirement
    Catalog arrays, Verification Matrix maps, prose narratives) never expose a
    top-level ``success_criteria`` and are correctly rejected either way.
    """
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, dict) and parsed.get("success_criteria"):
        return parsed
    if parsed is not None:
        # The drawer is a single JSON document that is not an IDEAL_STATE
        # (e.g. a Verification Matrix map or a Requirement Catalog array).
        # There is no title/preface to strip, so nothing more to find.
        return None
    return _find_embedded_ideal_state(text)


def _latest_ideal_state(documents: list, metadatas: list) -> dict | None:
    """Find the newest IDEAL_STATE among MemPalace drawer documents.

    The memory bridge splits content over its chunk threshold into NON-overlapping
    sibling chunks that share a ``drawer_key`` and are ordered by ``chunk_index``
    (scripts/system/bridge/memory_bridge.py::_chunk_text is a clean
    ``content[i:i+size]`` split). A chunked IDEAL_STATE is therefore invalid JSON
    per-chunk; concatenating a drawer's chunks in ``chunk_index`` order exactly
    restores the original. This groups documents by ``drawer_key``, reassembles
    each group, and returns the IDEAL_STATE with the latest ``filed_at`` so a
    revised PRD wins over an earlier one. Unchunked drawers form a single-element
    group; documents lacking a ``drawer_key`` are treated as their own solo group
    so pre-metadata drawers still parse.
    """
    documents = documents or []
    metadatas = metadatas or []
    groups: dict[str, dict[str, Any]] = {}
    for i, doc in enumerate(documents):
        if not doc:
            continue
        meta = (metadatas[i] if i < len(metadatas) else None) or {}
        key = meta.get("drawer_key") or f"__solo_{i}"
        try:
            idx = int(meta.get("chunk_index", 0))
        except (TypeError, ValueError):
            idx = 0
        group = groups.setdefault(key, {"chunks": [], "filed_at": ""})
        group["chunks"].append((idx, doc))
        filed_at = str(meta.get("filed_at", ""))
        if filed_at > group["filed_at"]:
            group["filed_at"] = filed_at

    best: tuple[str, dict] | None = None  # (filed_at, ideal_state)
    for group in groups.values():
        group["chunks"].sort(key=lambda pair: pair[0])
        reassembled = "".join(text for _, text in group["chunks"])
        parsed = _try_ideal_state(reassembled)
        if parsed is None:
            continue
        if best is None or group["filed_at"] > best[0]:
            best = (group["filed_at"], parsed)
    return best[1] if best else None


def load_ideal_state(constraints: dict, project_root: str) -> dict | None:
    """Resolve the IDEAL_STATE the code skill depends on.

    Direct: ``constraints["ideal_state"]`` (with success_criteria). Chain fallback:
    ``constraints["prd_room"]`` ("skills/prd-…") → look the drawer(s) up in MemPalace,
    reassembling chunked drawers (see ``_latest_ideal_state``). Returns the
    ideal_state dict, or None when the PRD dependency is unmet.
    """
    constraints = constraints or {}
    ideal = constraints.get("ideal_state")
    if isinstance(ideal, dict) and ideal.get("success_criteria"):
        return ideal

    prd_room = constraints.get("prd_room", "")
    if prd_room and prd_room.startswith("skills/prd-"):
        try:
            import chromadb  # lazy: only the chain-fallback path needs it
            from pathlib import Path

            # Mempalace is Penny-global: it ALWAYS anchors to the constant
            # $PROJECT_ROOT (.env), never the per-run target project_root a skill
            # operates on (that points at the work repo, e.g. a downstream app).
            # Mirrors checkpointer/outcome_writer/recall. Deriving the path from the
            # passed project_root looks in the wrong (or a nonexistent) .mempalace.
            penny_root = os.environ.get("PROJECT_ROOT") or project_root or "."
            client = chromadb.PersistentClient(path=str(Path(penny_root) / ".mempalace"))
            try:
                drawers = client.get_collection("mempalace_drawers")
            except Exception:
                drawers = None
            if drawers is not None:
                # limit is high headroom: a chunked IDEAL_STATE must retrieve ALL
                # of its sibling chunks or reassembly is incomplete. PRD rooms are
                # bounded (a handful of artifacts x a few chunks each).
                results = (
                    drawers.get(where={"$and": [{"room": prd_room}, {"wing": "penny"}]}, limit=1000)
                    or {}
                )
                found = _latest_ideal_state(
                    results.get("documents") or [],
                    results.get("metadatas") or [],
                )
                if found is not None:
                    return found
        except Exception as exc:  # pragma: no cover - best effort
            print(f"MemPalace IDEAL_STATE lookup failed: {exc}", file=sys.stderr)
    return None


def ideal_state_from_goal(goal: str) -> dict:
    """Synthesize a minimal IDEAL_STATE from the run goal when NO PRD is present.

    The PRD is OPTIONAL. With one, its criteria drive the run; without one, the
    skill runs in goal-driven mode from these synthesized criteria. carren still
    judges/refines them at the criteria gate, and the implement<->verify test
    battery remains the real acceptance bar — so dropping the PRD mandate keeps the
    quality loop, it only removes the ceremony.
    """
    goal = (goal or "").strip()
    return {
        "success_criteria": [
            f"The goal is fully implemented as stated: {goal}"
            if goal
            else "The stated goal is fully implemented.",
            "New and changed behavior is covered by tests that pass at the applicable tiers.",
            "The change follows the repository's coding standards and introduces no regressions.",
        ],
        "deliverables": [],
        "verification": {},
        "_synthesized_from_goal": True,
    }


# ---------------------------------------------------------------------------
# The FSM
# ---------------------------------------------------------------------------


class CodeMachine(StateMachine):
    intake = State(initial=True)
    exploring = State()
    analyzing = State()
    checking_criteria = State()  # carren judges criteria quality (Gate-1 evaluator)
    criteria_gate = State()  # HITL: refine / accept / skip
    planning = State()
    plan_gate = State()  # HITL: approve / refine / deny
    implementing = State()
    verifying = State()
    learning = State()
    unknown = State()
    awaiting_clarification = State()
    complete = State(final=True)
    error = State(final=True)

    start_explore = intake.to(exploring)
    explore_done = exploring.to(analyzing)
    analyze_done = analyzing.to(checking_criteria)
    criteria_ok = checking_criteria.to(planning)
    criteria_gap = checking_criteria.to(criteria_gate)
    criteria_accepted = criteria_gate.to(planning)  # user: accept / skip
    criteria_refined = criteria_gate.to(checking_criteria)  # user: refine -> re-run carren
    plan_done = planning.to(plan_gate)
    plan_approved = plan_gate.to(implementing)
    plan_refine = plan_gate.to(planning)
    plan_denied = plan_gate.to(error)  # deny is terminal error
    implement_done = implementing.to(verifying)
    verify_done = verifying.to(learning)  # carren judges the gap
    final_verify_pass = verifying.to(complete)
    final_verify_fail = verifying.to(learning)  # regressions loop
    learn_retry = learning.to(implementing)  # gap && within budget
    learn_final_verify = learning.to(verifying)  # no gap -> one last battery
    learn_exhausted = learning.to(complete)  # budget spent; met=False

    to_unknown = (
        exploring.to(unknown)
        | analyzing.to(unknown)
        | checking_criteria.to(unknown)
        | planning.to(unknown)
        | implementing.to(unknown)
        | verifying.to(unknown)
        | learning.to(unknown)  # stall / repeated-strategy escalation (Recs 1 & 2)
    )
    escalate = unknown.to(awaiting_clarification)
    clarify = awaiting_clarification.to(exploring)
    abort = (
        intake.to(error)
        | exploring.to(error)
        | analyzing.to(error)
        | checking_criteria.to(error)
        | criteria_gate.to(error)
        | planning.to(error)
        | plan_gate.to(error)
        | implementing.to(error)
        | verifying.to(error)
        | learning.to(error)
        | unknown.to(error)
        | awaiting_clarification.to(error)
    )


# ---------------------------------------------------------------------------
# Per-state SUMMARY contracts (custom-named; validated against spec.summary_contract)
# ---------------------------------------------------------------------------


def _c(required: dict, optional: dict | None = None, evidence: tuple[str, ...] = ()) -> dict:
    contract: dict = {"required": required, "optional": optional or {}}
    if evidence:
        # Named required fields that must additionally be non-empty (Rec 4).
        contract["evidence"] = evidence
    return contract


CODE_EXPLORE = PrimitiveSpec(
    "CODE_EXPLORE",
    "echo",
    _c(
        {"findings_count": int, "confidence": str},
        {
            "sources_count": int,
            "mempalace_drawer": str,
            "needs_clarification": bool,
            "clarifying_questions": list,
        },
    ),
    "Deep-dive impacted files, patterns, test conventions, integration points. Always emit confidence.",
)
CODE_ANALYZE = PrimitiveSpec(
    "CODE_ANALYZE",
    "annie",
    _c(
        {"risks_identified": int, "confidence": str},
        {
            "findings_count": int,
            "critical": int,
            "high": int,
            "medium": int,
            "low": int,
            "security_docs_assigned": list,
            "mempalace_drawer": str,
        },
    ),
    "Assess security surface, integration risks, dependency conflicts, edge cases. Always emit confidence.",
)
CODE_CRITERIA = PrimitiveSpec(
    "CODE_CRITERIA",
    "carren",
    _c(
        {"gap": bool, "confidence": str},
        {"findings": list, "criteria_issues": dict, "mempalace_drawer": str},
    ),
    "Judge the IDEAL_STATE success_criteria themselves: measurable, achievable, precise, non-overlapping. Always emit confidence.",
)
CODE_PLAN = PrimitiveSpec(
    "CODE_PLAN",
    "piper",
    _c(
        {"plan_complete": bool, "confidence": str},
        {"plan_steps": int, "phases": int, "expected_test_failures": int, "mempalace_drawer": str},
    ),
    "Produce an implementation plan: dependency chains, build order, and a per-tier test "
    "strategy for the verification tiers the IDEAL STATE requires. Always emit confidence.",
)
CODE_IMPLEMENT = PrimitiveSpec(
    "CODE_IMPLEMENT",
    "skribble",
    _c(
        {"confidence": str},
        {
            "files_created": list,
            "files_modified": list,
            "tests_written": int,
            "tests_passing": int,
            "tests_failing": int,
            "expected_failure_details": list,
            "needs_clarification": bool,
        },
    ),
    "Implement the change and its tests to satisfy the IDEAL STATE; the required outcome is "
    "passing tests at the configured verification tiers (sequencing is yours). Read the mandated "
    "security + language resources before any code. Always emit confidence.",
)
CODE_VERIFY = PrimitiveSpec(
    "CODE_VERIFY",
    "skribble",
    _c(
        {"passed": bool, "confidence": str, "evidence": list},
        {
            "failures": list,
            "lint_passed": bool,
            "typecheck_passed": bool,
            "unit_passed": bool,
            "integration_passed": bool,
            "e2e_passed": bool,
        },
        # Externally-grounded VERIFY (Rec 4): the verdict must be backed by
        # captured command output (the tier commands' real results), never a bare
        # assertion. `evidence` must be present and non-empty.
        evidence=("evidence",),
    ),
    "Run every configured verification tier; report pass/fail per tier honestly with the captured command output as evidence. Always emit confidence.",
)
CODE_LEARN = PrimitiveSpec(
    "CODE_LEARN",
    "carren",
    _c(
        {"gap": bool},
        {"findings": list, "confidence": str, "mempalace_drawer": str, "strategy_change": str},
    ),
    "Compare output to IDEAL_STATE; gap=true loops to implement (state WHAT to do differently in strategy_change), gap=false triggers a final verification.",
)


# ---------------------------------------------------------------------------
# Per-state task prompt builders (ported verbatim from the legacy handlers)
# ---------------------------------------------------------------------------


def _build_explore(ctx: RunContext, code: dict, ideal: dict) -> str:
    return (
        f"Deep exploration. IDEAL STATE: {json.dumps(ideal)}. "
        f"Language: {code.get('language', 'python')}. "
        f"Find: all impacted files, existing patterns, coding conventions, "
        f"test patterns, integration points. "
        f"Session: {ctx.session_id} | "
        f"Sources: {', '.join(ideal.get('deliverables', []))}"
    )


def _build_analyze(ctx: RunContext, code: dict, ideal: dict) -> str:
    security_domains = ideal.get("security_review", [])
    security_docs = (
        " ".join(f"docs/agents/secure-coding/{d}.md" for d in security_domains)
        if security_domains
        else "docs/agents/secure-coding/AGENTS.md"
    )
    return (
        f"Analyze security and integration risks. IDEAL STATE: {json.dumps(ideal)}. "
        f"Review: {security_docs}. "
        f"Identify: vulnerability patterns, integration risks, dependency conflicts, "
        f"edge cases not in IDEAL STATE. Session: {ctx.session_id}"
    )


def _build_criteria(ctx: RunContext, code: dict, ideal: dict) -> str:
    criteria_list = ideal.get("success_criteria", [])
    return (
        "Evaluate the IDEAL_STATE criteria for quality and completeness. Do NOT "
        "evaluate implementation — there is none yet. Evaluate WHETHER THE CRITERIA "
        "THEMSELVES are well-formed.\n\nCriteria to evaluate:\n"
        + "\n".join(f"  [{i + 1}] {c}" for i, c in enumerate(criteria_list))
        + "\n\nFor each criterion, assess:\n"
        "  1. Is it measurable (can we objectively tell if it's met)?\n"
        "  2. Is it achievable within this project scope?\n"
        "  3. Is it precise (not vague like 'works well' or 'is fast')?\n"
        "  4. Is it non-overlapping with other criteria?\n\n"
        'Respond with SUMMARY: {"gap": true/false, "findings": ["..."], '
        '"criteria_issues": {"criterion_index": ["issue", ...]}, "confidence": "..."}\n\n'
        "If gap=true: list exactly which criteria need improvement and why.\n"
        "If gap=false: confirm the criteria are measurable and complete.\n\n"
        f"IDEAL STATE (full): {json.dumps(ideal)}\nSession: {ctx.session_id}"
    )


def _server_plan_block(ideal: dict) -> str:
    verification = ideal.get("verification", {})
    if not verification.get("server_startup"):
        return ""
    framework = verification.get("server_framework", "server")
    entry_points = verification.get("server_entry_points", [])
    return (
        f"\n\nSERVER-STARTUP OUTCOMES (this project ships a {framework} server):\n"
        f"A server project is only 'done' when these outcomes are demonstrated by real evidence in the verify phase — plan the test strategy that PROVES them (the exact shape of the tests is yours):\n"
        f"\n- The real {framework} server boots (background thread or subprocess) and serves real HTTP: representative endpoints return their expected status/body with the real framework, middleware, CORS, startup, and handlers (heavy deps like model downloads / databases / third-party APIs may be mocked).\n"
        f"- Each entry-point script runs from its own working directory with its import chain intact (the class of cwd / sys.path bugs unit tests miss).\n"
        f"- If the server uses CORS, a browser-origin preflight returns the correct access-control headers.\n"
        f"- At least one real happy-path flow runs end-to-end through the running server.\n"
        f"\nEntry points to cover: {entry_points if entry_points else '(auto-detect during implement)'}\n"
        f"`.pi/skills/code/resources/server-startup-tests.md` has proven, copy-pastable patterns for each — use it as a reference, not a script. These outcomes are checked by evidence in verify; passing unit tests alone do not satisfy them."
    )


def _build_plan(ctx: RunContext, code: dict, ideal: dict) -> str:
    return (
        f"Create an implementation plan. IDEAL STATE: {json.dumps(ideal)}. "
        f"Language: {code.get('language', 'python')}. "
        f"Include: dependency chains, build order (dependencies first), "
        f"phase-by-phase IDEAL STATES for each build step, and the test strategy for each "
        f"verification tier the IDEAL STATE requires (unit / integration / e2e / server-startup). "
        f"Note: integration/E2E tests may have unmet dependencies initially - "
        f"document these in the plan. Session: {ctx.session_id}"
        f"{_server_plan_block(ideal)}"
        f"{code_detection.build_multi_server_block(ctx)}"
    )


def _server_implement_block(ideal: dict) -> str:
    verification = ideal.get("verification", {})
    if not verification.get("server_startup"):
        return ""
    framework = verification.get("server_framework", "server")
    entry_points = verification.get("server_entry_points", [])
    entry_list = (
        "\n".join(f"   - {ep}" for ep in entry_points)
        if entry_points
        else "   (no specific entry points detected — locate by inspection)"
    )
    return (
        f"\n\nSERVER-STARTUP OUTCOMES (this project ships a {framework} server):\n"
        f"For a server project, 'done' means these are TRUE and shown by captured evidence in the verify phase — how you structure the tests is your call. Unit tests with mocked framework classes do NOT satisfy them (they miss middleware / CORS / startup / import-chain bugs):\n"
        f"\n- REAL SERVER SERVES REAL HTTP: the real {framework} server boots (background thread or subprocess) with heavy deps mocked (model downloads, databases, third-party APIs) but real framework / middleware / CORS / startup / handlers, and representative endpoints (e.g. /health, /, one business endpoint) return their expected status/body over real HTTP. Catches misconfigured middleware, CORS, startup / lifespan hooks, port conflicts.\n"
        f"\n- ENTRY-POINT IMPORT CHAIN HOLDS FROM ITS OWN CWD (recurring bug class): each entry point, run as a subprocess from inside its own directory, imports and exercises its import chain successfully. Many runners (uvicorn --reload wrappers, CLI tools, bundler dev servers) chdir to the script's directory before importing, so `from sibling_pkg import ...` silently breaks unless the script puts the project root on sys.path. A proven way to prove it: subprocess.run([sys.executable, '-c', '<driver that imports the entry point and exercises its imports>'], cwd=os.path.dirname(entry_point), check=True).\n"
        f"   Entry points:\n{entry_list}\n"
        f"\n- CORS PREFLIGHT CORRECT (if the server uses CORS): an OPTIONS request from a representative browser origin returns the correct access-control-allow-origin header.\n"
        f"\n- HAPPY PATH END-TO-END: at least one real business flow runs end-to-end through the running server (e.g. create → send → fetch → delete).\n"
        f"\n`.pi/skills/code/resources/server-startup-tests.md` has copy-pastable patterns — a reference to draw on, not a checklist to satisfy mechanically. These outcomes are checked by evidence in verify."
    )


def _build_implement(ctx: RunContext, code: dict, ideal: dict) -> str:
    language = code.get("language", "python")
    resource_path = f".pi/skills/code/resources/{language}.md"
    security_domains = ideal.get("security_review", [])
    security_refs = (
        "\n".join(f"- docs/agents/secure-coding/{d}.md" for d in security_domains)
        if security_domains
        else "docs/agents/secure-coding/AGENTS.md"
    )
    task = (
        f"Implement the change to satisfy the IDEAL STATE. "
        f"Iteration: {ctx.iteration + 1}. "
        f"IDEAL STATE: {json.dumps(ideal)}. "
        f"\n\nBEFORE WRITING ANY CODE, read these references: "
        f"\n1. {resource_path} - language conventions and best practices "
        f"\n2. .pi/skills/code/resources/security-checklist.md - mandatory security review "
        f"\n3. {security_refs} - security docs for: {', '.join(security_domains) if security_domains else 'all applicable domains'} "
        f"{code_detection.build_resource_context(ctx)}"
        f"{_server_implement_block(ideal)}"
        f"{code_detection.build_multi_server_block(ctx)}"
        f"\n\nOUTCOME (what 'done' means — the sequencing is yours; test-first, alongside, or "
        f"after are all fine): "
        f"\n- The code ships WITH tests, and every verification tier the IDEAL STATE marks true "
        f"(unit / integration / e2e / server-startup) PASSES in the verify phase with the "
        f"captured command output as evidence — a pass is backed by an oracle, never asserted. "
        f"\n- Use DRY methodology "
        f"\n- Use secure coding practices from referenced docs "
        f"\n- Package manager: match the one THIS project already uses — detect it from the repo's lockfile/manifest (uv.lock / poetry.lock / requirements.txt; bun.lockb / pnpm-lock.yaml / package-lock.json / yarn.lock) and do not switch a project's tooling. Greenfield / no established tooling -> default to the preferred stack: uv (Python), bun (JS/TS). "
        f"\n- Always activate .venv/ first for Python; NEVER install globally. "
        f"\n- Diagnose and fix test failures - the last change is always the breaking change "
        f"\n- Report expected test failures (integration/E2E with unmet dependencies) to the output "
    )
    findings = code.get("learn_findings", [])
    if findings:
        task += (
            "\n\nGAPS FROM LAST VERIFICATION:\n"
            + "\n".join(f"- {f}" for f in findings)
            + "\nADDRESS THESE GAPS FIRST."
        )
    task += f"\n\nSession: {ctx.session_id}"
    return task


# ── #10: discover the repo's OWN verify commands, so the verify agent runs what the
# project actually declares (Makefile targets, package.json scripts) instead of the
# hard-coded per-language guesses below. Deterministic + best-effort; the language
# defaults stay as the fallback for any enabled tier the repo declares nothing for.
# Never raises.
_VERIFY_HINT_RE = re.compile(
    r"\b(tests?|lint|check|typecheck|tsc|mypy|ruff|eslint|pytest|vitest|jest|"
    r"pyright|flake8|coverage|verify|build|ci)\b",
    re.IGNORECASE,
)


def _discover_repo_commands(project_root: str) -> list[dict]:  # noqa: C901
    """Surface the repo's own declared verify-ish commands from high-signal sources
    (Makefile targets, package.json scripts), filtered to lint/type/test/build-looking
    entries. Returns ``[{"source", "name", "command"}]``. Best-effort; never raises."""
    from pathlib import Path

    out: list[dict] = []
    if not project_root:
        return out
    root = Path(project_root)
    if not root.is_dir():
        return out
    # Makefile: target -> its first recipe line, surfaced as a runnable `make <target>`.
    mk = root / "Makefile"
    if mk.is_file():
        try:
            lines = mk.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            lines = []
        target: str | None = None
        for ln in lines:
            head = re.match(r"^([A-Za-z0-9][\w.-]*)\s*:(?!=)", ln)
            if head:
                target = head.group(1)
                continue
            if target and ln[:1] in ("\t", " ") and ln.strip():
                recipe = ln.strip().lstrip("@-")
                if not recipe.startswith("#") and _VERIFY_HINT_RE.search(f"{target} {recipe}"):
                    out.append(
                        {"source": "Makefile", "name": f"make {target}", "command": f"make {target}"}
                    )
                target = None  # only the first recipe line of each target
            elif ln.strip() and ln[:1] not in ("\t", " "):
                target = None
    # package.json: declared scripts (the repo's own test/lint/build invocations).
    pkg = root / "package.json"
    if pkg.is_file():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, ValueError):
            data = {}
        scripts = data.get("scripts") if isinstance(data, dict) else {}
        for name, cmd in (scripts or {}).items():
            if _VERIFY_HINT_RE.search(f"{name} {cmd}"):
                out.append({"source": "package.json", "name": str(name), "command": str(cmd)})
    return out[:20]


def _build_verify(ctx: RunContext, code: dict, ideal: dict) -> str:
    verification = ideal.get("verification", {})
    language = code.get("language", "python")
    commands: list[str] = []
    if verification.get("lint"):
        commands.append("ruff check ." if language == "python" else "eslint . --ext .ts,.tsx")
    if verification.get("type_check"):
        commands.append("mypy . || pyright" if language == "python" else "tsc --noEmit")
    if verification.get("unit_tests"):
        commands.append(
            "pytest tests/ -v -k 'not integration and not e2e'"
            if language == "python"
            else "bun vitest run tests/unit"
        )
    if verification.get("integration_tests"):
        commands.append(
            "pytest tests/ -v -k 'integration'"
            if language == "python"
            else "bun vitest run tests/integration"
        )
    if verification.get("e2e_tests"):
        commands.append(
            "pytest tests/ -v -k 'e2e'" if language == "python" else "bun vitest run tests/e2e"
        )
    if verification.get("server_startup"):
        commands.append(
            "pytest tests/ -v -k 'integration or server'"
            if language == "python"
            else "bun vitest run tests/integration"
        )

    server_check = ""
    if verification.get("server_startup"):
        framework = verification.get("server_framework", "server")
        server_check = (
            f"\n\nSERVER-STARTUP VERIFICATION (this project ships a {framework} server):\n"
            f"Beyond running the commands above, confirm the captured test output DEMONSTRATES these outcomes, and cite the evidence for each:\n"
            f"  (a) the real {framework} server actually started (background thread or subprocess) and served real HTTP requests with the expected responses — real framework / startup / CORS / handlers; heavy deps (model downloads, databases) may be mocked.\n"
            f"  (b) each entry-point script ran from its own directory (os.path.dirname(entry_point)) with its import chain intact — catches sys.path / PYTHONPATH bugs unit tests miss.\n"
            f"  (c) CORS preflight from a representative browser origin returned the correct headers (if the server uses CORS).\n"
            f"\nFAIL verification for any outcome NOT demonstrated by evidence, naming the unmet outcome. Passing unit tests alone do NOT satisfy a server project — that is a false positive."
        )
    enabled = [
        k for k in (
            "lint", "type_check", "unit_tests", "integration_tests",
            "e2e_tests", "server_startup",
        ) if verification.get(k)
    ]
    discovered = _discover_repo_commands(getattr(ctx, "project_root", "") or "")
    if discovered:
        disc = "; ".join(f"`{d['command']}` ({d['source']}: {d['name']})" for d in discovered)
        command_directive = (
            f"PREFER the verification commands THIS REPO declares (discovered from its own "
            f"Makefile / package.json scripts): {disc}. Run the ones that lint, type-check, "
            f"and test the code for the enabled tiers. Fall back to the language defaults only "
            f"for an enabled tier the repo declares no command for: "
            f"{'; '.join(commands) if commands else '(none)'}. "
        )
    else:
        command_directive = (
            f"Run these verification commands: "
            f"{'; '.join(commands) if commands else '(none configured — that itself is a failure for a server project)'}. "
        )
    return (
        f"Verify implementation. IDEAL STATE: {json.dumps(ideal)}. "
        f"Enabled verification tiers: {', '.join(enabled) if enabled else '(none)'}. "
        f"{command_directive}"
        f"For any tier not configured in the project, explicitly state it. "
        f"Paste the ACTUAL captured output of every command you ran (the tail of "
        f"pytest / ruff / tsc / the server-startup test) as evidence — a pass verdict "
        f"with no captured output is rejected. "
        f'Report SUMMARY: {{"passed": true|false, "failures": ["..."], '
        f'"evidence": ["<captured command / test output proving the verdict>"], '
        f'"confidence": "..."}}. '
        f"{server_check}"
        f"Session: {ctx.session_id}"
    )


def _build_learn(ctx: RunContext, code: dict, ideal: dict) -> str:
    return (
        f"Evaluate implementation against IDEAL STATE. IDEAL STATE: {json.dumps(ideal)}. "
        f"\nDetermine: "
        f"\n1. Are all success_criteria met? "
        f"\n2. Are all anti_criteria avoided? "
        f"\n3. Are all edge_cases handled? "
        f"\n4. Were all security review domains addressed? "
        f"\n5. Is there a gap between output and IDEAL STATE? "
        f'\n\nRespond with SUMMARY: {{"gap": true|false, "findings": ["..."]}}. '
        f"\nIf gap=true, the skill loops back to implement. "
        f"\nIf gap=false, the skill runs a final verification, then completes. "
        f"\nSession: {ctx.session_id}"
    )


_TASK_BUILDERS = {
    "exploring": _build_explore,
    "analyzing": _build_analyze,
    "checking_criteria": _build_criteria,
    "planning": _build_plan,
    "implementing": _build_implement,
    "verifying": _build_verify,
    "learning": _build_learn,
}


# ---------------------------------------------------------------------------
# Gate question builders (ported from handle_plan_approve / handle_criteria_fix)
# ---------------------------------------------------------------------------


def _plan_approval_question(ctx: RunContext, code: dict) -> dict:
    ideal = code.get("ideal_state", {})
    build_order = ideal.get("build_order", [])
    deliverables = ideal.get("deliverables", [])
    criteria = ideal.get("success_criteria", [])
    anti = ideal.get("anti_criteria", [])
    lines = [
        "## Plan Summary",
        "",
        "### Goal",
        f"{ideal.get('goal', ctx.goal)}",
        "",
        "### Dependency Order (hint — not a mandated sequence)",
    ]
    for step in build_order:
        lines.append(f"  - {step}")
    lines += ["", "### Key Deliverables"]
    for d in deliverables[:15]:
        lines.append(f"  - {d}")
    if len(deliverables) > 15:
        lines.append(f"  ... and {len(deliverables) - 15} more")
    lines += ["", "### Success Criteria"]
    for i, c in enumerate(criteria):
        lines.append(f"  - Criterion {i + 1}: {c}")
    lines += ["", "### Anti-Criteria (will NOT be built)"]
    for a in anti:
        lines.append(f"  - {a}")
    plan_summary = "\n".join(lines)
    return {
        "id": "plan_approval",
        "label": "Plan Review",
        "prompt": plan_summary + "\n\n---\n\n**Do you approve this plan?**\n\n"
        "- **Approve**: Start implementing immediately.\n"
        "- **Refine**: I'll tell you what to change first.\n"
        "- **Deny**: Discard this plan and stop.",
        "options": [
            {
                "value": "approve",
                "label": "Approve",
                "description": "Begin implementing the build order",
            },
            {
                "value": "refine",
                "label": "Refine",
                "description": "Modify the plan before implementation",
            },
            {"value": "deny", "label": "Deny", "description": "Discard this plan entirely"},
        ],
        "allowOther": True,
    }


def _criteria_fix_question(ctx: RunContext, code: dict) -> dict:
    ideal = code.get("ideal_state", {})
    criteria_list = ideal.get("success_criteria", [])
    issues = code.get("criteria_issues", {})
    findings = code.get("criteria_findings", [])
    issue_lines: list[str] = []
    for idx_str, issue_list in (issues or {}).items():
        try:
            idx = int(idx_str)
            criterion = criteria_list[idx - 1] if 0 <= idx - 1 < len(criteria_list) else "(unknown)"
        except (ValueError, IndexError, TypeError):
            continue
        issue_lines.append(f"### Criterion {idx}: {criterion}")
        for iss in issue_list:
            issue_lines.append(f"- {iss}")
        issue_lines.append("")
    if findings:
        issue_lines.append("### General Issues")
        for f in findings:
            issue_lines.append(f"- {f}")
    prompt_body = (
        "\n".join(issue_lines)
        if issue_lines
        else "No specific issues identified, but criteria need improvement."
    )
    summary = "\n".join(
        [
            "## Criteria Refinement Needed",
            "",
            "Carren identified issues with the IDEAL_STATE success criteria. ",
            "These need to be refined before planning and implementation can begin.",
            "",
            prompt_body,
        ]
    )
    return {
        "id": "criteria_refinement",
        "label": "Criteria Fix",
        "prompt": summary + "\n\n---\n\n**How would you like to proceed?**\n\n"
        "- **Refine criteria** (default): Tell me what to change in the criteria.\n"
        "- **Accept as-is**: Use the current criteria despite the issues.\n"
        "- **Skip**: Proceed without criteria validation.",
        "options": [
            {
                "value": "refine",
                "label": "Refine criteria",
                "description": "I'll specify how to improve the criteria",
            },
            {
                "value": "accept",
                "label": "Accept as-is",
                "description": "Use current criteria despite carren's concerns",
            },
            {
                "value": "skip",
                "label": "Skip validation",
                "description": "Proceed without criteria validation",
            },
        ],
        "allowOther": True,
    }


# ---------------------------------------------------------------------------
# The playbook
# ---------------------------------------------------------------------------


class CodePlaybook(BasePlaybook):
    NAME = "code"
    machine_cls = CodeMachine
    STEP_CAP = 60
    # Bound the final-verify <-> learning battery: a persistent learn(gap=false)/
    # verify(passed=false) disagreement must complete HONESTLY (met=False) after
    # this many final-verify attempts instead of spinning to the global STEP_CAP.
    FINAL_VERIFY_CAP = 3
    PRIMITIVE_BY_STATE = {
        "exploring": CODE_EXPLORE,
        "analyzing": CODE_ANALYZE,
        "checking_criteria": CODE_CRITERIA,
        "planning": CODE_PLAN,
        "implementing": CODE_IMPLEMENT,
        "verifying": CODE_VERIFY,
        "learning": CODE_LEARN,
    }
    GATE_STATES = frozenset({"criteria_gate", "plan_gate"})
    ESCALATABLE_STATES = frozenset(
        {
            "exploring",
            "analyzing",
            "checking_criteria",
            "planning",
            "implementing",
            "verifying",
            "learning",  # stall / repeated-strategy escalation (Recs 1 & 2)
        }
    )
    # Graduated autonomy: before writing/changing code (the action), ask
    # act-vs-ask (reversibility of the goal + earned coding-domain trust) and
    # escalate to the human when untrusted. Dormant unless PENNY_AUTONOMY_GATE.
    AUTONOMY_STATES = frozenset({"implementing"})

    # -- lifecycle ---------------------------------------------------------
    def initial_transition(self, ctx: RunContext) -> str:
        ideal = load_ideal_state(ctx.constraints, ctx.project_root)
        if not ideal or not ideal.get("success_criteria"):
            # PRD is OPTIONAL: with an IDEAL_STATE (room or inline) it drives the
            # run; without one, synthesize lightweight criteria from the goal and
            # proceed. carren still judges/refines them and the verify/test battery
            # is the real acceptance bar — the quality loop stays, the mandate goes.
            ideal = ideal_state_from_goal(getattr(ctx, "goal", ""))
        code = ctx.extras.setdefault("code", {})
        code["ideal_state"] = ideal
        code["language"] = ideal.get("language", "python")
        # Surface the criteria on the context so outcome capture records the real
        # expected outcome for a code run (not the generic "goal satisfied").
        ctx.success_criteria = list(ideal.get("success_criteria", []))
        code_detection.apply_server_detection(ctx)  # enriches ideal_state.verification
        self.sm.send("start_explore")
        return "exploring"

    # -- loop-quality gate: refuse a retry that repeats a failed strategy or
    #    that shows no measurable progress (Recs 1 & 2) ---------------------
    def progress_check(self, state: str, ctx: RunContext, summary: dict) -> str | None:
        if state != "learning":
            return None
        if summary.get("gap"):
            gaps = summary.get("findings", [])
            if ctx.iteration >= 1 and self.strategy_repeated(
                ctx, summary.get("strategy_change", "")
            ):
                return (
                    "the next implement iteration repeats the previous strategy with no change — "
                    "escalating rather than spinning (how should the approach differ?)"
                )
            if self.is_stalled(ctx, gaps):
                return (
                    "the same gaps have persisted across iterations with no measurable progress — "
                    "escalating rather than burning the remaining budget"
                )
            return None
        # gap=false but a prior FINAL verify FAILED: the learn/verify disagreement
        # must not spin (DEFECT 1). Stall detection is NOT gated behind gap here —
        # when the same verify failures keep recurring across final-verify
        # attempts, escalate the disagreement to the user rather than looping.
        code = ctx.extras.get("code", {})
        verify_failures = list(ctx.verify_gaps or [])
        if (
            code.get("verify_passed") is False
            and verify_failures
            and self.is_stalled(ctx, verify_failures)
        ):
            return (
                "final verification keeps failing on the same issues while learning reports "
                "no gap — escalating the learn/verify disagreement rather than spinning"
            )
        return None

    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:  # noqa: C901
        code = ctx.extras.setdefault("code", {})
        if state == "exploring":
            self.sm.send("explore_done")
        elif state == "analyzing":
            self.sm.send("analyze_done")
        elif state == "checking_criteria":
            if summary["gap"]:
                code["criteria_issues"] = summary.get("criteria_issues", {})
                code["criteria_findings"] = summary.get("findings", [])
                self.sm.send("criteria_gap")
            else:
                self.sm.send("criteria_ok")
        elif state == "planning":
            self.sm.send("plan_done")
        elif state == "implementing":
            self.sm.send("implement_done")
        elif state == "verifying":
            passed = summary["passed"]
            ctx.verify_verdict = "PASS" if passed else "FAIL"
            ctx.verify_gaps = summary.get("failures", [])
            code["verify_passed"] = passed
            if code.pop("final_verify", False):
                self.sm.send("final_verify_pass" if passed else "final_verify_fail")
            else:
                self.sm.send("verify_done")
        elif state == "learning":
            gap = summary["gap"]
            code["learn_gap"] = gap
            code["learn_findings"] = summary.get("findings", [])
            if not gap:
                # Final-verify battery. BOUND it (DEFECT 1): a persistent
                # learn(gap=false)/verify(passed=false) disagreement must NOT spin
                # to the global STEP_CAP. Count attempts and, on exhaustion,
                # complete HONESTLY (met=False via done_predicate, since
                # verify_passed is False) with the unresolved failures reported.
                attempts = code.get("final_verify_attempts", 0)
                if attempts >= self.FINAL_VERIFY_CAP:
                    code["final_verify"] = False
                    code["final_verify_exhausted"] = True
                    code["unresolved_failures"] = list(ctx.verify_gaps or [])
                    self.sm.send("learn_exhausted")
                else:
                    # Record the still-failing verify cycle so progress_check's
                    # is_stalled can escalate a no-progress spin on the next visit.
                    if code.get("verify_passed") is False:
                        self.record_iteration(
                            ctx,
                            gaps=list(ctx.verify_gaps or []),
                            confidence=summary.get("confidence", ""),
                        )
                    code["final_verify_attempts"] = attempts + 1
                    code["final_verify"] = True
                    self.sm.send("learn_final_verify")
            elif ctx.iteration + 1 < ctx.max_iterations:
                # Record the iteration digest so the next retry's progress_check
                # can enforce a strategy delta / detect a stall (Recs 1 & 2).
                self.record_iteration(
                    ctx,
                    strategy_change=summary.get("strategy_change", ""),
                    gaps=summary.get("findings", []),
                    confidence=summary.get("confidence", ""),
                )
                ctx.iteration += 1
                self.sm.send("learn_retry")
            else:
                self.sm.send("learn_exhausted")
        else:
            raise ValueError(f"route_after: unexpected state '{state}'")

    def done_predicate(self, ctx: RunContext) -> bool:
        code = ctx.extras.get("code", {})
        return code.get("learn_gap") is False and code.get("verify_passed", False)

    # -- planned-gate HITL -------------------------------------------------
    def gate_questions(self, state: str, ctx: RunContext) -> list[dict]:
        code = ctx.extras.setdefault("code", {})
        if state == "plan_gate":
            return [_plan_approval_question(ctx, code)]
        return [_criteria_fix_question(ctx, code)]

    def route_user(self, state: str, ctx: RunContext, response: Any) -> None:
        value = (
            response.get("user_response") or response.get("answer")
            if isinstance(response, dict)
            else str(response)
        ) or ""
        value = str(value).strip().lower()
        code = ctx.extras.setdefault("code", {})
        intent = self.classify_gate_intent(value)
        if state == "plan_gate":
            if intent == "approve":
                self.sm.send("plan_approved")
            elif intent == "deny":
                ctx.errors.append("plan denied by user")
                self.sm.send("plan_denied")
            else:
                ctx.clarification_text = value
                self.sm.send("plan_refine")
        else:  # criteria_gate
            if intent == "approve":
                code["criteria_validated"] = True
                self.sm.send("criteria_accepted")
            else:
                ctx.clarification_text = value
                self.sm.send("criteria_refined")

    # -- prompts + result --------------------------------------------------
    def _task_summary(self, state: str, spec: PrimitiveSpec, ctx: RunContext) -> str:
        code = ctx.extras.get("code", {})
        ideal = code.get("ideal_state", {})
        builder = _TASK_BUILDERS.get(state)
        base = (
            builder(ctx, code, ideal)
            if builder
            else f"{spec.task_hint}\nGoal: {self._cap(ctx.goal)}"
        )
        if ctx.clarification_text:
            base += f"\n\nUser clarification: {ctx.clarification_text}"
        return base

    def result_payload(self, ctx: RunContext) -> dict:
        code = ctx.extras.get("code", {})
        payload = {
            "met": ctx.met,
            "iterations": ctx.iteration,
            "verify_passed": code.get("verify_passed", False),
            "learn_gap": code.get("learn_gap"),
            "deliverables": code.get("ideal_state", {}).get("deliverables", []),
        }
        # Honest exhaustion (DEFECT 1): when the final-verify battery is spent
        # without a passing verify, surface the unresolved failures instead of a
        # silent met=False.
        if code.get("final_verify_exhausted"):
            payload["final_verify_exhausted"] = True
            payload["unresolved_failures"] = code.get("unresolved_failures", [])
        return payload
