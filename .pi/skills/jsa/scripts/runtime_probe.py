"""
jsa Skill — Runtime Probes

Execute JavaScript expressions in the browser context to extract exact
library versions that static analysis cannot determine.

Runtime probes supplement Wappalyzer fingerprints and source map parsing
with authoritative runtime data. They work where static detection fails:
- Hashed vendor bundles (webpack/chunk files)
- Obfuscated/minified code
- CDN-hosted libraries without version in URL
- Frameworks that expose version properties at runtime

Why a separate module:
- Runtime probes require browser context (Playwright evaluate())
- They are fundamentally different from static fingerprinting
- This is a deterministic probe suite, not an agent
- The output (version strings) is consumed by cve_research_handler
  to populate the versions dict with high-confidence data

Probe priority:
1. Global property access (jQuery.fn.jquery, React.version)
2. Constructor/version methods (jQuery().jquery, React.version())
3. Fallback heuristics (checking feature sets)

Each probe returns (library_name, version) or None on failure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class RuntimeProbeResult:
    """Result of executing a runtime probe in the browser."""
    library: str = ""
    version: Optional[str] = None
    probe: str = ""
    confidence: str = "certain"
    error: Optional[str] = None


PROBES: list[dict] = [
    {"library": "jQuery", "probe": "try { return $.fn.jquery || $.jquery || jQuery.fn.jquery || jQuery.jquery; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "React", "probe": "try { return React.version; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Vue.js", "probe": "try { return Vue.version; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Angular", "probe": "try { return ng.coreVersion || (typeof ng !== 'undefined' ? '1.x' : null); } catch(e) { return null; }", "version_regex": r"^(?:\d+\.\d+\.\d+|1\.x)$"},
    {"library": "Lodash", "probe": "try { return _.VERSION; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Moment.js", "probe": "try { return moment.version; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "D3", "probe": "try { return d3.version; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Bootstrap", "probe": "try { return typeof $.fn.tooltip !== 'undefined' ? $.fn.tooltip.Constructor.VERSION : null; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Axios", "probe": "try { return axios.VERSION; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Three.js", "probe": "try { return THREE.REVISION; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Backbone.js", "probe": "try { return Backbone.VERSION; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Underscore.js", "probe": "try { return _.VERSION || _.version; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "Ember.js", "probe": "try { return Ember.VERSION; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
    {"library": "ExtJS", "probe": "try { return Ext.version; } catch(e) { return null; }", "version_regex": r"^(\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?)?$"},
]


def _validate_version_regex(regex: str) -> bool:
    """Validate that a version regex pattern is well-formed."""
    import re
    try:
        re.compile(regex)
        return True
    except re.error:
        return False


def execute_probe(page, probe: dict, max_retries: int = 1) -> RuntimeProbeResult:
    """Execute a single runtime probe in the browser context.

    Args:
        page: Playwright page object
        probe: Dict with keys: library, probe, version_regex
        max_retries: Number of retry attempts on evaluation failure

    Returns:
        RuntimeProbeResult with library, version, confidence, error
    """
    library = probe.get("library", "unknown")
    js_code = probe.get("probe", "")
    version_regex = probe.get("version_regex", r"^.+$")

    result = RuntimeProbeResult(library=library, probe=js_code)

    for attempt in range(max_retries + 1):
        try:
            raw_result = page.evaluate(js_code)

            if raw_result is None or raw_result == "":
                return result  # Library not present

            import re
            version_str = str(raw_result).strip()

            # Quick validation: must look like a version string
            if not re.match(version_regex, version_str, re.IGNORECASE):
                match = re.search(r"\d+\.\d+", version_str)
                if match:
                    version_str = match.group(0)
                else:
                    result.error = f"Version format mismatch: {version_str}"
                    result.confidence = "possible"
                    return result

            result.version = version_str
            result.confidence = "certain"
            return result

        except Exception as e:
            if attempt == max_retries:
                result.error = str(e)
                result.confidence = "possible"
                return result

    return result


def execute_all_probes(page, probes: Optional[list[dict]] = None, max_retries: int = 1) -> list[RuntimeProbeResult]:
    """Execute all runtime probes in sequence.

    Args:
        page: Playwright page object
        probes: Optional custom list of probes (uses default if not provided)
        max_retries: Number of retry attempts per probe on failure

    Returns:
        List of RuntimeProbeResult objects with successful version detections
    """
    if probes is None:
        probes = PROBES

    results: list[RuntimeProbeResult] = []
    for probe in probes:
        if not _validate_version_regex(probe.get("version_regex", "")):
            continue
        result = execute_probe(page, probe, max_retries)
        results.append(result)

    return results


def build_probe_results(page, known_libraries: Optional[set[str]] = None) -> dict[str, dict]:
    """Execute runtime probes and return structured results for cve_research_handler.

    Args:
        page: Playwright page object
        known_libraries: Optional set of libraries we're already detecting (for dedup)

    Returns:
        Dict mapping library name → version data
    """
    if known_libraries:
        probes_to_run = [
            p for p in PROBES
            if any(p["library"].lower() == lib.lower() for lib in known_libraries)
        ]
    else:
        probes_to_run = PROBES

    results = execute_all_probes(page, probes_to_run)

    # Convert to structured format
    probe_data: dict[str, dict] = {}
    for result in results:
        if result.version:
            probe_data[result.library] = {
                "version": result.version,
                "confidence": result.confidence,
                "probe": result.probe,
                "error": result.error,
            }
    return probe_data
