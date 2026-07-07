"""Verify the SYSTEM.md Cognitive Frame stays within its token budget.

Token counts are computed with **tiktoken** (`cl100k_base`) — this is the ONE
canonical way Penny counts tokens. We deliberately do NOT use a word-count
heuristic (e.g. words / 0.75): markdown tables and structured content tokenize
very differently from prose, so a word ratio is unreliable. Because Penny runs a
variety of models (Claude, etc.) whose tokenizers differ from `cl100k_base`, this
count is an APPROXIMATION used consistently as a budgeting proxy — not an exact
per-model figure.

Budget: the `<system_context>` block (the always-on "Cognitive Frame" injected
into every Penny turn and every subagent) must stay <= MAX_TOKENS. Keep the frame
lean by moving conditionally-needed, non-universal content into `docs/penny/` and
loading it on demand via `read` (see docs/agents/prompts/cognitive-frame-standards.md).
"""

import re
import sys

MAX_TOKENS = 1500  # tiktoken cl100k_base; always-on Cognitive Frame — keep it lean
FILE = ".pi/SYSTEM.md"
ENCODING = "cl100k_base"


def count_tokens(text: str) -> int:
    """Canonical token count for Penny. tiktoken is required — no fallback."""
    try:
        import tiktoken
    except ImportError:
        print(
            "FAIL: tiktoken is not installed — it is the ONLY sanctioned way to count "
            "tokens. Install it: uv pip install --python .venv/bin/python tiktoken "
            "(it is declared in scripts/setup/init-external-tools.sh)."
        )
        sys.exit(2)
    return len(tiktoken.get_encoding(ENCODING).encode(text))


def check() -> bool:
    text = open(FILE).read()
    m = re.search(r"<system_context>(.*?)</system_context>", text, re.DOTALL)
    if not m:
        print(f"FAIL: No <system_context> block found in {FILE}")
        return False

    tokens = count_tokens(m.group(1))
    if tokens > MAX_TOKENS:
        print(f"FAIL: system_context is {tokens} tokens (max: {MAX_TOKENS}, {ENCODING})")
        print(
            "  Fix: move conditionally-needed / non-universal content into docs/penny/ "
            "and reference it for on-demand `read`; remove elaboration before removing rules."
        )
        return False

    print(f"OK: system_context is {tokens} tokens (limit: {MAX_TOKENS}, {ENCODING})")
    return True


if __name__ == "__main__":
    sys.exit(0 if check() else 1)
