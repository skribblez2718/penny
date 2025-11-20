"""
Claude Code — UserPromptSubmit hook (multi‑suffix helper)
========================================================

Behavior
--------

- Reads a JSON object from ``stdin``. The payload includes common hook fields and,
  for ``UserPromptSubmit``, a ``"prompt"`` string.
- If the submitted prompt (after trimming trailing whitespace) ends with one of
  the following suffixes, the hook prints the corresponding instruction block
  to ``stdout`` and exits with code ``0`` so the text is injected as additional
  context for Claude:

  * ``-el`` → error‑log explanation helper
  * ``-t``  → general *think* helper
  * ``-th`` → *think harder* helper
  * ``-ut`` → *ultra think* helper

Why exit 0 with stdout?
-----------------------

Per Claude Code's hook contract, for the *UserPromptSubmit* event, any text
written to ``stdout`` **with exit code 0** is injected as additional context
for Claude. Errors printed to ``stderr`` with exit code ``1`` are non‑blocking.
Exit code ``2`` would block prompt processing and show ``stderr`` to the user.

This hook intentionally:

- uses exit code ``0`` when a suffix matches (to add context); and
- uses exit code ``1`` on unexpected exceptions (non‑blocking).

Notes
-----

- This script does not modify or remove the trailing suffix from the user's prompt.
  However, it adds an explicit instruction for Claude to ignore the suffix completely.
  Claude will receive both the original prompt and a directive to treat the suffix as invisible.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, Iterable, Optional, TextIO, TypedDict, cast


#########################[ start HookInput ]###################################
class HookInput(TypedDict, total=False):
    """
    Typed view of the JSON object Claude Code passes to hooks.

    Optional keys are documented by Claude Code and may not be present for all
    invocations.
    """

    session_id: str
    transcript_path: str
    cwd: str
    permission_mode: str
    hook_event_name: str
    prompt: str


#########################[ end HookInput ]#####################################


#########################[ start constants ]###################################
# Suffix constants.
SUFFIX_ERROR_LOG: str = "-el"
SUFFIX_THINK: str = "-t"
SUFFIX_THINK_HARD: str = "-th"
SUFFIX_THINK_HARDER: str = "-tr"
SUFFIX_ULTRA_THINK: str = "-ut"

SUFFIX_UNIVERSAL: str = """\nOur goal is collaborative knowledge discovery through the Johari Window framework. If any aspect is unclear, PAUSE and apply Socratic questioning:

KNOWLEDGE MAPPING:
- What do I know that you may not? (My unknown)
- What might you know that I don't? (Your unknown)  
- What are our shared blind spots? (Unknown unknowns)

REASONING PROTOCOL:
- [THINK_LEVEL]: Apply Chain-of-Thought reasoning step-by-step
- Generate 2-3 alternative solution paths (Tree-of-Thoughts)
- Cross-validate: Do multiple reasoning chains converge? (Self-Consistency)
- Constitutional check: Challenge assumptions, identify logical gaps, test edge cases
- Synthesize: Present the highest-confidence path with trade-offs clearly marked

Stay concise. Prioritize clarity over completeness.
""" 

# Instruction text for each suffix. Replace placeholders as desired.
ERROR_LOG_EXPLAIN_TEXT: str = """\nERROR ANALYSIS PROTOCOL:

CHAIN-OF-THOUGHT DECOMPOSITION:
1. What does the trace LITERALLY say? (Ground truth only)
2. What is the causal chain? (Step-by-step failure path)
3. Generate 2-3 competing hypotheses (Tree-of-Thoughts)

CONSTITUTIONAL CONSTRAINTS:
- NO assumptions beyond log evidence
- NO pattern-matching to "common issues"
- Socratic test: "What evidence contradicts this hypothesis?"
- Self-consistency check: Do multiple code paths support this conclusion?

OUTPUT:
- Root cause (evidence-based only)
- Confidence level + uncertainties
- Next diagnostic step with rationale

