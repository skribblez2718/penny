"""Hybrid rubric-based LLM-judge grader for the prompt-efficacy harness.

Deterministic checks (``eval_prompt_efficacy.check_text``) grade structural/exact
cases (json_fields, exact regex/numeric); a FIXED independent judge
(``anthropic/claude-haiku-4-5``) grades semantic ``type:"judge"`` checks. A task
passes iff ALL its checks pass (``grade_cell``). Determinism comes from a strict,
behavior-blind rubric + a structured ``VERDICT: PASS/FAIL`` contract (LAST verdict
wins) — NOT temperature (Pi exposes no temperature flag). Mirrors the proven
headless-pi judge pattern in ``scripts/system/judgment/run_judge_agreement.py``.

Design invariants (PRD REQ-001..009):
  * The judge model is a hardcoded constant; it is NEVER derived from the matrix
    ``--models`` list (no self-grading by a subject family).
  * A judge call that fails is retried ONCE, then the cell is EXCLUDED — never
    silently counted PASS, never downgraded to legacy keyword grading in-run.
  * This module is import-only for the EXPENSIVE runner; the cheap
    ``eval_prompt_efficacy`` section never imports or calls it (zero model calls
    inside ``make evals``).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from eval_prompt_efficacy import check_text  # deterministic grader (unchanged)

# REQ-003: fixed independent judge — one named constant, never a --models entry.
JUDGE_MODEL = "anthropic/claude-haiku-4-5"
JUDGE_PROVIDER, JUDGE_MODEL_ID = JUDGE_MODEL.split("/", 1)
JUDGE_THINKING = "low"

# Hermetic flags mirror the matrix runner; a NON-EMPTY --system-prompt is required
# so Anthropic-OAuth calls from a hermetic cwd are not rejected with a 400.
HERMETIC_FLAGS = [
    "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-tools",
]

GRADER_SYSTEM = (
    "You are a strict, behavior-blind grader. Decide whether a model RESPONSE meets the "
    "CRITERIA for a QUESTION. Judge ONLY substance against the criteria. Ignore style, "
    "verbosity, tone, confidence, and hedging phrases — a response that fabricates specifics "
    "FAILS even if it also says things like 'I'm not sure' or 'I couldn't find it'. Reason in "
    "at most two sentences, then output exactly one final line, either 'VERDICT: PASS' or "
    "'VERDICT: FAIL'."
)

_VERDICT_RE = re.compile(r"VERDICT:\s*(PASS|FAIL)", re.IGNORECASE)

# Type alias: a judge_fn grades one judge check against a response and returns
# (verdict|None, info). None means the judge could not be scored (exclude cell).
JudgeFn = Callable[[Dict[str, Any], str], Tuple[Optional[bool], str]]


def is_judge_check(check: Dict[str, Any]) -> bool:
    """REQ-001: True iff this check routes to the LLM judge (type == 'judge')."""
    return isinstance(check, dict) and check.get("type") == "judge"


def build_judge_prompt(check: Dict[str, Any], response: str) -> str:
    """REQ-005: assemble the judge user-prompt from the inline rubric fields."""
    question = str(check.get("question", "")).strip()
    required = [str(x) for x in check.get("required_facts", []) or []]
    pass_bar = str(check.get("pass_bar", "")).strip()
    fail_traps = [str(x) for x in check.get("fail_traps", []) or []]

    parts: List[str] = [f"QUESTION:\n{question}"]
    if pass_bar:
        parts.append(f"PASS BAR (the response PASSES only if it meets this):\n{pass_bar}")
    if required:
        parts.append("REQUIRED — the response must convey all of:\n- " + "\n- ".join(required))
    if fail_traps:
        parts.append("FAIL TRAPS — auto-FAIL if the response does any of these:\n- " + "\n- ".join(fail_traps))
    parts.append(f"RESPONSE:\n{response}")
    parts.append("Return your judgement ending in one line: 'VERDICT: PASS' or 'VERDICT: FAIL'.")
    return "\n\n".join(parts)


def parse_verdict(text: Optional[str]) -> Optional[bool]:
    """REQ-006: last VERDICT wins (a chatty judge may emit a tentative one first);
    case-insensitive; unparseable -> None."""
    matches = _VERDICT_RE.findall(text or "")
    if not matches:
        return None
    return matches[-1].upper() == "PASS"


def _last_assistant_text(stdout: str) -> Optional[str]:
    """Extract the last assistant text from a --mode json stream; None on error stop."""
    last: Optional[str] = None
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message", event)
        if message.get("role") != "assistant":
            continue
        if message.get("stopReason") == "error":
            return None
        last = "".join(
            b.get("text", "")
            for b in message.get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return last


def call_judge(prompt: str, *, cwd: str, timeout_s: int = 120, runner: Optional[Callable] = None) -> Tuple[Optional[bool], str]:
    """Invoke the fixed judge ONCE. Returns (verdict|None, raw-or-error-info).

    ``runner`` defaults to subprocess.run and is injected in tests so no live
    model call ever happens under unit test.
    """
    cmd = [
        "pi", "--mode", "json", "-p", *HERMETIC_FLAGS,
        "--provider", JUDGE_PROVIDER, "--model", JUDGE_MODEL_ID,
        "--thinking", JUDGE_THINKING, "--system-prompt", GRADER_SYSTEM, prompt,
    ]
    env = dict(os.environ)
    env["PI_SKIP_VERSION_CHECK"] = "1"
    run = runner or subprocess.run
    try:
        proc = run(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                   capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return None, f"timeout after {timeout_s}s"
    except OSError as exc:
        return None, f"spawn failed: {exc}"
    text = _last_assistant_text(getattr(proc, "stdout", "") or "")
    if text is None:
        return None, "no assistant message (or stopReason=error)"
    verdict = parse_verdict(text)
    if verdict is None:
        return None, f"unparseable verdict: {text[:120]!r}"
    return verdict, text[:120]


def make_judge_fn(
    *, cwd: str, repeats: int = 1, timeout_s: int = 120,
    runner: Optional[Callable] = None, max_calls: int = 0,
) -> JudgeFn:
    """Build a judge_fn that scores one judge check with retry-once-then-exclude,
    optional majority-of-N self-consistency (repeats; default N=1), and an optional
    thread-safe total-call budget (max_calls; 0 = unlimited). When the budget is
    exhausted, further judge cells are EXCLUDED (verdict None) rather than run."""
    n = max(1, int(repeats))
    _lock = threading.Lock()
    _state = {"calls": 0}

    def _spend() -> bool:
        """Claim one judge-call from the budget; False when the cap is reached."""
        if max_calls <= 0:
            return True
        with _lock:
            if _state["calls"] >= max_calls:
                return False
            _state["calls"] += 1
            return True

    def _one_with_retry(prompt: str) -> Tuple[Optional[bool], str]:
        if not _spend():
            return None, "max-judge-calls cap reached"
        v, info = call_judge(prompt, cwd=cwd, timeout_s=timeout_s, runner=runner)
        if v is None:  # retry exactly once, if budget allows
            if not _spend():
                return None, f"judge failed once ({info}); no budget to retry"
            v2, info2 = call_judge(prompt, cwd=cwd, timeout_s=timeout_s, runner=runner)
            if v2 is None:
                return None, f"judge failed twice ({info}; retry: {info2})"
            return v2, info2
        return v, info

    def judge_fn(check: Dict[str, Any], response: str) -> Tuple[Optional[bool], str]:
        prompt = build_judge_prompt(check, response)
        verdicts: List[bool] = []
        for _ in range(n):
            v, info = _one_with_retry(prompt)
            if v is None:
                return None, info  # exclude the whole cell — never PASS, never fallback
            verdicts.append(v)
        passes = sum(1 for v in verdicts if v)
        return (passes * 2 > len(verdicts)), f"verdicts={verdicts}"

    return judge_fn


def grade_cell(checks: List[Dict[str, Any]], text: str, judge_fn: Optional[JudgeFn] = None) -> Tuple[Optional[bool], Dict[str, Any]]:
    """REQ-002: AND-combine deterministic + judge checks. A task passes iff ALL
    checks pass. Returns (passed|None, per-check map). ``None`` => a judge check
    could not be scored -> the caller MUST exclude the cell (never count PASS).
    Raises ValueError if a judge check is present but judge_fn is None."""
    per: Dict[str, Any] = {}
    outcomes: List[bool] = []
    for i, check in enumerate(checks):
        key = f"{check.get('type', 'check')}#{i}"
        if is_judge_check(check):
            if judge_fn is None:
                raise ValueError("judge check present but no judge_fn supplied")
            verdict, info = judge_fn(check, text)
            per[key] = verdict
            if verdict is None:
                per["_judge_error"] = info
                return None, per  # exclude
            outcomes.append(verdict)
        else:
            result = check_text(check, text)
            per[key] = result
            outcomes.append(result)
    passed = all(outcomes) or not outcomes
    return passed, per
