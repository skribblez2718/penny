"""
npm_name_map.py — Wappalyzer name → npm package name mapping for CVE lookups.

Maps canonical Wappalyzer technology names to npm package identifiers used
by OSV.dev and other ecosystem-native CVE databases. For libraries that
are not in the explicit table, provides a lowercase heuristic fallback.

Usage:
    from npm_name_map import wappalyzer_to_npm

    info = wappalyzer_to_npm("jQuery")
    if info:
        # {"npm": "jquery", "ecosystem": "npm", "confidence": "CERTAIN"}
        print(f"Query OSV for {info['npm']} v3.7.1")
"""

# ---------------------------------------------------------------------------
# Mapping table (CERTAIN confidence)
# ---------------------------------------------------------------------------
# Wappalyzer canonical name → npm package name + OSV ecosystem.
# Built from the inverse of `_NPM_TO_WAPPALYZER` in fsm.py plus common
# JS libraries with strong npm-ecosystem presence.

WAPPALYZER_TO_NPM: dict[str, dict[str, str]] = {
    "jQuery":     {"npm": "jquery",          "ecosystem": "npm", "confidence": "CERTAIN"},
    "React":      {"npm": "react",           "ecosystem": "npm", "confidence": "CERTAIN"},
    "Vue.js":     {"npm": "vue",             "ecosystem": "npm", "confidence": "CERTAIN"},
    "Angular":    {"npm": "@angular/core",   "ecosystem": "npm", "confidence": "CERTAIN"},
    "Bootstrap":  {"npm": "bootstrap",       "ecosystem": "npm", "confidence": "CERTAIN"},
    "Lodash":     {"npm": "lodash",          "ecosystem": "npm", "confidence": "CERTAIN"},
    "Moment.js":  {"npm": "moment",          "ecosystem": "npm", "confidence": "CERTAIN"},
    "D3":         {"npm": "d3",              "ecosystem": "npm", "confidence": "CERTAIN"},
}


# ---------------------------------------------------------------------------
# Mapping function
# ---------------------------------------------------------------------------

def wappalyzer_to_npm(wappalyzer_name: str) -> dict | None:
    """
    Map a Wappalyzer canonical name to an npm package identifier.

    Strategy:
    1. Exact lookup in WAPPALYZER_TO_NPM → returns CERTAIN confidence.
    2. Scoped packages (@scope/name) pass through unchanged → CERTAIN.
    3. Lowercase + strip-dots heuristic → PROBABLE confidence (may be wrong).
    4. Return None if unmappable.

    Args:
        wappalyzer_name: Canonical name from tech_stack_hints (e.g., "jQuery").

    Returns:
        dict with keys {npm, ecosystem, confidence} or None.
    """
    if not wappalyzer_name:
        return None

    # 1. Exact lookup
    if wappalyzer_name in WAPPALYZER_TO_NPM:
        return WAPPALYZER_TO_NPM[wappalyzer_name]

    # 2. Scoped packages (e.g., "@babel/runtime") are already in npm format
    if wappalyzer_name.startswith("@") and "/" in wappalyzer_name:
        return {
            "npm": wappalyzer_name,
            "ecosystem": "npm",
            "confidence": "CERTAIN",
        }

    # 3. Lowercase heuristic: try simple normalization
    # Strip ".js" suffix, lowercase, replace spaces/dots with hyphens
    normalized = wappalyzer_name.lower()
    for suffix in (".js", " js", " library", " framework"):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
    normalized = normalized.strip().replace(" ", "-").replace(".", "-")
    normalized = "-".join(part for part in normalized.split("-") if part)

    # Only return heuristic result if it's a plausible npm name:
    # starts with a letter, alphanumeric + hyphens, not too short
    if (
        normalized
        and normalized[0].isalpha()
        and all(c.isalnum() or c in "-_" for c in normalized)
        and len(normalized) >= 2
    ):
        return {
            "npm": normalized,
            "ecosystem": "npm",
            "confidence": "PROBABLE",
        }

    return None


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    test_cases = [
        ("jQuery", "jquery", "CERTAIN"),
        ("React", "react", "CERTAIN"),
        ("Vue.js", "vue", "CERTAIN"),
        ("Angular", "@angular/core", "CERTAIN"),
        ("@babel/runtime", "@babel/runtime", "CERTAIN"),
        ("SomeUnknownLib", "someunknownlib", "PROBABLE"),
        ("Google Analytics", "google-analytics", "PROBABLE"),
        ("", None, None),
        ("X", None, None),  # Too short
    ]
    for name, expected_npm, expected_conf in test_cases:
        result = wappalyzer_to_npm(name)
        if result is None:
            status = "OK" if expected_npm is None else "FAIL"
        else:
            status = "OK" if result["npm"] == expected_npm and result["confidence"] == expected_conf else "FAIL"
        print(f"  [{status}] {name!r} → {result}")