Be concise. Ground every claim in log text.
"""

THINK: str = SUFFIX_UNIVERSAL.replace("[THINK_LEVEL]", "think")
THINK_HARD: str = SUFFIX_UNIVERSAL.replace("[THINK_LEVEL]", "think hard")
THINK_HARDER: str = SUFFIX_UNIVERSAL.replace("[THINK_LEVEL]", "think harder")
ULTRA_THINK: str = SUFFIX_UNIVERSAL.replace("[THINK_LEVEL]", "ultrathink")

ORDERED_SUFFIXES: tuple[str, ...] = (
    SUFFIX_ULTRA_THINK,
    SUFFIX_THINK_HARD,
    SUFFIX_THINK_HARDER,
    SUFFIX_ERROR_LOG,
    SUFFIX_THINK,
)

# Map suffix to the message that should be injected.
SUFFIX_TO_MESSAGE: Dict[str, str] = {
    SUFFIX_ERROR_LOG: ERROR_LOG_EXPLAIN_TEXT,
    SUFFIX_THINK: THINK,
    SUFFIX_THINK_HARD: THINK_HARD,
    SUFFIX_THINK_HARDER: THINK_HARDER,
    SUFFIX_ULTRA_THINK: ULTRA_THINK,
}
#########################[ end constants ]#####################################


#########################[ start _read_json_from_stdin ]#######################
def _read_json_from_stdin(stdin: TextIO = sys.stdin) -> HookInput:
    """
    Read and return a JSON object from ``stdin`` as a :class:`HookInput`.

    :param stdin: The input stream to read from (defaults to ``sys.stdin``).
    :type stdin: TextIO
    :returns: The decoded JSON object, typed as :class:`HookInput`.
    :rtype: HookInput
    :raises json.JSONDecodeError: If the input is not valid JSON.
    :raises TypeError: If the top‑level JSON value is not an object.
    """
    obj: Any = json.load(stdin)
    if not isinstance(obj, dict):
        raise TypeError("expected a JSON object at the top level")
    return cast(HookInput, obj)


#########################[ end _read_json_from_stdin ]#########################


#########################[ start _extract_prompt ]#############################
def _extract_prompt(payload: HookInput) -> str:
    """
    Extract the ``prompt`` field from the payload.

    Non‑string values are treated as empty.

    :param payload: The decoded JSON object.
    :type payload: HookInput
    :returns: The prompt string, or an empty string if not present or not a string.
    :rtype: str
    """
    value: Any = payload.get("prompt", "")
    return value if isinstance(value, str) else ""


#########################[ end _extract_prompt ]###############################


#########################[ start _match_suffix ]###############################
def _match_suffix(prompt: str, suffixes: Iterable[str] = ORDERED_SUFFIXES) -> Optional[str]:
    """
    Return the first matching suffix for a given prompt, if any.

    Trailing whitespace in the prompt is ignored. The iteration order of
    ``suffixes`` determines precedence (longest first is recommended).

    :param prompt: The original user prompt.
    :type prompt: str
    :param suffixes: Iterable of suffixes to test (checked in order).
    :type suffixes: Iterable[str]
    :returns: The matching suffix (for example, ``"-el"``) or ``None`` if none match.
    :rtype: Optional[str]
    """
    trimmed = prompt.rstrip()
    for s in suffixes:
        if trimmed.endswith(s):
            return s
    return None


#########################[ end _match_suffix ]#################################


#########################[ start _message_for_suffix ]#########################
def _message_for_suffix(suffix: str) -> Optional[str]:
    """
    Look up the message to inject for a given suffix.

    :param suffix: The matched suffix (for example, ``"-th"``).
    :type suffix: str
    :returns: The message text to print to ``stdout``, or ``None`` if unknown.
    :rtype: Optional[str]
    """
    return SUFFIX_TO_MESSAGE.get(suffix)


#########################[ end _message_for_suffix ]###########################


#########################[ start main ]########################################
def main() -> None:
    """
    Entry point for the submit hook.

    Reads a JSON payload from ``stdin``, verifies the event type, and, if any of
    the recognized suffixes (``-el``, ``-t``, ``-th``, ``-ut``) are present at
    the end of the prompt (ignoring trailing whitespace), prints the appropriate
    context for Claude and exits.

    Exit codes
    ----------

    * ``0`` — Success (regardless of whether text was printed).
    * ``1`` — Unexpected error (message written to ``stderr``; non‑blocking).
    """
    try:
        payload: HookInput = _read_json_from_stdin()

        prompt: str = _extract_prompt(payload)
        matched: Optional[str] = _match_suffix(prompt)

        if matched is not None:
            message: Optional[str] = _message_for_suffix(matched)
            if message:
                # Prepend instruction to ignore the suffix
                suffix_instruction = (
                    f"IMPORTANT: The user's message ends with a suffix ({matched}). "
                    "Do not see this suffix, do not mention it, do not ask about it. "
                    "Treat the prompt as if the suffix does not exist.\n\n"
                )
                full_message = suffix_instruction + message

                # For UserPromptSubmit, stdout + exit 0 injects context for Claude.
                print(full_message, flush=True)

        sys.exit(0)

    except Exception as exc:
        print(f"user_prompt_submit hook error: {exc}", file=sys.stderr)
        sys.exit(1)


#########################[ end main ]##########################################

if __name__ == "__main__":
    main()
