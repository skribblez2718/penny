"""
jsa Skill — Package URL (purl) generation

Generates canonical Package URL identifiers for detected JavaScript components.
purl is the universal package identifier format: pkg:<type>/<namespace>/<name>@<version>

Specification: https://github.com/package-url/purl-spec

Why purl:
- Provides a consistent package identifier across ecosystems and tools
- Reduces ambiguity in component matching (Wappalyzer names, npm names,
  filenames, source-map names all normalize to one purl)
- Industry standard used by OSV, CycloneDX, Dependency-Track, etc.
- Self-describing: ecosystem, name, and version are all encoded

Supported ecosystems for this skill:
- pkg:npm/<name>@<version>        — npm packages
- pkg:generic/<name>@<version>    — Unknown/generic JS libraries
- pkg:cdn/cdnjs/<name>@<version>  — CDN-hosted (cdnjs)
- pkg:cdn/jsdelivr/<name>@<version> — CDN-hosted (jsdelivr)
- pkg:github/<owner>/<repo>@<version> — GitHub-hosted
"""

from __future__ import annotations

import re
from typing import Optional


# Characters that must be URL-encoded in purl components (per spec):
# @ → %40, / → %2F (in name), ? → %3F, # → %23
def _encode_purl_component(s: str) -> str:
    """Encode a string for safe inclusion in a purl component."""
    if not s:
        return ""
    return s.replace("@", "%40").replace("?", "%3F").replace("#", "%23")


def make_purl(
    name: str,
    version: Optional[str] = None,
    ecosystem: str = "npm",
    namespace: Optional[str] = None,
) -> str:
    """
    Build a Package URL (purl) string for a detected component.

    Args:
        name: Package name (e.g., "jquery", "@angular/core", "lodash")
        version: Package version (e.g., "1.9.0", "4.17.20"). Optional.
        ecosystem: Package ecosystem. One of:
            - "npm" → pkg:npm/<name>@<version>
            - "generic" → pkg:generic/<name>@<version>
            - "cdnjs" → pkg:cdn/cdnjs/<name>@<version>
            - "jsdelivr" → pkg:cdn/jsdelivr/<name>@<version>
            - "github" → pkg:github/<namespace>/<name>@<version>
            - "unpkg" → pkg:cdn/unpkg/<name>@<version>
        namespace: For scoped packages (@scope/name) or GitHub (owner/repo).
            For npm, this is usually None (the @scope is part of the name).
            For GitHub, this is the owner (e.g., "jquery/jquery").

    Returns:
        A valid purl string. Examples:
            "pkg:npm/jquery@1.9.0"
            "pkg:npm/%40angular/core@17.0.0"
            "pkg:cdn/cdnjs/jquery@1.9.0"
            "pkg:github/jquery/jquery@1.9.0"
            "pkg:generic/mylib@1.0.0" (when no ecosystem identified)
            "pkg:generic/jquery" (when no version known)
    """
    if not name:
        return ""

    ecosystem = ecosystem.lower().strip() if ecosystem else "generic"

    # CDN ecosystems
    if ecosystem in ("cdnjs", "jsdelivr", "unpkg"):
        # Format: pkg:cdn/<provider>/<name>@<version>
        encoded_name = _encode_purl_component(name)
        if version:
            return f"pkg:cdn/{ecosystem}/{encoded_name}@{version}"
        return f"pkg:cdn/{ecosystem}/{encoded_name}"

    # GitHub
    if ecosystem == "github":
        if not namespace:
            # Cannot construct valid purl without owner — fall back to generic
            # (preserve version so the ID is still useful)
            encoded_name = _encode_purl_component(name)
            if version:
                return f"pkg:generic/{encoded_name}@{version}"
            return f"pkg:generic/{encoded_name}"
        encoded_name = _encode_purl_component(name)
        encoded_ns = _encode_purl_component(namespace)
        if version:
            return f"pkg:github/{encoded_ns}/{encoded_name}@{version}"
        return f"pkg:github/{encoded_ns}/{encoded_name}"

    # npm — handle scoped packages (@scope/name)
    if ecosystem == "npm":
        if name.startswith("@"):
            # Scoped package: @scope/name → the @ is encoded as %40
            encoded_name = name.replace("@", "%40", 1).replace("?", "%3F")
        else:
            encoded_name = _encode_purl_component(name)
        if version:
            return f"pkg:npm/{encoded_name}@{version}"
        return f"pkg:npm/{encoded_name}"

    # Generic / unknown ecosystem
    encoded_name = _encode_purl_component(name)
    if version:
        return f"pkg:generic/{encoded_name}@{version}"
    return f"pkg:generic/{encoded_name}"


