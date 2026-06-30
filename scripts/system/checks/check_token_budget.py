"""Verify SYSTEM.md token budget is within limits."""

import re
import sys

MAX_WORDS = 697  # ~697 words ≈ 930 tokens at 0.75 tokens/word
FILE = ".pi/SYSTEM.md"


def check() -> bool:
    text = open(FILE).read()
    m = re.search(r"<system_context>(.*?)</system_context>", text, re.DOTALL)
    if not m:
        print(f"FAIL: No <system_context> block found in {FILE}")
        return False

    words = len(m.group(1).split())
    tokens = int(words / 0.75)
    if words > MAX_WORDS:
        print(f"FAIL: system_context is {words} words ≈ {tokens} tokens (max: {MAX_WORDS} words ≈ ~930 tokens)")
        print("  Fix: Remove domain-specific content, compress declarative rules, remove narrative.")
        return False

    print(f"OK: system_context is {words} words ≈ {tokens} tokens (limit: ~930)")
    return True


if __name__ == "__main__":
    ok = check()
    sys.exit(0 if ok else 1)
