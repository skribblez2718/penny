"""
jsa Skill - Production Orchestrator

Entry point for `skill({ skill_name: "jsa", goal: "..." })`.

Architecture:
  - JSAPhaseMachine: FSM from fsm.py tracks pipeline phases
  - JSAPipelineOrchestrator: Outputs JSON action directives to stdout
  - Penny: Routes directives → agents/tools
  - Agents: Read/write MemPalace for all data exchange
  - State: Persisted to session.json between phases

Protocol:
  start()  → first action dict
  step(agent, result) → next action dict after processing agent result
  extract_state() → dict for mempalace persistence
  restore_state(data) → resume from persisted state
"""

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

# Import the FSM (sys.path adjusted for skill directory structure)
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent / "scripts"))

from fsm import (  # noqa: E402
    JSAPhase, JSAState, cve_research_handler, _hostname_from_url,
    JSAPhaseMachine,
)


# ============================================================
# Regex Constants
# ============================================================

# Extract src URLs from <script> tags (any quote style, any type attribute)
SCRIPT_SRC_RE = re.compile(
    r'<script\b[^>]*?\bsrc\s*=\s*["\']([^"\']+)["\']',
    re.IGNORECASE,
)

# Extract content of <script> tags WITHOUT src attribute (inline scripts)
INLINE_SCRIPT_RE = re.compile(
    r'<script\b(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


# ============================================================
# Helper Functions
# ============================================================

def _is_js_file_url(jsluice_entry: dict) -> bool:
    """Return True if a jsluice JSONL entry points to a JavaScript file."""
    url = jsluice_entry.get("url", "")
    url_type = jsluice_entry.get("type", "")
    # Dynamic imports always load JS
    if url_type == "import":
        return True
    # Explicit .js extension (strip query strings first)
    base = url.split("?")[0].split("#")[0]
    if base.lower().endswith(".js"):
        return True
    return False


def _is_out_of_scope(url: str, patterns: list[str]) -> bool:
    """Return True if URL matches any out-of-scope pattern."""
    for pattern in patterns:
        if pattern in url:
            return True
    return False


def _coerce_scope_list(value: Any) -> list[str]:
    """Normalize a scope value into a clean list of URL-substring strings.

    The skill tool bridge can wrap list-shaped values in single-key dicts
    (e.g. {"item": "https://..."} instead of ["https://..."]) when the
    tool-call schema does not declare the list shape. This helper unwraps
    that pattern and extracts URL-like strings from any wrapper that has one.

    Accepted input shapes (all return a clean list of URL-substring strings):
      - ["https://x.com/admin", "https://x.com/vulns"]   # ideal: list of strings
      - "https://x.com/admin"                            # single string
      - "https://x.com/admin\nhttps://x.com/vulns"       # newline-separated
      - {"item": "https://x.com/admin"}                  # dict-wrapped (bridge artifact)
      - [{"item": "..."}, {"item": "..."}]               # list of dict-wraps
      - None / []                                        # empty

    Invalid types raise ValueError so the caller can surface the problem.
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [line.strip() for line in value.split("\n") if line.strip()]
    if isinstance(value, dict):
        # Single-key dict wrapper: take the first value
        if len(value) == 1:
            inner = next(iter(value.values()))
            return _coerce_scope_list(inner)
        # Multi-key dict: try common URL-bearing keys
        for candidate_key in ("item", "url", "pattern", "value", "scope"):
            if candidate_key in value:
                return _coerce_scope_list(value[candidate_key])
        # Fallback: stringify the values
        return [str(v).strip() for v in value.values() if str(v).strip()]
    if isinstance(value, (list, tuple, set)):
        out: list[str] = []
        for item in value:
            out.extend(_coerce_scope_list(item))
        return [s for s in (x.strip() for x in out) if s]
    raise ValueError(f"Cannot coerce scope value of type {type(value).__name__} to list[str]")


def _is_image_asset_url(url: str) -> bool:
    """Return True if URL points to a static image asset (noise for endpoint discovery).

    Strips query strings and fragments before checking the path. Matches common
    image extensions in any path segment.
    """
    base = url.split("?", 1)[0].split("#", 1)[0].lower()
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif"):
        if base.endswith(ext):
            return True
    return False


def _semgrep_path_discovery() -> str:
    """Discover the semgrep binary by walking up from the script location.

    Discovery order (first match wins):
      1. $SEMGREP_BIN env var (explicit override)
      2. <skill_dir>/../../../.venv/bin/semgrep  (canonical project venv)
         where skill_dir = .../penny/.pi/skills/jsa/scripts/
         so 5 parents up = .../penny/
      3. <project_root>/.venv/bin/semgrep
      4. `which semgrep` (PATH lookup)
      5. bare "semgrep" string (PATH fallback for subprocess)

    Returns a string suitable for use as the first element of a subprocess argv.
    """
    # 1. Explicit env override
    env_override = os.environ.get("SEMGREP_BIN")
    if env_override and Path(env_override).exists():
        return env_override

    # 2. Walk up from THIS file: orchestrate.py -> scripts/ -> jsa/ -> skills/ -> .pi/ -> penny/
    skill_root = Path(__file__).resolve().parent
    for ancestor in [skill_root, *skill_root.parents][:6]:
        candidate = ancestor / ".venv" / "bin" / "semgrep"
        if candidate.exists() and candidate.is_file():
            return str(candidate)

    # 4. PATH lookup via `which`
    for path_dir in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(path_dir) / "semgrep"
        if candidate.exists() and candidate.is_file():
            return str(candidate)

    # 5. Bare fallback (subprocess will raise if missing)
    return "semgrep"


def _rules_base_discovery() -> Path:
    """Discover the semgrep rules base directory.

    Walks up from orchestrate.py to find <project_root>/.pi/extensions/semgrep/rules/.
    Falls back to <project_root>/.pi/extensions/semgrep/rules/ for backward compat.
    """
    skill_root = Path(__file__).resolve().parent
    for ancestor in [skill_root, *skill_root.parents][:6]:
        candidate = ancestor / ".pi" / "extensions" / "semgrep" / "rules"
        if candidate.is_dir():
            return candidate
    # Last-resort fallback (matches previous behavior)
    return Path.cwd() / ".pi" / "extensions" / "semgrep" / "rules"


# ============================================================
# Output directory safety
# ============================================================

# Penny rule: NEVER write temporary files into the project tree. If a
# caller passes an output_dir that resolves to a path inside the project
# (current working directory or any ancestor containing AGENTS.md / .pi /
# .git), redirect to /tmp/jsa-{hostname}/ and emit a warning.
#
# This is a defense-in-depth check. The default output_dir is already
# /tmp/jsa-{hostname}; this guard catches the case where a caller
# mistakenly passes "." or an explicit project-root path.
_PROJECT_MARKERS = ("AGENTS.md", ".pi", ".git")


def _is_inside_project_tree(path: str) -> bool:
    """Walk up from path; return True if any ancestor contains a project marker."""
    cursor = os.path.abspath(path)
    while True:
        for marker in _PROJECT_MARKERS:
            if os.path.exists(os.path.join(cursor, marker)):
                return True
        parent = os.path.dirname(cursor)
        if parent == cursor:  # reached filesystem root
            return False
        cursor = parent


def _safe_output_dir(requested: str, target_url: Optional[str]) -> str:
    """Return a safe output_dir, redirecting to /tmp if requested is inside the project tree."""
    resolved = os.path.abspath(requested)
    if not _is_inside_project_tree(resolved):
        return resolved
    hostname = _hostname_from_url(target_url) if target_url else "unknown"
    fallback = f"/tmp/jsa-{hostname}"
    print(
        f"[jsa] output_dir {resolved!r} is inside the project tree. "
        f"Redirecting to {fallback!r} per Penny's 'no temp files in project' rule.",
        file=sys.stderr,
    )
    return fallback


# ============================================================
# Directive Types
# ============================================================

@dataclass
class Directive:
    """Instruction for Penny to execute."""
    type: str                    # agent | tool | local | complete | escalate
    phase: str                   # Current phase name
    session_id: str              # Pipeline session ID
    description: str             # Human-readable description
    agent: Optional[str] = None  # Agent name (for agent directives)
    task: Optional[str] = None   # Agent task description
    tool: Optional[str] = None   # Tool name (for tool directives)
    tool_params: Optional[Dict] = None  # Tool parameters
    output_room: Optional[str] = None   # MemPalace room for results
    output_wing: str = "wing_jsa"       # MemPalace wing (SKILL.md: dedicated wing_jsa rooms)
    context: Optional[Dict] = None      # Additional context
    next_phase: Optional[str] = None    # Phase to advance to after completion
    skillContext: Optional[str] = None  # Path to skill context file for subagent
    model: Optional[str] = None         # Override agent's default model for this call


# ============================================================
# Orchestrator
# ============================================================

class JSAPipelineOrchestrator:
    """
    Production orchestrator for the jsa skill.

    Implements the Penny skill protocol:
      start() -> first action
      step(agent, result) -> next action after processing agent result
      extract_state() -> dict for mempalace persistence
      restore_state(data) -> resume from persisted state
    """

    def __init__(
        self,
        session_id: str,
        goal: str,
        project_root: str = ".",
        constraints: Optional[Dict[str, Any]] = None,
    ):
        self.session_id = session_id
        self.goal = goal
        self.project_root = str(Path(project_root).resolve())
        self.constraints = constraints or {}

        # Extract target URL from goal. We look for the first http(s)://
        # token and strip trailing punctuation (periods, commas, semicolons,
        # closing brackets/parens) that often appears when URLs are
        # embedded at the end of a sentence. We do NOT strip from the
        # middle — query strings legitimately use `?` `&` `=`.
        self.target_url = ""
        for word in goal.split():
            if word.startswith("http://") or word.startswith("https://"):
                # Strip trailing sentence punctuation
                cleaned = word.rstrip(".,;:!?)")
                # Also strip a trailing period that may be part of the FQDN
                # (e.g. "https://example.com." at end of a sentence) — but
                # only if it's followed by no path/query chars
                if cleaned.endswith(".") and not cleaned.endswith("/."):
                    # Check: is the period a sentence terminator? If the URL
                    # has a path, query, or fragment after the final `.`,
                    # leave it. Otherwise strip.
                    from urllib.parse import urlparse
                    parsed = urlparse(cleaned)
                    if not parsed.path and not parsed.query and not parsed.fragment:
                        cleaned = cleaned[:-1]
                self.target_url = cleaned
                break

        # Analyzers from constraints or default to all
        self.analyzers = self.constraints.get("analyzers", [])
        if not self.analyzers:
            from fsm import _get_all_analyzers
            self.analyzers = _get_all_analyzers()

        # Output directory
        self.output_dir = self.constraints.get("output_dir", "")
        if not self.output_dir:
            hostname = _hostname_from_url(self.target_url) if self.target_url else "unknown"
            self.output_dir = f"/tmp/jsa-{hostname}"
        else:
            # Defense in depth: never write temp files into the project tree.
            # If the caller passes a path inside the project, redirect to /tmp.
            self.output_dir = _safe_output_dir(self.output_dir, self.target_url)

        # Initialize state
        self.state = JSAState(
            session_id=self.session_id,
            target_url=self.target_url,
            output_dir=self.output_dir,
            analyzers=self.analyzers,
        )
        self.state.ensure_dirs()

        # Initialize FSM
        self.fsm = JSAPhaseMachine(start_phase=JSAPhase.INTAKE)
        self.state.metadata["phase_history"] = ["INTAKE"]

        # If constraints contain pre-collected intake questionnaire data,
        # process it immediately so start() can skip the INTAKE escalation.
        # The questionnaire tool is invoked by Penny BEFORE the skill, and
        # results are passed via constraints.intake.
        intake_data = self.constraints.get("intake", {})
        if intake_data:
            self._process_intake_questionnaire(intake_data)

        # Load state from previous invocation if resuming
        self._load_state()

    def _load_state(self) -> None:
        """Try to load existing state from session.json for resume."""
        session_path = Path(self.output_dir) / "session.json"
        if session_path.exists():
            try:
                data = json.loads(session_path.read_text())
                phase_history = data.get("metadata", {}).get("phase_history", [])
                if phase_history and phase_history[-1] == "COMPLETED":
                    return  # Don't resume completed pipelines
                # Restore key fields for in-progress pipelines
                for key in ["analyzers", "sast_findings", "sast_validated",
                           "raw_findings", "merged_findings", "verified_findings",
                           "metadata", "phase_outputs",
                           "module_cards", "page_cards", "flow_cards"]:
                    if key in data:
                        setattr(self.state, key, data[key])
            except Exception:
                pass

    def _save_state(self) -> None:
        """Persist state to session.json."""
        from datetime import datetime, timezone

        self.state.updated_at = datetime.now(timezone.utc).isoformat()
        # Sync FSM phase into state so restore_state() can find it
        self.state.current_phase = self.fsm.phase.name
        session_path = Path(self.output_dir) / "session.json"
        session_path.parent.mkdir(parents=True, exist_ok=True)
        session_path.write_text(json.dumps(self.state.to_dict(), indent=2, default=str))

    # ── State serialization ─────────────────────────────────

    def extract_state(self) -> Dict[str, Any]:
        """Extract minimal state for CLI argument transport.

        Returns only what's needed to locate the persisted session on disk.
        Full state (including all findings, cards, metadata) is saved in
        session.json via _save_state() and loaded by restore_state().
        This avoids E2BIG when Linux MAX_ARG_STRLEN (128KB) is exceeded.

        The context dict is preserved with summary fields for Penny's
        display layer (progress messages, user-facing stats). Pipeline
        logic always reads from the on-disk session.json.
        """
        effective_oos = self.constraints.get("out_of_scope", [])
        return {
            "session_id": self.state.session_id,
            "current_phase": self.fsm.phase.name,
            "context": {
                "goal": self.goal,
                "target_url": self.target_url,
                "output_dir": self.output_dir,
                "analyzers": self.analyzers,
                "constraints": self.constraints,
                "effective_out_of_scope": list(effective_oos) if effective_oos else [],
                "phase_history": self.state.metadata.get("phase_history", []),
                "module_card_count": len(self.state.module_cards),
                "page_card_count": len(self.state.page_cards),
                "flow_card_count": len(self.state.flow_cards),
                "sast_findings_count": len(self.state.sast_findings),
                "raw_findings_count": len(self.state.raw_findings),
                "errors": self.state.errors,
            },
        }

    def restore_state(self, data: Dict[str, Any]) -> None:
        """Restore state from the on-disk session.json.

        The data dict contains output_dir which points to the session.json
        written by _save_state(). This ensures the full state (metadata,
        findings, cards, verification results) is available to pipeline
        phases regardless of MAX_ARG_STRLEN limits.

        Falls back to CLI-passed context only if session.json is missing
        (defensive — should not happen in normal operation).
        """
        context = data.get("context", {})
        self.goal = context.get("goal", self.goal)
        self.target_url = context.get("target_url", self.target_url)
        self.analyzers = context.get("analyzers", self.analyzers)
        self.constraints = context.get("constraints", self.constraints)

        # Primary: load full state from on-disk session.json
        output_dir = context.get("output_dir", "")
        if output_dir:
            session_path = Path(output_dir) / "session.json"
            if session_path.exists():
                try:
                    disk_data = json.loads(session_path.read_text())
                    self.state.output_dir = output_dir
                    self.state.target_url = disk_data.get("target_url", self.target_url)
                    self.state.analyzers = disk_data.get("analyzers", self.analyzers)
                    for key in ["module_cards", "page_cards", "flow_cards",
                                "raw_findings", "merged_findings", "verified_findings",
                                "sast_findings", "sast_validated",
                                "metadata", "errors"]:
                        if key in disk_data:
                            setattr(self.state, key, disk_data[key])
                    # Restore FSM phase from persisted state
                    saved_phase = disk_data.get("current_phase", "INTAKE")
                    try:
                        phase = JSAPhase[saved_phase]
                        self.fsm = JSAPhaseMachine(start_phase=phase)
                    except (KeyError, ValueError):
                        pass
                    return  # Successful restore from disk
                except Exception:
                    pass  # Fall through to CLI-passed context fallback

        # Fallback: restore from CLI-passed context (prevents crashes)
        self.output_dir = context.get("output_dir", self.output_dir)
        self.state.output_dir = self.output_dir
        self.state.target_url = context.get("target_url", self.target_url)
        self.state.analyzers = self.analyzers

        for key in ["chunks", "sast_findings", "sast_validated",
                   "raw_findings", "merged_findings", "verified_findings",
                   "metadata", "phase_outputs"]:
            if key in context:
                setattr(self.state, key, context[key])

        if "errors" in context:
            self.state.errors = context["errors"]

        # Restore FSM phase
        saved_phase = data.get("current_phase", "INTAKE")
        try:
            phase = JSAPhase[saved_phase]
            self.fsm = JSAPhaseMachine(start_phase=phase)
        except (KeyError, ValueError):
            pass

    # ── Protocol entry points ─────────────────────────────

    def start(self) -> Dict[str, Any]:
        """Start the pipeline.

        Always starts from INTAKE. Merges any target configuration the
        user provided via goal text (auto-extracted into self.target_url
        by __init__) or top-level constraints (out_of_scope, auth mode,
        session management, etc.) into the intake record. If all required
        fields are present after the merge, INTAKE auto-advances to
        ACQUIRE in the same call. If anything is still missing, INTAKE
        returns an `escalate_to_user` action with a `questions` array —
        the skill tool routes it to Penny, who invokes the questionnaire
        tool and feeds the user's answers back via `step --agent user`.
        """
        # Defensive normalization: the skill tool bridge has been observed to
        # wrap list-shaped values in {"item": "..."} single-key dicts when the
        # tool-call schema does not declare the list shape. This breaks the
        # out_of_scope substring matcher because iterating a dict yields keys
        # (e.g. ["item"]), not values. Normalize here so scope enforcement and
        # all downstream readers see a clean list of URL strings.
        self._normalize_constraints()
        # Merge any top-level constraint fields into the intake record so
        # users can pass credentials, session_management, etc. directly via
        # constraints (top-level) instead of nesting them under `intake`.
        # We never overwrite a value the user already set via constraints.intake.
        intake = self.state.metadata.setdefault("intake", {})
        if self.target_url and not intake.get("target_url"):
            intake["target_url"] = self.target_url
        for key in ("out_of_scope", "authenticated_testing", "auth_instructions",
                    "roles", "session_management", "session_details"):
            if not intake.get(key) and self.constraints.get(key):
                intake[key] = self.constraints[key]
        # Re-normalize the intake copy too, in case it inherited a dict-wrapped value
        if "out_of_scope" in intake:
            intake["out_of_scope"] = _coerce_scope_list(intake["out_of_scope"])
        # Re-resolve target_url from the (now populated) intake if it was
        # originally missing or auto-derived.
        target = (intake.get("target_url") or "").strip()
        if target and not self.target_url:
            self.target_url = target
            self.state.target_url = target

        # Defensive self-check: print effective scope to stderr so operators
        # can confirm scope was parsed correctly before any crawling happens.
        # The runtime scope is the normalized list stored at
        # self.constraints["out_of_scope"]. This bypasses any display-layer
        # quirks in the response renderer.
        effective_scope = self.constraints.get("out_of_scope", [])
        if effective_scope:
            scope_lines = "\n".join(f"  - {p}" for p in effective_scope)
            print(
                f"[jsa] Effective out_of_scope ({len(effective_scope)} pattern{'s' if len(effective_scope) != 1 else ''}):\n{scope_lines}",
                file=sys.stderr,
            )
        else:
            print("[jsa] Effective out_of_scope: (none — all reachable URLs are in scope)", file=sys.stderr)

        action = self._build_action(JSAPhase.INTAKE)
        self._save_state()
        return action

    def step(self, agent: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process agent result summary and return next action with state.

        Args:
            agent: Name of the agent that completed
            result: JSON result summary from the agent
        """
        current_phase = self.fsm.phase

        # Mark current phase as completed
        self.state.metadata["phase_history"].append(current_phase.name)

        # ── INTAKE phase: process questionnaire results, then advance to ACQUIRE ──
        if current_phase == JSAPhase.INTAKE and agent == "user":
            self._process_intake_questionnaire(result)
            self.fsm.advance(JSAPhase.ACQUIRE)
            action = self._build_action(JSAPhase.ACQUIRE)
            self._save_state()
            return action

        # ── STOP phase: process user decision (continue / stop) ──
        if current_phase == JSAPhase.STOP and agent == "user":
            decision = result.get("stop_decision", "continue")
            if decision == "stop":
                # User chose to stop - end the pipeline
                self.state.metadata["phase_history"].append("COMPLETED")
                self._save_state()
                return self._complete_action()
            # decision == "continue" - fall through to advance to next phase

        # ── INVESTIGATE wave loop: check if more waves remain ──
        if current_phase == JSAPhase.INVESTIGATE and agent == "annie":
            wave_current = self.state.metadata.get("investigate_wave", 0)
            wave_total = self.state.metadata.get("investigate_total_waves", 0)
            if wave_current < wave_total:
                # More waves - loop back to INVESTIGATE
                action = self._build_action(JSAPhase.INVESTIGATE)
                self._save_state()
                return action

        next_phase = self._next_phase(current_phase)
        if next_phase is None or next_phase == JSAPhase.COMPLETED:
            self.state.metadata["phase_history"].append("COMPLETED")
            self._save_state()
            return self._complete_action()

        # Advance FSM to next phase
        self.fsm.advance(next_phase)
        action = self._build_action(next_phase)
        self._save_state()
        return action

    def _normalize_constraints(self) -> None:
        """Normalize scope and known multi-value constraint fields in-place.

        Defends against the skill tool bridge wrapping list-shaped values in
        single-key dicts (e.g. {"item": "..."}) when the schema doesn't declare
        the list shape. See _coerce_scope_list for the accepted input shapes.
        """
        for key in ("out_of_scope", "roles"):
            if key in self.constraints:
                try:
                    self.constraints[key] = _coerce_scope_list(self.constraints[key])
                except ValueError:
                    # Leave as-is; downstream code that handles this field will
                    # surface a clearer error.
                    pass
        # Also normalize inside constraints.intake if present
        if isinstance(self.constraints.get("intake"), dict):
            for key in ("out_of_scope", "roles"):
                if key in self.constraints["intake"]:
                    try:
                        self.constraints["intake"][key] = _coerce_scope_list(
                            self.constraints["intake"][key]
                        )
                    except ValueError:
                        pass

    def _process_intake_questionnaire(self, result: Dict[str, Any]) -> None:
        """Process structured questionnaire results from the INTAKE questionnaire.

        Extracts: target_url, out_of_scope, authenticated_testing,
        auth_instructions, roles, session_management, session_details.

        Stores everything in self.state.metadata["intake"] for downstream
        phases to reference.
        """
        # Interview tool returns {question_id: answer} or
        # {responses: {question_id: answer}} depending on mode.
        # Normalize to a flat dict.
        responses = result.get("responses", result)

        intake = {}

        # Target URL
        target = (responses.get("target_url") or "").strip()
        if target:
            self.target_url = target
            self.state.target_url = target
            # Only set the default output_dir if the user didn't explicitly
            # configure one. Otherwise preserve the user's choice.
            user_explicit_output_dir = bool(self.constraints.get("output_dir", "").strip())
            if not user_explicit_output_dir:
                try:
                    from urllib.parse import urlparse
                    hostname = urlparse(target).netloc.split(":")[0].replace(".", "-") or "unknown"
                    self.output_dir = f"/tmp/jsa-{hostname}"
                    self.state.output_dir = self.output_dir
                    self.state.ensure_dirs()
                except Exception:
                    pass
        intake["target_url"] = target

        # Out of scope — handle both string (legacy) and list (questionnaire tool)
        out_of_scope_raw = responses.get("out_of_scope") or ""
        if isinstance(out_of_scope_raw, list):
            out_of_scope = [u.strip() for u in out_of_scope_raw if u.strip()]
        else:
            out_of_scope = [line.strip() for line in str(out_of_scope_raw).split("\n") if line.strip()]
        if out_of_scope:
            self.constraints["out_of_scope"] = out_of_scope
        intake["out_of_scope"] = out_of_scope

        # Authenticated testing
        auth_mode = responses.get("authenticated_testing") or ""
        if isinstance(auth_mode, list):
            auth_mode = auth_mode[0] if auth_mode else ""
        auth_mode = str(auth_mode).strip()
        intake["authenticated_testing"] = auth_mode
        if auth_mode:
            self.constraints["authenticated_testing"] = auth_mode

        # Auth instructions — handle both string and list
        auth_instructions = responses.get("auth_instructions") or ""
        if isinstance(auth_instructions, list):
            auth_instructions = "\n".join(auth_instructions)
        auth_instructions = str(auth_instructions).strip()
        if auth_instructions:
            self.constraints["auth_instructions"] = auth_instructions
        intake["auth_instructions"] = auth_instructions

        # Roles — handle both string (legacy) and list (questionnaire tool)
        roles_raw = responses.get("roles") or ""
        if isinstance(roles_raw, list):
            roles = [r.strip() for r in roles_raw if r.strip()]
        else:
            roles = [r.strip() for r in str(roles_raw).split("\n") if r.strip()]
        intake["roles"] = roles
        if roles:
            self.constraints["roles"] = roles

        # Session management
        session_mgmt = responses.get("session_management") or ""
        if isinstance(session_mgmt, list):
            session_mgmt = session_mgmt[0] if session_mgmt else ""
        session_mgmt = str(session_mgmt).strip()
        intake["session_management"] = session_mgmt
        if session_mgmt:
            self.constraints["session_management"] = session_mgmt

        # Session details — handle both string and list
        session_details = responses.get("session_details") or ""
        if isinstance(session_details, list):
            session_details = "\n".join(session_details)
        session_details = str(session_details).strip()
        if session_details:
            self.constraints["session_details"] = session_details
        intake["session_details"] = session_details

        # Store complete intake for downstream reference
        self.state.metadata["intake"] = intake
        self._save_state()

    def _next_phase(self, current: JSAPhase) -> Optional[JSAPhase]:
        """Get the next sequential phase using the FSM's actual transitions.

        The FSM has explicit transitions defined via the event map
        (FSM._event_map). We follow those transitions to ensure
        we never try to advance to a phase that isn't connected
        in the FSM graph.
        """
        # Build the explicit transition map matching the FSM
        transitions = {
            JSAPhase.INTAKE: JSAPhase.ACQUIRE,
            JSAPhase.ACQUIRE: JSAPhase.CVE_RESEARCH,
            JSAPhase.CVE_RESEARCH: JSAPhase.SAST_SCAN,
            JSAPhase.SAST_SCAN: JSAPhase.NORMALIZE,
            JSAPhase.NORMALIZE: JSAPhase.DEDUP_WITHIN_SOURCE,
            JSAPhase.DEDUP_WITHIN_SOURCE: JSAPhase.CORRELATE_EVIDENCE,
            JSAPhase.CORRELATE_EVIDENCE: JSAPhase.AGENT_REVIEW,
            JSAPhase.AGENT_REVIEW: JSAPhase.SAST_VALIDATE,
            JSAPhase.SAST_VALIDATE: JSAPhase.STRUCTURE,
            JSAPhase.STRUCTURE: JSAPhase.SLICE,
            JSAPhase.SLICE: JSAPhase.INVESTIGATE,
            JSAPhase.INVESTIGATE: JSAPhase.STOP,
            JSAPhase.STOP: JSAPhase.COLLECT,
            JSAPhase.COLLECT: JSAPhase.MERGE,
            JSAPhase.MERGE: JSAPhase.VERIFY,
            JSAPhase.VERIFY: JSAPhase.REPORT,
            JSAPhase.REPORT: JSAPhase.REFLECT,
            JSAPhase.REFLECT: JSAPhase.COMPLETED,
        }
        return transitions.get(current)

    # ── Action builders ───────────────────────────────────

    def _build_action(self, phase: JSAPhase) -> Dict[str, Any]:
        """Build action dict for a given phase, transparently skipping empty/local phases."""
        current = phase
        while current != JSAPhase.COMPLETED:
            directive = self._get_directive_for_phase(current)
            if directive is not None:
                action = self._directive_to_dict(directive)
                if action is not None:
                    return action
                # Tool/local directive executed locally - mark phase complete, advance
                self.state.metadata["phase_history"].append(current.name)
                self._save_state()
                next_p = self._next_phase(current)
                if next_p is None:
                    break
                self.fsm.advance(next_p)
                current = next_p
                continue

            # Phase has no work - skip it
            self.state.metadata["phase_history"].append(current.name)
            next_p = self._next_phase(current)
            if next_p is None:
                break
            self.fsm.advance(next_p)
            current = next_p

        # All phases complete
        self.state.metadata["phase_history"].append("COMPLETED")
        self._save_state()
        return self._complete_action()

    def _directive_to_dict(self, directive: Directive) -> Optional[Dict[str, Any]]:
        """Convert a Directive to an action dict for the skill extension protocol.

        Returns None for tool/local directives (executed locally, phase auto-advances).
        The skill extension only handles: invoke_agent, invoke_agents_parallel,
        escalate_to_user, complete, error.
        """
        # ── Tool directives: run locally, auto-advance ──
        if directive.type == "tool":
            self._execute_tool_phase(directive)
            return None

        # ── Local directives: run locally, auto-advance ──
        if directive.type == "local":
            self._execute_local_phase(directive)
            return None

        # ── Agent directives: convert to skill extension protocol ──
        if directive.type == "agent":
            # DISPATCH: expand into parallel tasks
            if directive.phase == "DISPATCH":
                return self._build_dispatch_action(directive)
            
            # Inject wing instruction into task_summary
            task_text = (directive.task or "")
            wing_note = f"\n\nIMPORTANT: Write ALL mempalace entries to wing=wing_jsa, room={directive.output_room}."
            
            # Single agent
            action: Dict[str, Any] = {
                "action": "invoke_agent",
                "state_id": directive.phase,
                "session_id": directive.session_id,
                "description": directive.description,
                "agent": directive.agent,
                "task_summary": task_text + wing_note,
                "orchestrator_state": self.extract_state(),
            }
            if directive.skillContext:
                action["skillContext"] = directive.skillContext
            if directive.model:
                action["model"] = directive.model
            return action

        # ── Escalate directives: present questionnaire to user ──
        if directive.type == "escalate":
            # INTAKE missing required fields uses this path. The skill
            # extension routes the action to Penny, who invokes the
            # questionnaire tool and feeds the answers back via
            # `step --agent user`. The `previous_state` and
            # `unknown_reason` fields let the skill tool resume the FSM
            # correctly and surface a meaningful reason in the UI.
            context = directive.context or {}
            return {
                "action": "escalate_to_user",
                "state_id": directive.phase,
                "session_id": directive.session_id,
                "description": directive.description,
                "orchestrator_state": self.extract_state(),
                "questions": context.get("questions", []),
                "previous_state": context.get("previous_state", directive.phase),
                "unknown_reason": context.get("reason", directive.description),
            }

        # Complete
        if directive.type == "complete":
            result = self._complete_action()
            # Carry directive context into the completion message so Penny sees instructions
            if directive.context:
                result["description"] = directive.description
                result["message"] = directive.context.get("message", directive.description)
                result["questionnaire_path"] = directive.context.get("questionnaire_path", "")
            return result

        return None

    def _create_base_action(self, phase_name: str) -> Dict[str, Any]:
        """Create a bare action dict with common fields."""
        return {
            "state_id": phase_name,
            "session_id": self.session_id,
            "orchestrator_state": self.extract_state(),
        }

    def _execute_tool_phase(self, directive: Directive) -> None:
        """Execute a tool directive locally (SAST scan, etc.)."""
        import subprocess

        phase = directive.phase
        if phase == "SAST_SCAN":
            js_dir = str(self.state.js_dir)
            self.state.metadata.setdefault("sast", {})

            # Run semgrep if JS files exist
            if Path(js_dir).exists() and list(Path(js_dir).glob("*.js")):
                # Find semgrep via multi-tier discovery (env, project venv, PATH, bare)
                semgrep_bin = _semgrep_path_discovery()
                # Locate bundled semgrep rules (walks up from script location)
                RULES_BASE = str(_rules_base_discovery())
                # Build the semgrep command. We must keep the argv small (< ~4KB) to
                # avoid E2BIG spawn errors when the orchestrator process itself is
                # launched by a parent with a constrained argv (e.g. some Node.js
                # child_process.spawn wrappers, sandboxed runners).
                #
                # Strategy:
                #   - Pass the entire bundled local rules tree as a SINGLE --config
                #     argument (semgrep recursively loads all *.yaml from a dir).
                #   - Add a curated set of registry rulesets that complement the
                #     local rules without duplicating them. Each is a single arg.
                #
                # Registry rules were selected by:
                #   1. Researching semgrep/semgrep-rules + returntocorp/semgrep-rules
                #      repos (publicly available; CE-compatible)
                #   2. Filtering out rules already covered by the local rule set
                #      (e.g. p/javascript overlaps with javascript-lang)
                #   3. Removing broken/missing rulesets (p/xxe returns 404 from
                #      the public registry; XXE is covered by p/owasp-top-ten and
                #      p/security-audit instead)
                #
                # Source taxonomy:
                #   <RULES_BASE>  - 369 local rules (javascript-*, typescript-*, html/*,
                #                   generic-secrets, generic-html-templates)
                #   p/javascript  - core JS language rules (CE)
                #   p/typescript  - core TS language rules (CE)
                #   p/nodejs      - Node.js backend patterns (CE)
                #   p/expressjs   - Express.js framework patterns (CE)
                #   p/eslint      - ESLint core rules ported to semgrep (CE)
                #   p/xss         - cross-site scripting variants (CE)
                #   p/owasp-top-ten - OWASP Top 10 mapping (CE)
                #   p/cwe-top-25  - CWE Top 25 most dangerous (CE)
                #   p/secrets     - generic secret patterns (CE)
                #   p/security-audit - broad security audit (CE)
                #   p/sql-injection - SQLi patterns (CE)
                #   p/command-injection - command injection (CE)
                #   p/jwt         - JWT handling issues (CE)
                #   p/insecure-transport - plaintext HTTP, mixed content (CE)
                cmd = [semgrep_bin, "scan", "--json", "--metrics=off"]
                # Local rules: a single --config pointing to the rules tree
                cmd.extend(["--config", RULES_BASE])
                # Registry rules: one --config per CE-compatible ruleset
                JSA_REGISTRY = [
                    "p/javascript", "p/typescript", "p/nodejs", "p/expressjs", "p/eslint",
                    "p/xss", "p/owasp-top-ten", "p/cwe-top-25",
                    "p/secrets", "p/security-audit", "p/sql-injection",
                    "p/command-injection", "p/jwt", "p/insecure-transport",
                ]
                for r in JSA_REGISTRY:
                    cmd.extend(["--config", r])
                # Target both JS and HTML files so semgrep's HTML rules
                # (html/security/audit/*, generic-html-templates/*) are applied
                cmd.append(js_dir)
                html_dir = str(self.state.html_dir)
                if Path(html_dir).exists() and list(Path(html_dir).glob("*.html")):
                    cmd.append(html_dir)

                try:
                    result = subprocess.run(
                        cmd,
                        capture_output=True, text=True, timeout=600,
                        cwd=self.project_root,
                    )
                    if result.returncode == 0:
                        findings = json.loads(result.stdout).get("results", [])
                    else:
                        # rc 1 = findings present (semgrep convention), keep them
                        if result.stdout.strip():
                            try:
                                findings = json.loads(result.stdout).get("results", [])
                            except json.JSONDecodeError:
                                findings = []
                        else:
                            self.state.errors.append(
                                f"semgrep failed (rc={result.returncode}): "
                                f"{result.stderr[:200]}"
                            )
                            findings = []
                except FileNotFoundError as e:
                    self.state.errors.append(
                        f"semgrep binary not found at '{semgrep_bin}'. "
                        f"Install semgrep (e.g., `pip install semgrep` or "
                        f"set $SEMGREP_BIN env var to its absolute path). "
                        f"Underlying error: {e}"
                    )
                    findings = []
                except Exception as e:
                    self.state.errors.append(f"semgrep failed: {e}")
                    findings = []
            else:
                findings = []

            sast_findings = []
            for f in findings:
                sast_findings.append({
                    "rule_id": f.get("check_id", ""),
                    "severity": f.get("extra", {}).get("severity", "INFO"),
                    "path": f.get("path", ""),
                    "line": f.get("start", {}).get("line", 0),
                    "message": f.get("extra", {}).get("message", ""),
                    "code": f.get("extra", {}).get("lines", ""),
                    "source": "semgrep",
                })
            self.state.sast_findings = sast_findings
            self.state.metadata["sast"]["semgrep_count"] = len(sast_findings)

            # Run jsluice secrets on each JS file
            jsluice_bin = Path.home() / "go" / "bin" / "jsluice"
            jsluice_findings = []
            if jsluice_bin.exists():
                for js_file in Path(js_dir).glob("*.js"):
                    try:
                        result = subprocess.run(
                            [str(jsluice_bin), "secrets", str(js_file)],
                            capture_output=True, text=True, timeout=30,
                        )
                        for line in result.stdout.strip().split("\n"):
                            if line.strip():
                                try:
                                    jsluice_findings.append(json.loads(line))
                                except json.JSONDecodeError:
                                    pass
                    except Exception:
                        pass
            self.state.metadata["sast"]["jsluice_secrets_count"] = len(jsluice_findings)
            
            # Run jsluice urls on each JS file for endpoint discovery.
            # Filter out static image asset URLs (noise — not security-relevant
            # endpoints) so downstream agents only see actual API/UI routes.
            jsluice_url_findings: list[dict] = []
            jsluice_url_filtered = 0
            if jsluice_bin.exists():
                for js_file in Path(js_dir).glob("*.js"):
                    try:
                        result = subprocess.run(
                            [str(jsluice_bin), "urls", str(js_file)],
                            capture_output=True, text=True, timeout=30,
                        )
                        for line in result.stdout.strip().split("\n"):
                            if not line.strip():
                                continue
                            try:
                                entry = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            url = entry.get("url", "")
                            if url and _is_image_asset_url(url):
                                jsluice_url_filtered += 1
                                continue
                            jsluice_url_findings.append(entry)
                    except Exception:
                        pass
            self.state.metadata["sast"]["jsluice_urls_count"] = len(jsluice_url_findings)
            self.state.metadata["sast"]["jsluice_urls_filtered"] = jsluice_url_filtered
            self._save_state()

            # ── Persist SAST artifacts to disk + mempalace ──
            # Downstream phases (NORMALIZE, CORRELATE_EVIDENCE, DISPATCH)
            # need to be able to read findings from disk and from mempalace.
            # Before this fix, findings only lived in self.state.sast_findings
            # (lost on session restart) and the user-facing /sast/ directory
            # was always empty. Now we write:
            #   - semgrep.json             raw semgrep JSON
            #   - jsluice_secrets.jsonl   raw jsluice secrets JSONL
            #   - jsluice_urls.jsonl       raw jsluice URLs JSONL
            #   - findings.json            consolidated, deduped, classified
            #   - findings.md              human-readable summary
            #   - findings_by_file.json    findings grouped by file
            # And we post a single summary drawer to mempalace room
            # `{session_id}-sast-findings` with a path to the JSON.
            self._persist_sast_artifacts(
                raw_semgrep=findings,
                jsluice_secrets=jsluice_findings,
                jsluice_urls=jsluice_url_findings,
            )

    def _persist_sast_artifacts(
        self,
        raw_semgrep: list[dict],
        jsluice_secrets: list[dict],
        jsluice_urls: list[dict],
    ) -> None:
        """Write SAST findings to disk and post a summary drawer to mempalace.

        Inputs are the raw scanner outputs (NOT self.state.sast_findings,
        which is the normalized list — we re-derive it here so this function
        is self-contained and idempotent).
        """
        import datetime as _dt
        sast_dir = Path(self.output_dir) / "sast"
        sast_dir.mkdir(parents=True, exist_ok=True)

        # ── 1. Raw scanner outputs ──
        (sast_dir / "semgrep.json").write_text(
            json.dumps({"results": raw_semgrep, "errors": []}, indent=2)
        )
        (sast_dir / "jsluice_secrets.jsonl").write_text(
            "\n".join(json.dumps(s) for s in jsluice_secrets)
            + ("\n" if jsluice_secrets else "[]\n")
        )
        (sast_dir / "jsluice_urls.jsonl").write_text(
            "\n".join(json.dumps(u) for u in jsluice_urls)
            + ("\n" if jsluice_urls else "[]\n")
        )

        # ── 2. Normalized findings list (deduped by rule+path+line) ──
        normalized: list[dict] = []
        seen: set[tuple[str, str, int]] = set()
        for f in raw_semgrep:
            rule_id = f.get("check_id", "")
            path = f.get("path", "")
            line = f.get("start", {}).get("line", 0)
            key = (rule_id, path, line)
            if key in seen:
                continue
            seen.add(key)
            normalized.append({
                "rule_id": rule_id,
                "severity": f.get("extra", {}).get("severity", "INFO"),
                "path": path,
                "line": line,
                "end_line": f.get("end", {}).get("line", 0),
                "message": f.get("extra", {}).get("message", ""),
                "code": f.get("extra", {}).get("lines", ""),
                "source": "semgrep",
                # Field alias for downstream consumers that expect "file"
                # (correlate_evidence_handler reads finding.get("file")).
                "file": Path(path).name if path else "",
                "filepath": path,
            })

        # ── 3. First-party vs third-party classification ──
        # Bug fix: the previous list only covered the canonical
        # production-minified filenames (angular.min.js etc.) but missed
        # version-suffixed standalone bundles (angular_1-7-7.js,
        # jquery-3.7.1.min.js, etc.) which are still third-party.
        # We use both basename matching and a "starts-with-library-name"
        # heuristic to catch them.
        third_party_files = {
            "react.development.js", "react-dom.development.js",
            "react.production.min.js", "angular.js", "angular.min.js",
            "angular_1-7-7.js",  # version-suffixed AngularJS 1.x standalone
            "vue.runtime.global.js", "vue.global.js", "jquery.min.js",
            "jquery.js", "bootstrap.min.js", "bootstrap.js", "popper.min.js",
            "lodash.min.js", "lodash.js", "moment.min.js", "moment.js",
            "d3.min.js", "d3.js", "rxjs.min.js", "rxjs.js",
            "backbone.js", "backbone.min.js", "underscore.js", "underscore-min.js",
            "handlebars.js", "handlebars.min.js", "ember.js", "ember.min.js",
        }
        # Heuristics for version-suffixed third-party bundles. The pattern
        # is "library-name or vendor-prefix" followed by an underscore or
        # dash, then a version number, then .js. Examples:
        #   angular_1-7-7.js  → angular
        #   jquery-3.7.1.min.js → jquery
        #   react-18.2.0.js  → react
        #   vue-2.6.14.min.js → vue
        #   lodash-4.17.21.min.js → lodash
        third_party_prefixes = (
            "angular", "react", "react-dom", "vue", "jquery", "bootstrap",
            "lodash", "moment", "d3", "rxjs", "backbone", "underscore",
            "handlebars", "ember", "knockout", "polyfill", "babel",
        )
        def classify(path: str) -> str:
            """Return 'first_party' or 'third_party' for a JS file path.

            HTML files are always first_party (they're the app's pages).

            Order of checks for JS files:
            1. Exact basename in third_party_files (catches production
               minified bundles with canonical names).
            2. Starts with one of third_party_prefixes followed by _ or -
               AND has a version-like segment (catches angular_1-7-7.js,
               jquery-3.7.1.min.js, etc.).
            3. Otherwise first_party (the JS file is app code we wrote).
            """
            if path.lower().endswith(".html"):
                return "first_party"
            from re import match as _re_match
            base = Path(path).name
            if base in third_party_files:
                return "third_party"
            # Version-suffixed check: prefix followed by _version or -version
            lower_base = base.lower()
            for prefix in third_party_prefixes:
                if lower_base.startswith(prefix + "_") or lower_base.startswith(prefix + "-"):
                    # Look for a version-like segment: digit.digit(.digit)?
                    if _re_match(r"^[a-zA-Z\-_]+[_\-]\d+(?:\.\d+){0,3}", lower_base):
                        return "third_party"
                    break
            return "first_party"

        for finding in normalized:
            finding["file_class"] = classify(finding.get("path", ""))

        # ── 4. Write consolidated findings.json ──
        severity_counts = {
            "ERROR": sum(1 for f in normalized if f["severity"] == "ERROR"),
            "WARNING": sum(1 for f in normalized if f["severity"] == "WARNING"),
            "INFO": sum(1 for f in normalized if f["severity"] == "INFO"),
        }
        consolidated = {
            "schema_version": 1,
            "session_id": self.session_id,
            "target_url": self.target_url,
            "scan_timestamp": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "summary": {
                "semgrep_count": len(normalized),
                "jsluice_secrets_count": len(jsluice_secrets),
                "jsluice_urls_count": len(jsluice_urls),
                "first_party_findings": sum(
                    1 for f in normalized if f["file_class"] == "first_party"
                ),
                "third_party_findings": sum(
                    1 for f in normalized if f["file_class"] == "third_party"
                ),
                "by_severity": severity_counts,
            },
            "findings": normalized,
            "secrets": jsluice_secrets,
            "urls": jsluice_urls,
        }
        (sast_dir / "findings.json").write_text(json.dumps(consolidated, indent=2))

        # ── 5. Findings grouped by file ──
        by_file: dict[str, list[dict]] = {}
        for f in normalized:
            by_file.setdefault(f["file"] or "<unknown>", []).append(
                {
                    "rule_id": f["rule_id"],
                    "line": f["line"],
                    "severity": f["severity"],
                    "file_class": f["file_class"],
                    "message": f["message"][:200],
                }
            )
        (sast_dir / "findings_by_file.json").write_text(json.dumps(by_file, indent=2))

        # ── 6. Human-readable markdown ──
        md: list[str] = [
            f"# SAST Scan Results — {self.target_url}",
            "",
            f"**Session:** `{self.session_id}`  ",
            f"**Scanned:** {consolidated['scan_timestamp']}  ",
            f"**JS files scanned:** {len(list((Path(self.output_dir) / 'assets' / 'js').glob('*.js'))) if (Path(self.output_dir) / 'assets' / 'js').exists() else 0}",
            "",
            "## Summary",
            "",
            f"- **Semgrep findings:** {len(normalized)} (ERROR: {severity_counts['ERROR']}, WARNING: {severity_counts['WARNING']}, INFO: {severity_counts['INFO']})",
            f"- **jsluice secrets:** {len(jsluice_secrets)}",
            f"- **jsluice URLs/endpoints:** {len(jsluice_urls)}",
            f"- **First-party findings:** {consolidated['summary']['first_party_findings']}",
            f"- **Third-party findings:** {consolidated['summary']['third_party_findings']}",
            "",
            "## First-Party Findings (high-signal)",
            "",
        ]
        fp = [f for f in normalized if f["file_class"] == "first_party"]
        if fp:
            for f in fp:
                md.append(f"### {f['file']}:{f['line']} — {f['severity']}")
                md.append(f"- **Rule:** `{f['rule_id']}`")
                md.append(f"- **Message:** {f['message']}")
                if f.get("code"):
                    md.append("- **Code:**")
                    md.append("  ```js")
                    for line in f["code"].strip().splitlines():
                        md.append(f"  {line}")
                    md.append("  ```")
                md.append("")
        else:
            md.append("_(no first-party findings)_")
            md.append("")

        md.append("## Third-Party Findings (framework noise — lower priority)")
        md.append("")
        tp = [f for f in normalized if f["file_class"] == "third_party"]
        if tp:
            for f in tp[:20]:  # cap to first 20
                short_rule = f["rule_id"].split(".")[-1]
                md.append(f"- **{f['file']}:{f['line']}** — `{short_rule}` ({f['severity']})")
            if len(tp) > 20:
                md.append(f"- _...and {len(tp) - 20} more (see findings.json)_")
            md.append("")

        if jsluice_urls:
            md.append("## Discovered Endpoints (jsluice URLs)")
            md.append("")
            for u in jsluice_urls[:30]:
                url = u.get("url", "")
                method = u.get("method", "GET")
                fn = Path(u.get("filename", "")).name if u.get("filename") else "?"
                md.append(f"- `{method} {url}` (from `{fn}`)")
            if len(jsluice_urls) > 30:
                md.append(f"- _...and {len(jsluice_urls) - 30} more_")
            md.append("")

        (sast_dir / "findings.md").write_text("\n".join(md))

        # ── 7. Update state.sast_findings with normalized list ──
        # (so dedup_within_source and correlate_evidence see consistent fields)
        self.state.sast_findings = normalized
        self.state.metadata.setdefault("sast", {})
        self.state.metadata["sast"]["findings_path"] = str(sast_dir / "findings.json")
        self.state.metadata["sast"]["findings_md_path"] = str(sast_dir / "findings.md")
        self.state.metadata["sast"]["semgrep_count"] = len(normalized)
        self._save_state()

        # ── 8. Post summary drawer to mempalace ──
        # The orchestrator can't call the mempalace MCP tool directly,
        # so we write a small "ready-to-post" stub file that the skill
        # extension (or Penny) reads and turns into a memory_add_drawer call.
        # The file uses a stable naming convention: <session>-mempalace-stubs.json
        # (one drawer per stub).
        stubs_path = Path(self.output_dir) / "mempalace_stubs.json"
        try:
            existing: list[dict] = []
            if stubs_path.exists():
                existing = json.loads(stubs_path.read_text())
        except Exception:
            existing = []

        summary_content = (
            f"## SAST Findings — session {self.session_id}\n\n"
            f"**Target:** {self.target_url}\n"
            f"**Scanned:** {consolidated['scan_timestamp']}\n"
            f"**Semgrep findings:** {len(normalized)} "
            f"(ERROR: {severity_counts['ERROR']}, WARNING: {severity_counts['WARNING']})\n"
            f"**First-party findings:** {consolidated['summary']['first_party_findings']}\n"
            f"**Third-party findings:** {consolidated['summary']['third_party_findings']}\n"
            f"**jsluice URLs:** {len(jsluice_urls)}\n"
            f"**jsluice secrets:** {len(jsluice_secrets)}\n\n"
            f"**Full findings:** `{sast_dir / 'findings.json'}`\n"
            f"**Human-readable:** `{sast_dir / 'findings.md'}`\n\n"
            f"### Top first-party findings (by severity):\n"
        )
        for f in sorted(fp, key=lambda x: (x["severity"] != "ERROR", x["file"]))[:10]:
            summary_content += (
                f"- `{f['file']}:{f['line']}` {f['severity']} — {f['rule_id'].split('.')[-1]}\n"
            )

        # ── Bug fix: include full findings inline in the drawer ──
        # annie (SAST_VALIDATE agent) reads from mempalace, not from disk.
        # If we only put a summary + path in the drawer, annie would have
        # to do filesystem I/O from inside the agent — which is unreliable
        # and slow. Instead, embed the full first-party findings as a
        # fenced JSON block. The summary section above stays human-readable.
        # The third-party findings are stored on disk only (not in mempalace)
        # to keep the drawer size reasonable; they're framework noise.
        summary_content += "\n### First-party findings (full JSON, annie-read this):\n"
        summary_content += "```json\n"
        summary_content += json.dumps(fp, indent=2)
        summary_content += "\n```\n"

        existing.append({
            "wing": "wing_jsa",
            "room": f"{self.session_id}-sast-findings",
            "content": summary_content,
            "added_by": "orchestrate.py:_persist_sast_artifacts",
            "added_at": consolidated["scan_timestamp"],
        })

        # Note: CVE research has its own dedicated stub writer
        # (_write_cve_research_stub in _cve_research_directive) which runs
        # before SAST_SCAN. We do NOT also write a cve-research stub here
        # because the orchestrator may run SAST_SCAN multiple times (resume,
        # retries) and would duplicate the cve-research drawer. The
        # _write_cve_research_stub function dedupes by room, so it's the
        # single source of truth for the cve-research room.

        stubs_path.write_text(json.dumps(existing, indent=2))
        self.state.metadata["sast"]["mempalace_stubs_path"] = str(stubs_path)
        self._save_state()

    def _write_cve_research_stub(self) -> None:
        """Write CVE research result to mempalace_stubs.json.

        Bug fix: the cve_research_handler writes its full output to disk
        under {output_dir}/cves/ but doesn't post to mempalace. This
        method appends a single summary drawer to the same stubs file
        the SAST persistence uses, so Penny/the skill extension can
        batch-post all session-level findings to wing_jsa.
        """
        import datetime as _dt
        stubs_path = Path(self.output_dir) / "mempalace_stubs.json"
        try:
            existing: list[dict] = []
            if stubs_path.exists():
                existing = json.loads(stubs_path.read_text())
        except Exception:
            existing = []

        # De-dupe by (wing, room) — CVE research runs before SAST but we may
        # be called multiple times if the FSM ever loops back
        existing = [s for s in existing if s.get("room") != f"{self.session_id}-cve-research"]

        cve_meta = self.state.metadata.get("cve_research", {})
        versions = cve_meta.get("versions", {})
        cves = cve_meta.get("cves", [])
        tech_hints = cve_meta.get("tech_stack_hints", {})
        purls = cve_meta.get("component_purls", {})

        content = (
            f"## CVE Research — session {self.session_id}\n\n"
            f"**Target:** {self.target_url}\n"
            f"**Technologies detected:** {cve_meta.get('technologies_detected', 0)}\n"
            f"**Versions extracted:** {len(versions)}\n"
            f"**CVEs found:** {cve_meta.get('cve_count', 0)}\n"
            f"**Tech stack:** {list(tech_hints.keys())}\n"
            f"**PURLs:** {list(purls.keys())}\n\n"
            f"### Detected tech + versions:\n"
        )
        for tech, ver in sorted(versions.items()):
            files = tech_hints.get(tech, [])
            content += f"- **{tech}** v{ver}"
            if files:
                content += f" (in: {', '.join(files[:3])}{'...' if len(files) > 3 else ''})"
            content += "\n"

        if cves:
            content += f"\n### Top CVEs:\n"
            for cve in cves[:10]:
                cve_id = cve.get("cve_id", "unknown")
                lib = cve.get("library", "?")
                score = cve.get("cvss_score", "?")
                content += f"- **{cve_id}** ({lib}, CVSS {score})\n"

        content += f"\n**Full report:** `{cve_meta.get('cve_report_path', 'N/A')}`\n"
        content += f"**Artifacts dir:** `{cve_meta.get('cve_artifacts_dir', 'N/A')}`\n"

        existing.append({
            "wing": "wing_jsa",
            "room": f"{self.session_id}-cve-research",
            "content": content,
            "added_by": "orchestrate.py:_write_cve_research_stub",
            "added_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        })
        stubs_path.write_text(json.dumps(existing, indent=2))
        self.state.metadata.setdefault("cve_research", {})["mempalace_stubs_path"] = str(stubs_path)

    # ── Auth + Katana Crawl + HTML Classification Helpers ──────────

    @staticmethod
    def _build_auth_katana_args(intake: dict) -> tuple[list[str], dict]:
        """Build auth arguments for katana/curl from intake questionnaire data.

        Returns (cli_args, env_dict) where:
          - cli_args: list of -H flags for katana or curl
          - env_dict: environment variables for subprocess.run(env=...)

        Tokens are passed via env vars, never as literal CLI args, to
        prevent credential leakage in ps aux output.
        """
        args: list[str] = []
        env: dict = {}

        auth_mode = intake.get("authenticated_testing", "anonymous_only")
        if auth_mode == "anonymous_only":
            return args, env

        session_mgmt = intake.get("session_management", "")
        session_details = intake.get("session_details", "")

        if session_mgmt == "cookie":
            # Cookie-based: pass via -H "Cookie: ..."
            cookie_value = session_details.strip()
            if cookie_value:
                # If session_details is a raw cookie string, use it directly
                if "=" in cookie_value and "\n" not in cookie_value:
                    args.extend(["-H", f"Cookie: {cookie_value}"])
                else:
                    # Multi-line or complex — pass via env var for safety
                    env["JSA_COOKIE"] = cookie_value
                    args.extend(["-H", "Cookie: $JSA_COOKIE"])

        elif session_mgmt == "jwt_header":
            token = session_details.strip()
            if token:
                env["JSA_TOKEN"] = token
                args.extend(["-H", "Authorization: Bearer $JSA_TOKEN"])

        elif session_mgmt == "custom_header":
            for line in session_details.split("\n"):
                line = line.strip()
                if ":" in line:
                    key, val = line.split(":", 1)
                    key = key.strip()
                    val = val.strip()
                    env_key = f"JSA_HDR_{key.upper().replace('-', '_')}"
                    env[env_key] = val
                    args.extend(["-H", f"{key}: ${env_key}"])

        elif session_mgmt == "mixed":
            # Cookie + headers combined
            for line in session_details.split("\n"):
                line = line.strip()
                if not line:
                    continue
                if "=" in line and ":" not in line:
                    # Looks like a cookie
                    env["JSA_COOKIE"] = line
                    args.extend(["-H", "Cookie: $JSA_COOKIE"])
                elif ":" in line:
                    key, val = line.split(":", 1)
                    key = key.strip()
                    val = val.strip()
                    env_key = f"JSA_HDR_{key.upper().replace('-', '_')}"
                    env[env_key] = val
                    args.extend(["-H", f"{key}: ${env_key}"])

        return args, env

    def _run_katana_crawl(
        self,
        target_url: str,
        output_dir: str,
        depth: int = 5,
        auth_headers: list[str] | None = None,
        auth_env: dict | None = None,
        timeout: int = 300,
    ) -> list[dict]:
        """Run katana crawl and return parsed JSONL entries.

        Katana handles: URL discovery, link extraction, scope enforcement,
        rate limiting, and response storage. We parse the JSONL output.
        """
        import subprocess

        katana_bin = "katana"
        response_dir = str(Path(output_dir) / "assets" / "katana_responses")
        Path(response_dir).mkdir(parents=True, exist_ok=True)

        cmd = [
            katana_bin,
            "-u", target_url,
            "-d", str(depth),
            "-jsonl",
            "-silent",
            "-store-response",
            "-store-response-dir", response_dir,
            "-field-scope", "fqdn",
            "-filter-similar",
            "-kf", "all",
        ]

        if auth_headers:
            for header in auth_headers:
                cmd.extend(["-H", header])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env={**__import__("os").environ, **(auth_env or {})},
            )
        except subprocess.TimeoutExpired:
            return []
        except FileNotFoundError:
            return []

        entries: list[dict] = []
        for line in result.stdout.strip().split("\n"):
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return entries

    def _classify_html(self, html: str, url: str) -> dict:
        """Classify HTML page as meaningful and extract structured data.

        Returns dict with: meaningful, forms, api_calls, external_scripts,
        interactive_elements, inline_script_count.

        Meaningful = has forms OR has API calls (fetch/XHR/ajax) OR has
        event handlers OR has interactive elements.
        """
        result: dict = {
            "meaningful": False,
            "forms": [],
            "api_calls": [],
            "external_scripts": [],
            "interactive_elements": [],
            "inline_script_count": 0,
        }

        # Asset exclusion by URL extension
        url_lower = url.split("?")[0].lower()
        asset_exts = (
            ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg",
            ".woff", ".woff2", ".ttf", ".ico", ".pdf",
        )
        if url_lower.endswith(asset_exts):
            return result

        # Size exclusion: <200 bytes likely error/empty pages
        if len(html.strip()) < 200:
            return result

        # HTML structure checks
        # Check 1: Forms
        form_count = html.count("<form")
        if form_count > 0:
            result["meaningful"] = True

        # Check 2: Interactive elements
        interactive_tags = ("<button", "<input", "<select", "<textarea")
        if any(tag in html for tag in interactive_tags):
            result["meaningful"] = True
            result["interactive_elements"] = [
                tag.strip("<") for tag in interactive_tags if tag in html
            ]

        # Check 3: Event handlers
        event_handlers = ("onclick=", "onsubmit=", "onchange=", "oninput=")
        if any(eh in html for eh in event_handlers):
            result["meaningful"] = True

        # Check 4: API calls in inline scripts
        api_patterns = (
            r"fetch\s*\(", r"XMLHttpRequest", r"\$\.ajax\s*\(",
            r"\$\.get\s*\(", r"\$\.post\s*\(", r"axios\.",
        )
        api_re = re.compile("|".join(api_patterns), re.IGNORECASE)
        api_matches = api_re.findall(html)
        if api_matches:
            result["meaningful"] = True
            result["api_calls"] = api_matches[:50]

        # Extract external script refs and inline script count
        SCRIPT_SRC_RE = re.compile(
            r'<script[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE
        )
        result["external_scripts"] = SCRIPT_SRC_RE.findall(html)[:100]

        INLINE_SCRIPT_RE = re.compile(
            r'<script[^>]*?>\s*(.*?)\s*</script>', re.DOTALL | re.IGNORECASE
        )
        result["inline_script_count"] = len(INLINE_SCRIPT_RE.findall(html))

        return result

    def _url_to_slug(self, url: str, seen_slugs: set[str]) -> str:
        """Convert URL to filesystem-safe slug for HTML filenames."""
        from urllib.parse import urljoin, urlparse

        parsed = urlparse(url)
        path = parsed.path or "/"
        path = urljoin("http://x", path)
        path = urlparse(path).path or "/"
        path = path.rstrip("/")

        if not path or path == "/":
            slug = "homepage"
        else:
            slug = path.lstrip("/")
            slug = re.sub(r"[^a-zA-Z0-9._-]", "_", slug)
            slug = re.sub(r"_+", "_", slug)
            slug = slug.strip("_")
            slug = slug[:200]
            if not slug:
                slug = "page"

        base_slug = slug
        counter = 2
        while f"{slug}.html" in seen_slugs:
            slug = f"{base_slug}_{counter}"
            counter += 1
        return slug

    def _acquire_locally(self, directive: Directive) -> None:
        """Download JS files locally via curl + katana with recursive discovery.

        Steps:
          1. Run katana crawl (depth 5) → discover all HTML pages + responses.
          2. Classify each crawled page as meaningful/static.
          3. For meaningful pages: save HTML, extract inline scripts per-page,
             extract <script src> URLs, build page_entries for inline_index.
          4. Recursively (depth <= 5) run jsluice urls on each downloaded JS,
             queue discovered JS imports, and skip already-seen / out-of-scope.
          5. Generate inline_index.json correlation manifest.
          6. Collect API endpoints from jsluice for later analysis.
        """
        from urllib.parse import urljoin
        import os
        import subprocess

        target_url = self.target_url
        js_dir = self.state.js_dir
        html_dir = self.state.html_dir
        jsluice_bin = str(Path.home() / "go" / "bin" / "jsluice")
        max_depth = 5

        js_dir.mkdir(parents=True, exist_ok=True)
        html_dir.mkdir(parents=True, exist_ok=True)

        seen_urls: set[str] = set()
        seen_slugs: set[str] = set()
        endpoints: list[dict] = []
        page_entries: list[dict] = []
        script_srcs: list[str] = []
        meaningful_count = 0
        static_count = 0
        inline_count = 0

        # ── Build auth args from intake questionnaire data ──
        intake = self.state.metadata.get("intake", {})
        auth_args, auth_env = self._build_auth_katana_args(intake)

        # ── Step 1: Katana crawl ──
        katana_entries = self._run_katana_crawl(
            target_url,
            self.output_dir,
            depth=max_depth,
            auth_headers=auth_args,
            auth_env=auth_env,
        )

        curl_env = {**os.environ, **auth_env}

        # Fallback: if katana produced no results, use curl-based homepage download
        if not katana_entries:
            html_path = html_dir / "homepage.html"
            try:
                subprocess.run(
                    ["curl", "-sL", "--max-time", "15", "-o", str(html_path),
                     target_url] + auth_args,
                    capture_output=True, text=True, timeout=20, check=True,
                    env=curl_env,
                )
            except Exception as e:
                self.state.errors.append(f"curl homepage failed: {e}")
                self._save_state()
                return

            if not html_path.exists():
                self.state.errors.append("Homepage HTML not downloaded")
                self._save_state()
                return

            html_body = html_path.read_text(errors="replace")

            # Extract inline scripts + script srcs from homepage
            for i, match in enumerate(INLINE_SCRIPT_RE.finditer(html_body)):
                script = match.group(1).strip()
                if script:
                    inline_path = js_dir / f"inline_{i}.js"
                    inline_path.write_text(script)
                    inline_count += 1

            for match in SCRIPT_SRC_RE.finditer(html_body):
                src = match.group(1).strip()
                if src:
                    full_url = urljoin(target_url, src)
                    script_srcs.append(full_url)

            # No katana pages to process — skip to JS download
            katana_entries = []

        # ── Step 2: Process crawled pages ──

        for entry in katana_entries:
            url = entry.get("request", {}).get("endpoint", "")
            response = entry.get("response", {})
            html_body = response.get("body", "")
            stored_path = response.get("stored_response_path", "")

            # If body is empty but stored path exists, read from file
            if not html_body and stored_path:
                try:
                    html_body = Path(stored_path).read_text(errors="replace")
                except Exception:
                    continue

            if not html_body:
                continue

            # Classify the page
            classification = self._classify_html(html_body, url)

            slug = self._url_to_slug(url, seen_slugs)
            seen_slugs.add(f"{slug}.html")

            if classification["meaningful"]:
                meaningful_count += 1

                # Save HTML
                html_path = html_dir / f"{slug}.html"
                try:
                    html_path.write_text(html_body)
                except Exception:
                    continue

                # Extract inline scripts per-page
                inline_entries: list[dict] = []
                for i, match in enumerate(INLINE_SCRIPT_RE.finditer(html_body)):
                    script = match.group(1).strip()
                    if script:
                        inline_name = f"{slug}_inline_{i}.js"
                        inline_path = js_dir / inline_name
                        inline_path.write_text(script)
                        inline_count += 1
                        inline_entries.append({
                            "js_file": inline_name,
                            "line_start": html_body[:match.start()].count("\n") + 1,
                            "line_end": html_body[:match.end()].count("\n") + 1,
                        })

                # Extract <script src> URLs
                for match in SCRIPT_SRC_RE.finditer(html_body):
                    src = match.group(1).strip()
                    if src:
                        full_url = urljoin(url, src)
                        if full_url not in seen_urls:
                            script_srcs.append(full_url)

                # Collect page entry for inline_index.json
                page_entries.append({
                    "html_file": f"{slug}.html",
                    "html_url": url,
                    "inline_scripts": inline_entries,
                    "external_scripts": classification["external_scripts"],
                    "page_type": "meaningful",
                    "forms": classification["forms"],
                    "api_calls": classification["api_calls"],
                })
            else:
                static_count += 1
                # Delete static HTML unless keep_all_html flag
                if not self.constraints.get("keep_all_html", False):
                    # Only delete if we wrote it (we didn't, since it's static)
                    pass

            # Incremental save every 10 meaningful pages
            if meaningful_count > 0 and meaningful_count % 10 == 0:
                self.state.metadata["acquire"] = {
                    "meaningful_html": meaningful_count,
                    "static_html": static_count,
                    "total_pages_crawled": len(katana_entries),
                }
                self._save_state()

        # ── Step 3: Recursive JS discovery queue (existing logic) ──
        queue: list[str] = list(script_srcs)
        depth = 0

        while queue and depth < max_depth:
            next_queue: list[str] = []
            for url in queue:
                # Skip already-seen and out-of-scope
                if url in seen_urls:
                    continue
                patterns = self.constraints.get("out_of_scope", [])
                if _is_out_of_scope(url, patterns):
                    continue
                seen_urls.add(url)

                # Download the JS file
                filename = url.rsplit("/", 1)[-1]
                if "?" in filename:
                    filename = filename.split("?")[0]
                if not filename.endswith(".js"):
                    filename += ".js"
                out_path = js_dir / filename

                try:
                    subprocess.run(
                        ["curl", "-sL", "--max-time", "15", "-o", str(out_path),
                         url] + auth_args,
                        capture_output=True, text=True, timeout=20, check=True,
                        env=curl_env,
                    )
                except Exception as e:
                    self.state.errors.append(f"curl {url}: {e}")
                    continue

                # Run jsluice urls on the downloaded file
                if Path(jsluice_bin).exists() and out_path.exists():
                    try:
                        result = subprocess.run(
                            [jsluice_bin, "urls", str(out_path)],
                            capture_output=True, text=True, timeout=30,
                        )
                        for line in result.stdout.strip().split("\n"):
                            if not line.strip():
                                continue
                            try:
                                entry = json.loads(line)
                            except json.JSONDecodeError:
                                continue

                            entry_url = entry.get("url", "")
                            entry_type = entry.get("type", "")

                            # Collect API endpoints for later
                            if entry_type in (
                                "fetch", "xhr", "locationAssignment",
                                "open", "jqueryAjax",
                            ):
                                endpoints.append(entry)

                            # Queue JS files for download
                            if _is_js_file_url(entry):
                                full_url = urljoin(url, entry_url)
                                if full_url not in seen_urls:
                                    next_queue.append(full_url)
                    except Exception:
                        pass

            queue = next_queue
            depth += 1

        # ── Step 5: Save metadata and inline_index.json ──
        # Generate inline_index.json
        inline_index = {
            "schema_version": 1,
            "total_pages": meaningful_count,
            "entries": page_entries,
        }
        inline_index_path = self.state.assets_dir / "inline_index.json"
        inline_index_path.write_text(json.dumps(inline_index, indent=2))

        self.state.metadata["acquire"] = {
            "js_files": len(list(js_dir.glob("*.js"))),
            "html_files": len(list(html_dir.glob("*.html"))),
            "meaningful_html": meaningful_count,
            "static_html": static_count,
            "total_pages_crawled": len(katana_entries),
            "inline_scripts": inline_count,
            "seen_urls": len(seen_urls),
            "endpoints_found": len(endpoints),
            "recursion_depth": depth,
            "inline_index_path": str(inline_index_path),
            "pages_with_forms": sum(1 for e in page_entries if e.get("forms")),
            "pages_with_api_calls": sum(1 for e in page_entries if e.get("api_calls")),
        }
        # Store endpoints and inline_index content for later phases
        self.state.metadata["endpoints"] = endpoints
        self.state.metadata["acquire"]["inline_index_content"] = json.dumps(inline_index)
        self.state.metadata["acquire"]["inline_index_mempalace_room"] = (
            f"{self.session_id}-pages"
        )
        self._save_state()

    def _execute_local_phase(self, directive: Directive) -> None:
        """Execute a local directive (ACQUIRE, CVE_RESEARCH, COLLECT, DEDUP)."""
        try:
            phase = directive.phase

            if phase == "ACQUIRE":
                self._acquire_locally(directive)

            elif phase == "CVE_RESEARCH":
                # cve_research_handler already ran in _cve_research_directive().
                # Tech stack results are in state.metadata["cve_research"].
                # Future: fingerprint engine integration (Step 5) happens here.
                self._save_state()

            elif phase == "COLLECT":
                # Findings are in mempalace - this is a no-op in CLI mode
                # The FSM advances to MERGE which will read from mempalace
                self._save_state()

            elif phase == "NORMALIZE":
                from fsm import normalize_handler
                normalize_handler(self.state)
                self._save_state()

            elif phase == "DEDUP_WITHIN_SOURCE":
                from fsm import dedup_within_source_handler
                dedup_within_source_handler(self.state)
                self._save_state()

            elif phase == "CORRELATE_EVIDENCE":
                from fsm import correlate_evidence_handler
                correlate_evidence_handler(self.state)
                self._save_state()

            elif phase == "AGENT_REVIEW":
                from fsm import agent_reviewer_handler
                agent_reviewer_handler(self.state)
                self._save_state()

            elif phase == "DEDUP":
                # Backward compat: all three phases combined
                from fsm import dedup_handler
                dedup_handler(self.state)
                self._save_state()

            elif phase == "STRUCTURE":
                # Build typed analysis store (ModuleCard, PageCard, AST indexes)
                from fsm import structure_handler
                # Read JS files from assets/js/ directory (set by ACQUIRE)
                js_files = []
                js_dir = self.state.js_dir
                if js_dir.exists():
                    for js_path in js_dir.glob("*.js"):
                        try:
                            content = js_path.read_text(encoding="utf-8", errors="replace")
                            js_files.append((str(js_path), content))
                        except (OSError, IOError):
                            pass
                structure_handler(self.state, js_files=js_files)
                self._save_state()

            elif phase == "SLICE":
                # Per-class candidate generation (FlowCard)
                from fsm import slice_handler
                slice_handler(self.state)
                self._save_state()

        except Exception as e:
            import traceback
            self.state.errors.append(f"Local phase {directive.phase} failed: {e}\n{traceback.format_exc()}")
            self._save_state()

    def _build_dispatch_action(self, directive: Directive) -> Dict[str, Any]:
        """Build an invoke_agents_parallel action for the DISPATCH phase."""
        plan = directive.context or {}
        waves = plan.get("waves", [])

        # Flatten all wave tasks into one parallel batch
        all_tasks = []
        for wave in waves:
            for task in wave.get("tasks", []):
                task_text = task.get("task", "")
                wing_note = "\n\nIMPORTANT: Write ALL mempalace entries to wing=wing_jsa."
                all_tasks.append({
                    "agent": task.get("agent", "annie"),
                    "task_summary": task_text + wing_note,
                    "skillContext": task.get("skillContext"),
                })

        action = {
            "action": "invoke_agents_parallel",
            "state_id": directive.phase,
            "session_id": directive.session_id,
            "description": directive.description,
            "tasks": all_tasks,
            "orchestrator_state": self.extract_state(),
        }
        return action

    def _build_cve_research_poc_action(self, directive: Directive) -> Dict[str, Any]:
        """Build an invoke_agents_parallel action for CVE_RESEARCH PoC dispatch."""
        tasks_data = (directive.context or {}).get("tasks", [])

        parallel_tasks = []
        for t in tasks_data:
            task_text = t.get("task", "")
            cve_id = t.get("cve_id", "unknown")
            wing_note = (
                f"\n\nIMPORTANT: Write ALL mempalace entries to "
                f"wing=wing_jsa, room={t.get('output_room', self.session_id + '-cve-validate')}. "
                f"Research PoC for {cve_id}. Search for public exploit code, "
                f"GitHub PoCs, writeups. If no PoC found, research the "
                f"vulnerability mechanics and describe how to test for it."
            )
            parallel_tasks.append({
                "agent": t.get("agent", "echo"),
                "task_summary": task_text + wing_note,
                "skillContext": None,
            })

        return {
            "action": "invoke_agents_parallel",
            "state_id": directive.phase,
            "session_id": directive.session_id,
            "description": directive.description,
            "tasks": parallel_tasks,
            "orchestrator_state": self.extract_state(),
        }

    def _complete_action(self) -> Dict[str, Any]:
        """Build completion action.

        Bug fix: surface the mempalace stubs file path in the completion
        message so Penny (the agent reading this) knows to push the stubs
        to mempalace. Without this, the stubs sit in {output_dir}/
        mempalace_stubs.json and the session-{id}-sast-findings /
        session-{id}-cve-research rooms in mempalace stay empty, defeating
        the point of the stubs.
        """
        stubs_path = str(Path(self.output_dir) / "mempalace_stubs.json")
        stubs_exist = Path(stubs_path).exists()
        description = "Pipeline complete"
        if stubs_exist:
            description += (
                f" IMPORTANT — Mempalace handoff required: "
                f"`apply_mempalace_stubs({self.output_dir!r})` returns "
                f"`{stubs_path}`. Penny: call `memory_add_drawer(wing=s['wing'], "
                f"room=s['room'], content=s['content'])` for each entry to "
                f"populate `{self.session_id}-sast-findings` and "
                f"`{self.session_id}-cve-research` in wing_jsa. Without "
                f"this, downstream agents/handlers can't see SAST or CVE "
                f"research results."
            )
        return {
            "action": "complete",
            "phase": "COMPLETED",
            "session_id": self.session_id,
            "description": description,
            "orchestrator_state": self.extract_state(),
            "summary": {
                "output_dir": self.output_dir,
                "raw_findings": len(self.state.raw_findings),
                "merged_findings": len(self.state.merged_findings),
                "verified_findings": len(self.state.verified_findings),
                "mempalace_stubs_path": stubs_path if stubs_exist else None,
                "mempalace_stubs_count": (
                    len(json.loads(Path(stubs_path).read_text()))
                    if stubs_exist else 0
                ),
            },
        }

    def _get_directive_for_phase(self, phase: JSAPhase) -> Optional[Directive]:
        """Get directive for a phase using existing handlers."""
        directives = {
            JSAPhase.INTAKE: self._intake_directive,
            JSAPhase.ACQUIRE: self._acquire_directive,
            JSAPhase.CVE_RESEARCH: self._cve_research_directive,
            JSAPhase.SAST_SCAN: self._sast_scan_directive,
            JSAPhase.NORMALIZE: self._normalize_directive,
            JSAPhase.DEDUP_WITHIN_SOURCE: self._dedup_within_source_directive,
            JSAPhase.CORRELATE_EVIDENCE: self._correlate_evidence_directive,
            JSAPhase.AGENT_REVIEW: self._agent_review_directive,
            JSAPhase.SAST_VALIDATE: self._sast_validate_directive,
            JSAPhase.STRUCTURE: self._structure_directive,
            JSAPhase.SLICE: self._slice_directive,
            JSAPhase.STOP: self._stop_directive,
            JSAPhase.INVESTIGATE: self._investigate_directive,
            JSAPhase.COLLECT: self._collect_directive,
            JSAPhase.MERGE: self._merge_directive,
            JSAPhase.VERIFY: self._verify_directive,
            JSAPhase.REPORT: self._report_directive,
            JSAPhase.REFLECT: self._reflect_directive,
        }
        handler = directives.get(phase)
        if handler:
            return handler()
        return None

    # ── INTAKE validation ────────────────────────────────────────────

    # Single source of truth for the intake schema. Each entry defines a
    # required-or-conditional field. The schema is used by:
    #   - validate_intake():     to check whether the intake record is valid
    #   - _intake_directive():   to build questionnaire questions for missing fields
    #
    # Entry shape:
    #   key:           the intake field name (stored under state.metadata["intake"][key])
    #   label:         short tab label for the questionnaire UI
    #   prompt:        the user-facing question text
    #   options:       list of {value, label, description?} for predefined choices
    #                   (empty list means "no predefined options" — user must use "Type something")
    #   validate:      callable(value) -> bool  (defaults to "non-empty string")
    _INTAKE_SCHEMA: list[dict] = [
        {
            "key": "target_url",
            "label": "Target URL",
            "prompt": "What is the target URL for the security analysis?",
            "options": [],
            "validate": lambda v: isinstance(v, str) and (
                v.startswith("http://") or v.startswith("https://")
            ),
        },
        {
            "key": "authenticated_testing",
            "label": "Auth mode",
            "prompt": "How should authenticated testing be handled?",
            "options": [
                {"value": "anonymous_only", "label": "Anonymous only — no authenticated testing"},
                {"value": "both", "label": "Anonymous + Authenticated — test both contexts"},
                {"value": "authenticated_only", "label": "Authenticated only — all testing with credentials"},
            ],
            "validate": lambda v: v in ("anonymous_only", "both", "authenticated_only"),
        },
        {
            "key": "session_management",
            "label": "Sessions",
            "prompt": "How does the application manage sessions?",
            "options": [
                {"value": "cookie", "label": "Cookie-based sessions (Set-Cookie header)"},
                {"value": "jwt_header", "label": "JWT in Authorization header (Bearer token)"},
                {"value": "oauth2", "label": "OAuth 2.0 / OpenID Connect"},
                {"value": "custom_header", "label": "Custom header (e.g., X-Session-Token)"},
                {"value": "mixed", "label": "Mixed / Multiple mechanisms"},
            ],
            "validate": lambda v: v in ("cookie", "jwt_header", "oauth2", "custom_header", "mixed"),
        },
        {
            "key": "auth_instructions",
            "label": "Auth details",
            "prompt": (
                "Provide authentication details: login URL, method, credentials, "
                "token/cookie names, session lifetime. Example: "
                "`POST /login with username=carlos password=hunter2 — cookie sessionid`"
            ),
            "options": [],  # Free text only — user must "Type something"
            "validate": lambda v: isinstance(v, str) and len(v.strip()) > 0,
            "required_when": lambda intake: (intake.get("authenticated_testing") or "") in (
                "both", "authenticated_only"
            ),
        },
    ]

    def _intake_field_meta(self, key: str) -> Optional[dict]:
        """Look up schema metadata for a single intake field, or None."""
        for entry in self._INTAKE_SCHEMA:
            if entry["key"] == key:
                return entry
        return None

    def validate_intake(self) -> tuple[bool, list[str]]:
        """Validate the current intake record.

        Returns:
            (is_valid, missing_field_keys)
            - is_valid: True if all required fields are present and valid
            - missing_field_keys: list of keys that are missing or invalid
        """
        intake = self.state.metadata.get("intake") or {}
        missing: list[str] = []

        for entry in self._INTAKE_SCHEMA:
            key = entry["key"]

            # required_when gate (defaults to always required)
            required_when = entry.get("required_when")
            if callable(required_when) and not required_when(intake):
                continue

            # Field-specific validation (defaults to "non-empty string")
            value = intake.get(key)
            if not isinstance(value, str) or not value.strip():
                missing.append(key)
                continue

            validate = entry.get("validate")
            if callable(validate) and not validate(value):
                missing.append(key)

        return (len(missing) == 0, missing)

    def _build_intake_questions(self, missing: list[str]) -> list[dict]:
        """Build a questionnaire-shaped `questions` list for missing fields.

        Each entry matches the shape expected by the skill extension's
        `escalate_to_user` action: {id, label, prompt, options, allowOther}.
        """
        questions: list[dict] = []
        for key in missing:
            entry = self._intake_field_meta(key)
            if entry is None:
                continue
            questions.append({
                "id": key,
                "label": entry["label"],
                "prompt": entry["prompt"],
                "options": list(entry.get("options") or []),
                "allowOther": True,
            })
        return questions

    # ── Phase Handlers ────────────────────────────────────

    def _intake_directive(self) -> Optional[Directive]:
        """INTAKE: Validate target configuration.

        - If all required fields are present, return None to auto-advance
          to ACQUIRE (handled by _build_action's "phase has no work" branch).
        - If any required fields are missing or invalid, return an
          `escalate` directive carrying a `questions` array. The skill
          extension routes this to Penny via the canonical UNKNOWN_STATE
          escalation protocol — Penny invokes the questionnaire tool
          and feeds the answers back via `step --agent user`.
        """
        is_valid, missing = self.validate_intake()
        if is_valid:
            return None  # Auto-advance to ACQUIRE

        questions = self._build_intake_questions(missing)
        already = sorted(
            set((self.state.metadata.get("intake") or {}).keys()) - set(missing)
        )
        reason = (
            f"INTAKE missing required field(s): {', '.join(missing)}. "
            f"Already collected: {', '.join(already) or '(none)'}."
        )

        return Directive(
            type="escalate",
            phase="INTAKE",
            session_id=self.session_id,
            description=f"INTAKE: collect {len(missing)} missing field(s) from user",
            context={
                "questions": questions,
                "reason": reason,
                "previous_state": "INTAKE",
            },
        )

    def _acquire_directive(self) -> Optional[Directive]:
        """ACQUIRE: Download JS files from target URL (local, curl-based).

        Runs locally because subagents don't have reliable playwright access.
        Downloads external <script src> files and saves homepage HTML.
        """
        if not self.target_url:
            return None

        return Directive(
            type="local",
            phase="ACQUIRE",
            session_id=self.session_id,
            description=f"Download JavaScript files from {self.target_url}",
            context={
                "target_url": self.target_url,
                "output_dir": str(self.state.js_dir),
                "html_dir": str(self.state.html_dir),
            },
        )

    def _cve_research_directive(self) -> Optional[Directive]:
        """CVE_RESEARCH: Detect tech stack + lookup CVEs.

        Runs cve_research_handler locally to:
        1. Detect frameworks/libraries (Wappalyzer + source maps + regex)
        2. Query OSV.dev + Vulnerability-Lookup for CVEs
        3. Write CVE artifacts to disk
        4. Write mempalace stub for {session_id}-cve-research room

        Always returns a local directive — PoC research by echo agents was
        removed (2026-06-25) because the invoke_agents_parallel → step()
        handoff in the skill extension caused infinite loops. CVE data is
        available to downstream phases via state.metadata and disk artifacts.
        """
        # ── Guard: only run handler once ──
        if not self.state.metadata.get("cve_research"):
            cve_research_handler(self.state)
            self._save_state()
            self._write_cve_research_stub()

        cve_meta = self.state.metadata.get("cve_research", {})
        tech_hints = cve_meta.get("tech_stack_hints", {})

        return Directive(
            type="local",
            phase="CVE_RESEARCH",
            session_id=self.session_id,
            description=(
                f"Detect technology stack from downloaded JS files"
                + (f" — found: {list(tech_hints.keys())}" if tech_hints else " — none detected")
            ),
            context={
                "tech_detected": len(tech_hints) > 0,
                "tech_count": len(tech_hints),
            },
        )

    def _sast_scan_directive(self) -> Optional[Directive]:
        """SAST_SCAN: Run semgrep + jsluice on acquired JS files."""
        return Directive(
            type="tool",
            phase="SAST_SCAN",
            session_id=self.session_id,
            description="Run semgrep and jsluice on downloaded JavaScript files",
            tool="semgrep_scan",
            tool_params={
                "target": str(self.state.js_dir),
                "preset": "jsa",
                "config": "jsa",
                "output_room": f"{self.session_id}-sast-findings",
            },
            output_room=f"{self.session_id}-sast-findings",
            context={
                "js_dir": str(self.state.js_dir),
                "jsluice_tool": "jsluice_secrets",
            },
        )

    def _normalize_directive(self) -> Optional[Directive]:
        """NORMALIZE: Normalize components and vulnerabilities (first DEDUP sub-phase)."""
        return Directive(
            type="local",
            phase="NORMALIZE",
            session_id=self.session_id,
            description="Normalize library findings (purl) and canonicalize CVE aliases",
            context={
                "action": "component_norm + vuln_canonical",
            },
        )

    def _dedup_within_source_directive(self) -> Optional[Directive]:
        """DEDUP_WITHIN_SOURCE: Deduplicate SAST findings within each scanner source."""
        return Directive(
            type="local",
            phase="DEDUP_WITHIN_SOURCE",
            session_id=self.session_id,
            description="Deduplicate SAST findings from semgrep and jsluice by fingerprint",
            context={
                "sast_count": len(self.state.sast_findings),
            },
        )

    def _correlate_evidence_directive(self) -> Optional[Directive]:
        """CORRELATE_EVIDENCE: Cross-stream correlation via typed edges."""
        return Directive(
            type="local",
            phase="CORRELATE_EVIDENCE",
            session_id=self.session_id,
            description="Correlate components to vulnerabilities and SAST findings via typed edges",
            context={
                "components": len(self.state.metadata.get("dedup", {}).get("components", [])),
                "vulnerabilities": len(self.state.metadata.get("dedup", {}).get("vulnerabilities", [])),
                "sast_findings": len(self.state.sast_findings),
            },
        )

    def _agent_review_directive(self) -> Optional[Directive]:
        """AGENT_REVIEW: Agent reviewer on bounded evidence packets (Priority 10)."""
        return Directive(
            type="local",
            phase="AGENT_REVIEW",
            session_id=self.session_id,
            description="Review ambiguous correlation edges via bounded evidence packets",
            context={
                "candidate_count": len(self.state.metadata.get("dedup", {}).get("agent_candidates", [])),
                "total_edges": len(self.state.metadata.get("dedup", {}).get("edges", [])),
            },
        )

    def _dedup_directive(self) -> Optional[Directive]:
        """DEDUP: Backward-compat wrapper — runs all three sub-phases."""
        return Directive(
            type="local",
            phase="DEDUP",
            session_id=self.session_id,
            description="Deduplicate SAST findings (backward-compat wrapper: NORMALIZE + DEDUP_WITHIN_SOURCE + CORRELATE_EVIDENCE)",
            context={
                "sast_count": len(self.state.sast_findings),
            },
        )

    def _sast_validate_directive(self) -> Optional[Directive]:
        """SAST_VALIDATE: Classify SAST findings via local heuristic.

        Runs sast_validate_handler locally to classify each finding as
        confirmed, false_positive, or needs_deeper. Previously dispatched
        annie as an agent (caused 24hr timeouts when mempalace stubs weren't
        pushed). Now uses the same local-handler pattern as CVE_RESEARCH.
        """
        from fsm import sast_validate_handler
        sast_validate_handler(self.state)
        self._save_state()

        vmeta = self.state.metadata.get("sast_validate", {})
        return Directive(
            type="local",
            phase="SAST_VALIDATE",
            session_id=self.session_id,
            description=(
                f"Classify {vmeta.get('total', 0)} SAST findings: "
                f"{vmeta.get('confirmed', 0)} confirmed, "
                f"{vmeta.get('false_positive', 0)} false positive, "
                f"{vmeta.get('needs_deeper', 0)} needs deeper"
            ),
            context={
                "total": vmeta.get("total", 0),
                "confirmed": vmeta.get("confirmed", 0),
                "false_positive": vmeta.get("false_positive", 0),
                "needs_deeper": vmeta.get("needs_deeper", 0),
            },
        )

    def _structure_directive(self) -> Optional[Directive]:
        """STRUCTURE: Build typed analysis store and emit PageCard/ModuleCard.

        Phase B: stub. Phase C will implement the full builder.
        """
        return Directive(
            type="local",
            phase="STRUCTURE",
            session_id=self.session_id,
            description="Build typed analysis store and emit PageCard/ModuleCard",
            context={
                "output_dir": self.output_dir,
                "phase_status": "stub_phase_b",
            },
        )

    def _slice_directive(self) -> Optional[Directive]:
        """SLICE: Per-class candidate generation + vulnerability-specific slicing.

        Phase B: stub. Phase C will implement the full candidate generation.
        """
        return Directive(
            type="local",
            phase="SLICE",
            session_id=self.session_id,
            description="Per-class candidate generation + slice extraction (Joern + correlation)",
            context={
                "output_dir": self.output_dir,
                "phase_status": "stub_phase_b",
            },
        )

    def _stop_directive(self) -> Optional[Directive]:
        """STOP: Pause after INVESTIGATE for end-to-end inspection before COLLECT.

        Position (Phase E+, 2026-06): STOP moved from between SAST_VALIDATE and
        STRUCTURE to immediately after INVESTIGATE (Phase 12). This enables
        full end-to-end testing of all phases up through the F3 hybrid
        (Python+LLM) verification layer.
        """
        intake = self.state.metadata.get("intake", {})
        target = intake.get("target_url", self.target_url or "(not set)")

        # INVESTIGATE stats
        inv = self.state.metadata.get("investigate_plan", {})
        total_agents = inv.get("total_agents", 0)
        total_waves = inv.get("total_waves", 0)
        lanes = inv.get("lanes", {})

        # F3 hybrid verification stats
        pv = self.state.metadata.get("python_verification", {})
        findings_produced = pv.get("findings_produced", 0)
        needs_llm = pv.get("needs_llm_verify", 0)
        confidence_dist = pv.get("confidence_distribution", {})

        # Card counts
        n_module_cards = len(self.state.module_cards)
        n_page_cards = len(self.state.page_cards)
        n_flow_cards = len(self.state.flow_cards)
        n_raw_findings = len(self.state.raw_findings)

        # Build confidence distribution string
        conf_summary = ", ".join(
            f"{level}={count}" for level, count in confidence_dist.items()
        ) if confidence_dist else "  (no findings)"

        return Directive(
            type="escalate",
            phase="STOP",
            session_id=self.session_id,
            description="Inspect INVESTIGATE results before COLLECT",
            context={
                "title": "INVESTIGATE Complete (Phase 12) — Proceed to COLLECT?",
                "message": (
                    f"Deep analysis pass complete. Full F3 hybrid (Python+LLM) executed.\n\n"
                    f"**Session:** {self.session_id}\n"
                    f"**Target URL:** {target}\n"
                    f"**Output:** {self.output_dir}\n"
                    f"**Cards produced by STRUCTURE/SLICE:**\n"
                    f"  - ModuleCards: {n_module_cards}\n"
                    f"  - PageCards: {n_page_cards}\n"
                    f"  - FlowCards: {n_flow_cards}\n"
                    f"**INVESTIGATE plan:**\n"
                    f"  - Total work items: {total_agents}\n"
                    f"  - Total waves: {total_waves}\n"
                    f"  - Per-lane: code_static={lanes.get('code_static', 0)}, "
                    f"page_dom={lanes.get('page_dom', 0)}, "
                    f"network_behavior={lanes.get('network_behavior', 0)}\n"
                    f"**F3 Hybrid Verification (Python + LLM):**\n"
                    f"  - Python findings: {findings_produced}\n"
                    f"  - Need LLM verify: {needs_llm}\n"
                    f"  - Confidence: {conf_summary}\n"
                    f"  - Raw findings on state: {n_raw_findings}\n"
                    f"\nInspect state then choose:\n"
                    f"- **Continue** → proceeds to COLLECT\n"
                    f"- **Stop** → ends the pipeline here"
                ),
                "questions": [
                    {
                        "type": "single",
                        "id": "stop_decision",
                        "prompt": "Proceed to COLLECT?",
                        "options": [
                            {"value": "continue", "label": "Continue to COLLECT"},
                            {"value": "stop", "label": "Stop here — inspect first"},
                        ],
                    },
                ],
            },
        )

    def _investigate_directive(self) -> Optional[Directive]:
        """INVESTIGATE: Wave-based F3 hybrid with Python verification + annie subagent.

        Two-stage per-wave:
        1. PythonVerifier (local, deterministic, runs ONCE on first wave only)
           - assess exploitability, compute confidence scores
           - split findings into waves of WAVE_SIZE
        2. Single annie subagent per wave
           - receives this wave's findings + reference catalogs + high-confidence summary
           - uses Pi tools (semgrep, playwright, grep, read) to verify
           - also does a "general sweep" of files in this batch for novel patterns

        Wave loop:
          wave 0  -> PythonVerifier runs -> annie verifies findings 0-9
          wave 1  -> annie verifies findings 10-19
          ...
          wave N  -> all waves done -> advance to STOP

        Checkpoint: state.metadata["investigate_wave"] tracks progress.
        If crash at wave 3, at most WAVE_SIZE = 10 findings lost.
        """
        WAVE_SIZE = 10
        prompts_dir = Path(__file__).parent.parent / "assets" / "prompts"
        refs_dir = prompts_dir.parent / "assets" / "references"
        
        # Step 1: Run Python verification (idempotent - skips if already run)
        if not self.state.metadata.get("investigate_started"):
            from fsm import investigate_handler as _run_investigate
            _run_investigate(self.state)
            self._save_state()
        
        n_flow_cards = len(self.state.flow_cards)
        n_page_cards = len(self.state.page_cards)
        n_analyzers = len(self.state.analyzers)
        
        if n_analyzers == 0 and n_flow_cards == 0 and n_page_cards == 0:
            return None
        
        # Pull investigation data
        pv = self.state.metadata.get("python_verification", {})
        findings_produced = pv.get("findings_produced", 0)
        confidence_dist = pv.get("confidence_distribution", {})
        results_data = pv.get("verification_results", []) or []
        
        # Split findings into needs_llm and high_confidence
        needs_llm = [r for r in results_data if r.get("needs_llm_verify")]
        high_confidence = [r for r in results_data if r["confidence_level"] in ("high", "confirmed")]
        
        # Compute wave info
        total_to_verify = len(needs_llm)
        total_waves = max(1, (total_to_verify + WAVE_SIZE - 1) // WAVE_SIZE)
        wave_current = self.state.metadata.get("investigate_wave", 0)
        
        # Store total waves for loop detection in step()
        self.state.metadata["investigate_total_waves"] = total_waves
        
        # If all waves done, or no LLM verification needed, advance to STOP.
        if wave_current >= total_waves or total_to_verify == 0:
            self.state.metadata["investigate_wave"] = 0
            self.state.metadata["investigate_total_waves"] = 0
            return None
        
        # Get this wave's findings
        wave_start = wave_current * WAVE_SIZE
        wave_end = min(wave_start + WAVE_SIZE, total_to_verify)
        this_wave = needs_llm[wave_start:wave_end]
        
        # Build unique files for general sweep (one per wave to avoid duplication)
        files_covered = self.state.metadata.get("investigate_files_covered", [])
        js_dir = self.state.js_dir
        html_dir = self.state.html_dir
        all_js_files = sorted([f.name for f in js_dir.glob("*.js")]) if js_dir.exists() else []
        all_html_files = sorted([f.name for f in html_dir.glob("*.html")]) if html_dir.exists() else []
        remaining_files = [f for f in all_js_files if f not in files_covered]
        sweep_files = remaining_files[:3]  # 3 JS files per wave
        # Also sweep HTML pages the agent hasn't seen yet
        remaining_html = [f for f in all_html_files if f"html:{f}" not in files_covered]
        if remaining_html:
            # Add the first 2 HTML pages to this wave's sweep
            sweep_html = remaining_html[:2]
            files_covered.extend([f"html:{f}" for f in sweep_html])
        else:
            sweep_html = []
        # Mark scanned JS files as covered
        files_covered.extend(sweep_files)
        self.state.metadata["investigate_files_covered"] = files_covered
        
        # Build the inline index (discovered pages with forms/APIs)
        acquire_meta = self.state.metadata.get("acquire", {})
        inline_index_content = acquire_meta.get("inline_index_content", "")
        discovered_pages = []
        if inline_index_content:
            try:
                idx = json.loads(inline_index_content)
                discovered_pages = idx.get("entries", [])
            except (json.JSONDecodeError, TypeError):
                pass
        
        # Build conf summary
        conf_summary = ", ".join(
            f"{level}={count}" for level, count in confidence_dist.items()
        ) if confidence_dist else "none"
        
        # Start building task
        task_parts = [
            f"You are investigating a security target. Wave {wave_current + 1}/{total_waves}.",
            "",
            f"=== HIGH CONFIDENCE ({len(high_confidence)} total) ===",
            "These are already confirmed by Python analysis. Skip unless you find evidence",
            "they are false positives. Listed here for your awareness:",
            "",
        ]
        for r in high_confidence[:10]:
            task_parts.append(
                f"- {r['vuln_class']} (score={r['confidence_score']:.2f}, verdict={r['python_verdict']})"
            )
        if len(high_confidence) > 10:
            task_parts.append(f"- ... and {len(high_confidence) - 10} more (see full results)")
        task_parts.append("")
        
        # Load reference catalogs for this wave's vuln classes
        vuln_classes_in_wave = set(r["vuln_class"] for r in this_wave)
        task_parts.append(f"=== THIS WAVE: {len(this_wave)} findings ===")
        for ref_class in sorted(vuln_classes_in_wave):
            ref_path = refs_dir / f"{ref_class}.md"
            if ref_path.exists():
                ref_text = ref_path.read_text()[:3000]
                task_parts.append(f"--- {ref_class} Reference ---")
                task_parts.append(ref_text)
                task_parts.append("")
        
        # List this wave's findings with detailed context
        task_parts.append("=== Findings to Verify ===")
        task_parts.append(f"Wave {wave_current + 1}/{total_waves}. For EACH finding:")
        task_parts.append("1. Read the relevant source file from the assets/js/ directory")
        task_parts.append("2. Run semgrep on the relevant file if needed")
        task_parts.append("3. Use playwright to test if the finding is exploitable")
        task_parts.append("4. Post your verdict to wing_jsa/{self.session_id}-findings")
        task_parts.append("")
        for i, r in enumerate(this_wave):
            task_parts.append(
                f"{wave_start + i + 1}. [{r['vuln_class']}] score={r['confidence_score']:.2f} "
                f"verdict={r['python_verdict']} "
                f"{'DEEP ANALYSIS NEEDED' if r.get('needs_llm_deep') else ''}"
            )
            # Add finding detail if available
            if "source" in r:
                task_parts.append(f"   Source: {r['source']}")
            if "sink" in r:
                task_parts.append(f"   Sink: {r['sink']}")
        task_parts.append("")
        
        # General sweep for novel discovery — includes JS files AND HTML pages
        if sweep_files or sweep_html:
            task_parts.append(f"=== GENERAL SWEEP ===")
            task_parts.append("After verifying the findings above, also review these files for")
            task_parts.append("patterns SAST may have missed (novel patterns, multi-step chains,")
            task_parts.append("framework-specific bypasses, business logic flaws):")
            task_parts.append("")
            if sweep_files:
                task_parts.append("JS files:")
                for f in sweep_files:
                    task_parts.append(f"- assets/js/{f}")
                task_parts.append("")
            if sweep_html:
                task_parts.append("HTML pages:")
                for f in sweep_html:
                    task_parts.append(f"- assets/html/{f}")
                task_parts.append("")
            task_parts.append("For each JS file, consider:")
            task_parts.append("- Read the file using read/grep")
            task_parts.append("- Run semgrep on it for ad-hoc rules")
            task_parts.append("- Check for logic flaws and authentication issues")
            task_parts.append("")
            task_parts.append("For each HTML page:")
            task_parts.append("- Read the page structure using read")
            task_parts.append("- Identify ALL forms, their action endpoints, input fields")
            task_parts.append("- Check for CSRF tokens (hidden inputs named csrf, token, etc.)")
            task_parts.append("- Check for X-Frame-Options / CSP in meta tags")
            task_parts.append("- Identify API endpoints called from the page")
            task_parts.append("- Map form actions to endpoints for server-side probing")
            task_parts.append("- Post findings to wing_jsa/{self.session_id}-findings")
            task_parts.append("")
        
        # Web architecture summary
        endpoints = self.state.metadata.get("endpoints", [])
        task_parts.append("=== DISCOVERED WEB ARCHITECTURE ===")
        task_parts.append(f"HTML pages on disk: {len(all_html_files)}")
        task_parts.append(f"JS files on disk: {len(all_js_files)}")
        task_parts.append(f"API endpoints from jsluice: {len(endpoints)}")
        task_parts.append("")
        if discovered_pages:
            task_parts.append("--- Discovered Pages ---")
            for page in discovered_pages:
                url = page.get("html_url", "")
                forms = page.get("forms", [])
                apis = page.get("api_calls", [])
                scripts = page.get("external_scripts", [])
                task_parts.append(f"- {url}")
                if forms:
                    for f in forms[:3]:
                        task_parts.append(f"    form action: {f}")
                if apis:
                    task_parts.append(f"    APIs: {', '.join(apis[:5])}")
                task_parts.append(f"    scripts: {len(scripts)}")
            task_parts.append("")
        
        # Sources summary for context
        task_parts.append("=== SOURCE FILES ===")
        for f in all_js_files[:20]:
            task_parts.append(f"- assets/js/{f}")
        if len(all_js_files) > 20:
            task_parts.append(f"- ... and {len(all_js_files) - 20} more")
        task_parts.append("")
        
        # Stats footer
        task_parts.append(f"---")
        task_parts.append(f"Total findings: {findings_produced}")
        task_parts.append(f"Confidence: {conf_summary}")
        task_parts.append(f"JS files on disk: {len(all_js_files)}")
        task_parts.append(f"Output dir: {self.output_dir}")
        task_parts.append(f"Session: {self.session_id}")
        
        task_text = "\n".join(task_parts)
        
        # Increment wave counter
        self.state.metadata["investigate_wave"] = wave_current + 1
        self._save_state()
        
        return Directive(
            type="agent",
            phase="INVESTIGATE",
            session_id=self.session_id,
            description=(
                f"F3 hybrid investigation: wave {wave_current + 1}/{total_waves} "
                f"({len(this_wave)} findings, "
                f"{len(high_confidence)} high-confidence, "
                f"{len(sweep_files)} files for general sweep)"
            ),
            agent="annie",
            model="qwen3.6:27b-coder",
            task=task_text,
            output_room=f"{self.session_id}-findings",
            context={
                "flow_cards_count": n_flow_cards,
                "page_cards_count": n_page_cards,
                "analyzers": self.state.analyzers,
                "wave_current": wave_current,
                "wave_total": total_waves,
                "findings_in_wave": len(this_wave),
                "high_confidence_count": len(high_confidence),
                "files_for_sweep": sweep_files,
            },
        )

    def _collect_directive(self) -> Optional[Directive]:
        """COLLECT: Gather findings from MemPalace."""
        return Directive(
            type="local",
            phase="COLLECT",
            session_id=self.session_id,
            description="Collect all findings from MemPalace for deduplication and merging",
            context={
                "source_room": f"{self.session_id}-findings",
                "target": "raw_findings in state",
            },
        )

    def _merge_directive(self) -> Optional[Directive]:
        """MERGE: Deduplicate and merge findings."""
        raw_count = len(self.state.raw_findings)

        return Directive(
            type="agent",
            phase="MERGE",
            session_id=self.session_id,
            description=f"Deduplicate and merge {raw_count} raw findings into consolidated findings",
            agent="synthia",
            task=(
                f"Deduplicate and merge {raw_count} raw findings from MemPalace room: {self.session_id}-findings. "
                "Group similar findings from different chunks. Stitch cross-chunk findings. "
                "Promote confidence for corroborated findings. Resolve conflicts. "
                f"Post merged findings to MemPalace room: {self.session_id}-merged"
            ),
            output_room=f"{self.session_id}-merged",
            context={"raw_finding_count": raw_count},
        )

    def _verify_directive(self) -> Optional[Directive]:
        """VERIFY: Browser-based PoC verification."""
        # Surface effective scope so vera knows which URLs are off-limits.
        effective_scope = self.constraints.get("out_of_scope", [])
        scope_bullets = (
            "\n".join(f"- `{p}`" for p in effective_scope)
            if effective_scope
            else "  (none configured — all reachable URLs on target host are in scope)"
        )
        scope_block = (
            "\n\n**SCOPE (HARD CONSTRAINT):**\n"
            f"The following URL substrings are OUT OF SCOPE. You must NOT navigate to, "
            f"fetch, or otherwise interact with these URLs during PoC verification. "
            f"Substring match is used for enforcement.\n\n"
            f"{scope_bullets}\n\n"
            f"If a finding's verification would require out-of-scope interaction, mark the "
            f"finding as `verification_status: out_of_scope` and skip the PoC.\n"
        )
        return Directive(
            type="agent",
            phase="VERIFY",
            session_id=self.session_id,
            description="Verify findings with browser-based proof-of-concept testing",
            agent="vera",
            task=(
                f"For each merged finding in MemPalace room: {self.session_id}-merged, "
                "perform browser-based verification. Navigate to the target page, "
                "inject payloads, test bypass variants, capture screenshots. "
                "Confirm or refute each finding. "
                f"Post verification results to MemPalace room: {self.session_id}-verified"
                f"{scope_block}"
            ),
            output_room=f"{self.session_id}-verified",
            context={
                "target_url": self.target_url,
                "out_of_scope": list(effective_scope),
            },
        )

    def _report_directive(self) -> Optional[Directive]:
        """REPORT: Write structured finding reports."""
        return Directive(
            type="agent",
            phase="REPORT",
            session_id=self.session_id,
            description="Write structured vulnerability reports for each verified finding",
            agent="skribble",
            task=(
                f"For each verified finding in MemPalace room: {self.session_id}-verified, "
                "write a structured vulnerability report with: "
                "title, description, steps to reproduce, code analysis, "
                "remediation guidance, CVSS 4.0 vector. "
                "Save each report as report.md in the finding's directory. "
                "Also generate a consolidated report.md at the output root. "
                f"Output directory: {self.output_dir}/findings/"
            ),
            output_room=f"{self.session_id}-reports",
            context={
                "output_dir": self.output_dir,
                "findings_dir": str(self.state.findings_dir),
            },
        )

    def _reflect_directive(self) -> Optional[Directive]:
        """REFLECT: Identify FP/FN patterns for self-improvement."""
        return Directive(
            type="agent",
            phase="REFLECT",
            session_id=self.session_id,
            description="Identify false positive/negative patterns and record lessons learned",
            agent="carren",
            task=(
                "Review the full jsa pipeline results. Identify patterns in false positives "
                "and false negatives. What did SAST miss that annie found? What did annie miss "
                "that vera caught? Write pattern corrections for future analysis. "
                "Post learnings to MemPalace room: jsa-learnings"
            ),
            output_room="jsa-learnings",
            context={
                "session_id": self.session_id,
                "raw_count": len(self.state.raw_findings),
                "merged_count": len(self.state.merged_findings),
                "verified_count": len(self.state.verified_findings),
            },
        )


# ============================================================
# CLI Entry Point
# ============================================================

def main() -> None:
    """CLI entry point - outputs minimal JSON action to stdout."""
    parser = argparse.ArgumentParser(description="jsa skill orchestrator")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # START command
    start_parser = subparsers.add_parser("start", help="Start the jsa pipeline")
    start_parser.add_argument("--session-id", required=True)
    start_parser.add_argument("--goal", required=True)
    start_parser.add_argument("--project-root", default=".")
    start_parser.add_argument("--constraints", default="{}")

    # STEP command
    step_parser = subparsers.add_parser("step", help="Process agent result and get next action")
    step_parser.add_argument("--session-id", required=True)
    step_parser.add_argument("--project-root", default=".")
    step_parser.add_argument("--agent", required=True)
    step_parser.add_argument("--result", required=True)
    step_parser.add_argument("--state", required=True)

    # STATUS command
    status_parser = subparsers.add_parser("status", help="Get current session status")
    status_parser.add_argument("--session-id", required=True)
    status_parser.add_argument("--project-root", default=".")
    status_parser.add_argument("--state", default="{}")

    args = parser.parse_args()

    if args.command == "start":
        try:
            constraints = json.loads(args.constraints)
        except json.JSONDecodeError:
            constraints = {}
        orchestrator = JSAPipelineOrchestrator(
            session_id=args.session_id,
            goal=args.goal,
            project_root=args.project_root,
            constraints=constraints,
        )
        action = orchestrator.start()

    elif args.command == "step":
        try:
            result_data = json.loads(args.result)
        except json.JSONDecodeError:
            result_data = {"exitCode": 1, "error": "Invalid result JSON"}

        try:
            state_data = json.loads(args.state)
        except json.JSONDecodeError:
            action = {"action": "error", "errors": ["Invalid state JSON"]}
            print(json.dumps(action, default=str))
            return

        goal = state_data.get("context", {}).get("goal", "")
        ctx_constraints = state_data.get("context", {}).get("constraints", {})

        orchestrator = JSAPipelineOrchestrator(
            session_id=args.session_id,
            goal=goal,
            project_root=args.project_root,
            constraints=ctx_constraints,
        )
        orchestrator.restore_state(state_data)
        try:
            action = orchestrator.step(args.agent, result_data)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            action = {
                "action": "error",
                "session_id": args.session_id,
                "state_id": state_data.get("current_phase", "unknown"),
                "errors": [f"Step failed: {e}"],
                "orchestrator_state": state_data,
            }

    elif args.command == "status":
        try:
            state_data = json.loads(args.state)
        except json.JSONDecodeError:
            action = {"action": "status", "session_id": args.session_id, "phase": "invalid_state"}
            print(json.dumps(action, default=str))
            return

        action = {
            "action": "status",
            "session_id": args.session_id,
            "phase": state_data.get("current_phase", "unknown"),
            "complete": state_data.get("current_phase") == "COMPLETED",
        }

    else:
        action = {"action": "error", "errors": [f"Unknown command: {args.command}"]}

    print(json.dumps(action, default=str))


# ── Mempalace stub helper (public API) ────────────────────────────────────

def apply_mempalace_stubs(output_dir: str) -> list[dict]:
    """Read mempalace_stubs.json and return a list of memory_add_drawer calls.

    The jsa skill runs in Python (orchestrate.py) which can't call the
    memory_add_drawer MCP tool directly. Instead, it accumulates a list of
    drawer entries in {output_dir}/mempalace_stubs.json as SAST_SCAN and
    CVE_RESEARCH complete. This function reads that file and returns the
    list of calls that should be made (by Penny, an agent, or the skill
    extension's resume path).

    Each entry in the returned list has the shape:
        {"wing": str, "room": str, "content": str, "added_by": str, "added_at": str}

    Usage:
        stubs = apply_mempalace_stubs("/tmp/gin-and-juice-test")
        for s in stubs:
            memory_add_drawer(wing=s["wing"], room=s["room"], content=s["content"])
    """
    stubs_path = Path(output_dir) / "mempalace_stubs.json"
    if not stubs_path.exists():
        return []
    try:
        return json.loads(stubs_path.read_text())
    except (json.JSONDecodeError, OSError):
        return []


if __name__ == "__main__":
    main()