def parse_purl(purl: str) -> dict:
    """
    Parse a purl string back into its components.

    Returns dict with keys: ecosystem, name, version, namespace (if any).
    Returns {} if purl is malformed.

    Note: This is a best-effort parser, not a full spec implementation.
    """
    if not purl or not purl.startswith("pkg:"):
        return {}

    # Split into type and the rest
    rest = purl[4:]
    parts = rest.split("/", 1)
    if len(parts) < 2:
        return {}
    ecosystem = parts[0]
    path = parts[1]

    # CDN: pkg:cdn/<provider>/<name>@<version> — ecosystem is the provider
    if ecosystem == "cdn":
        cdn_parts = path.split("/", 1)
        if len(cdn_parts) < 2:
            return {"ecosystem": "cdn"}
        # The provider is the actual ecosystem (cdnjs, jsdelivr, unpkg)
        ecosystem = cdn_parts[0]
        name_with_ver = cdn_parts[1]
        namespace = None
    elif ecosystem == "github":
        # GitHub has two path segments: owner/repo
        gh_parts = path.split("/", 1)
        if len(gh_parts) < 2:
            return {"ecosystem": "github"}
        namespace, name_with_ver = gh_parts
    else:
        namespace = None
        name_with_ver = path

    # Split name from version
    if "@" in name_with_ver:
        # The version separator is the LAST @ in the path
        idx = name_with_ver.rfind("@")
        name = name_with_ver[:idx]
        version = name_with_ver[idx + 1:]
    else:
        name = name_with_ver
        version = None

    # Decode %40 back to @ for npm scoped packages
    if ecosystem == "npm" and name.startswith("%40"):
        name = "@" + name[3:]

    return {
        "ecosystem": ecosystem,
        "name": name,
        "version": version,
        "namespace": namespace,
    }


def detect_ecosystem(
    url: str = "",
    filename: str = "",
    wappalyzer_name: str = "",
) -> str:
    """
    Heuristically detect the package ecosystem from URL, filename, or name.

    Returns one of: "npm", "cdnjs", "jsdelivr", "unpkg", "github", "generic".
    Default: "npm" (most common for client-side JS).

    Examples:
        detect_ecosystem(url="https://cdnjs.cloudflare.com/ajax/libs/jquery/1.9.0/jquery.min.js")
            → "cdnjs"
        detect_ecosystem(url="https://cdn.jsdelivr.net/npm/jquery@1.9.0/dist/jquery.min.js")
            → "jsdelivr"
        detect_ecosystem(filename="jquery-1.9.0.min.js")
            → "npm"
    """
    url_lower = url.lower()
    filename_lower = filename.lower()
    combined = url_lower + " " + filename_lower

    if "cdnjs.cloudflare.com" in url_lower or "/cdnjs/" in url_lower:
        return "cdnjs"
    if "cdn.jsdelivr.net" in url_lower or "jsdelivr" in url_lower:
        return "jsdelivr"
    if "unpkg.com" in url_lower or "unpkg" in url_lower:
        return "unpkg"
    if "github.com" in url_lower or "githubusercontent.com" in url_lower:
        return "github"

    # Default for client-side JS
    return "npm"


def build_purl_from_detection(
    wappalyzer_name: str,
    version: Optional[str],
    url: str = "",
    filename: str = "",
    npm_name: Optional[str] = None,
) -> str:
    """
    High-level helper: build a purl from detection context.

    Uses npm_name if provided (from npm_name_map), otherwise derives from
    Wappalyzer name. Detects ecosystem from URL if possible.

    Args:
        wappalyzer_name: Canonical Wappalyzer name (e.g., "jQuery", "Vue.js")
        version: Detected version string, or None
        url: Source URL of the JS file (used for ecosystem detection)
        filename: Local filename (used as fallback for ecosystem detection)
        npm_name: npm package name if known (preferred over wappalyzer_name)

    Returns:
        A purl string.
    """
    ecosystem = detect_ecosystem(url=url, filename=filename)
    name = npm_name or _wappalyzer_to_canonical_name(wappalyzer_name)
    return make_purl(name=name, version=version, ecosystem=ecosystem)


