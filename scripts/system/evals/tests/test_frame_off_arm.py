"""Frame-OFF arm is a non-empty neutral 'bare model' prompt.

Regression guard: the OFF baseline must pass an explicit, NON-EMPTY
--system-prompt. A 0-byte prompt makes Pi revert to its built-in default — which
(a) changes the measurement from 'frame vs raw model' back to 'frame vs Pi's
frame' and (b) is rejected by Anthropic OAuth from a hermetic context with a
third-party-usage 400, silently dropping every Claude cell.
"""

import run_prompt_efficacy as rpe


def test_off_arm_supplies_explicit_nonempty_prompt(tmp_path):
    arms = rpe.build_arms("FRAME-TEXT", [("ollama", "glm-5.2:cloud")], tmp_path, ablate=False)
    by_name = {name: path for name, path, _ in arms}

    assert {"on", "off"} <= set(by_name)

    off_path = by_name["off"]
    assert off_path is not None, "off arm must pass an explicit --system-prompt, never None"
    off_text = off_path.read_text(encoding="utf-8")
    # Must be NON-EMPTY (a 0-byte prompt reverts Pi to its built-in default),
    # but semantically bare — whitespace only, no instructions (the raw model).
    assert off_text != "", "off prompt must be non-empty (0-byte reverts Pi to its default)"
    assert off_text == rpe.BARE_PROMPT
    assert off_text.strip() == "", "bare baseline must carry no instructions (whitespace only)"


def test_on_arm_carries_frame_verbatim(tmp_path):
    arms = rpe.build_arms("FRAME-TEXT", [("ollama", "glm-5.2:cloud")], tmp_path, ablate=False)
    by_name = {name: path for name, path, _ in arms}
    assert by_name["on"].read_text(encoding="utf-8") == "FRAME-TEXT"


def test_bare_prompt_constant_is_nonempty():
    # Non-empty (avoids Pi's 0-byte fallback to its default) but whitespace-only.
    assert rpe.BARE_PROMPT != ""
    assert rpe.BARE_PROMPT.strip() == ""