def _wappalyzer_to_canonical_name(wappalyzer_name: str) -> str:
    """Convert Wappalyzer display name to a lowercased npm-style name.

    Examples:
        "jQuery" → "jquery"
        "Vue.js" → "vue"
        "@angular/core" → "@angular/core"
    """
    if not wappalyzer_name:
        return ""
    # Lowercase, but preserve @scope/ for scoped packages
    if wappalyzer_name.startswith("@"):
        return wappalyzer_name  # already in npm form
    return wappalyzer_name.lower().strip()


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Smoke tests
    test_cases = [
        # (name, version, ecosystem, namespace, expected)
        ("jquery", "1.9.0", "npm", None, "pkg:npm/jquery@1.9.0"),
        ("react", "18.2.0", "npm", None, "pkg:npm/react@18.2.0"),
        ("@angular/core", "17.0.0", "npm", None, "pkg:npm/%40angular/core@17.0.0"),
        ("lodash", None, "npm", None, "pkg:npm/lodash"),
        ("mylib", "1.0", "generic", None, "pkg:generic/mylib@1.0"),
        ("jquery", "1.9.0", "cdnjs", None, "pkg:cdn/cdnjs/jquery@1.9.0"),
        ("jquery", "1.9.0", "jsdelivr", None, "pkg:cdn/jsdelivr/jquery@1.9.0"),
        ("query-string", "1.0", "npm", None, "pkg:npm/query-string@1.0"),
        ("foo?bar", "1.0", "npm", None, "pkg:npm/foo%3Fbar@1.0"),
        ("jquery", "1.9.0", "github", "jquery", "pkg:github/jquery/jquery@1.9.0"),
    ]
    print("=== purl generation ===")
    for name, ver, eco, ns, expected in test_cases:
        result = make_purl(name, ver, eco, ns)
        status = "OK" if result == expected else f"FAIL (got {result!r})"
        print(f"  {status}: {name}@{eco} → {result}")

    print("\n=== purl parsing ===")
    parse_cases = [
        # (purl, expected_subset_dict) — only check that all expected fields match
        ("pkg:npm/jquery@1.9.0", {"ecosystem": "npm", "name": "jquery", "version": "1.9.0"}),
        ("pkg:npm/%40angular/core@17.0.0", {"ecosystem": "npm", "name": "@angular/core", "version": "17.0.0"}),
        ("pkg:cdn/cdnjs/jquery@1.9.0", {"ecosystem": "cdnjs", "name": "jquery", "version": "1.9.0"}),
        ("pkg:generic/jquery", {"ecosystem": "generic", "name": "jquery", "version": None}),
    ]
    for purl, expected_subset in parse_cases:
        result = parse_purl(purl)
        # Check that all expected fields match (ignore extra keys)
        all_match = all(result.get(k) == v for k, v in expected_subset.items())
        status = "OK" if all_match else f"FAIL (got {result!r})"
        print(f"  {status}: {purl} → {result}")

    print("\n=== ecosystem detection ===")
    eco_cases = [
        ("https://cdnjs.cloudflare.com/ajax/libs/jquery/1.9.0/jquery.min.js", "jquery-1.9.0.min.js", "cdnjs"),
        ("https://cdn.jsdelivr.net/npm/jquery@1.9.0/dist/jquery.min.js", "", "jsdelivr"),
        ("https://example.com/js/jquery-1.9.0.min.js", "jquery-1.9.0.min.js", "npm"),
        ("https://unpkg.com/react@18/umd/react.production.min.js", "", "unpkg"),
    ]
    for url, fn, expected in eco_cases:
        result = detect_ecosystem(url=url, filename=fn)
        status = "OK" if result == expected else f"FAIL (got {result!r})"
        print(f"  {status}: {url} → {result}")

    print("\n=== end-to-end ===")
    print("  jQuery from cdnjs:",
          build_purl_from_detection("jQuery", "1.9.0",
                                    url="https://cdnjs.cloudflare.com/ajax/libs/jquery/1.9.0/jquery.min.js"))
    print("  Lodash from local:",
          build_purl_from_detection("Lodash", "4.17.20",
                                    filename="lodash.min.js", npm_name="lodash"))
    print("  @angular/core:    ",
          build_purl_from_detection("@angular/core", "17.0.0"))
