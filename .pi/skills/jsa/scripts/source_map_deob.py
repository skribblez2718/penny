"""jsa Skill — Source Map Deobfuscation

Given a bundled/minified JS file with a `//# sourceMappingURL=...` comment,
fetch the source map and reconstruct the original sources so they can be
sent to Joern (which produces higher-quality CPGs for non-bundled code).

For sourcemap-less bundles, this is a no-op — the deobfuscate skill (future)
will handle those cases with webcrack/synchrony.

Source map format (JSON):
{
  "version": 3,
  "file": "out.js",
  "sourceRoot": "",
  "sources": ["webpack:///./src/foo.ts", ...],
  "sourcesContent": ["...", ...],   // May be null/missing
  "names": [],
  "mappings": "AAAA;AACI;..."
}
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union
from urllib.parse import urljoin
import urllib.request
import urllib.error


SOURCE_MAP_COMMENT_PATTERN = re.compile(
    r"//[#@]\s*sourceMappingURL\s*=\s*['\"]?([^\s'\"\\]+)['\"]?",
    re.IGNORECASE,
)


@dataclass
class DeobfuscationResult:
    """Result of source map deobfuscation."""
    original_js_path: str = ""  # Path to the original (deobfuscated) JS file
    source_map_url: str = ""
    sources: list[str] = field(default_factory=list)  # Source paths from map
    sources_content: list[Optional[str]] = field(default_factory=list)  # Content per source
    sources_fetched: int = 0  # Count of sources successfully reconstructed
    sources_missing_content: int = 0  # Sources with no content
    error: Optional[str] = None

    @property
    def success(self) -> bool:
        return self.error is None and self.sources_fetched > 0


def find_source_map_url(js_content: str, js_url: str = "") -> Optional[str]:
    """Find the sourceMappingURL comment in JS content.

    Args:
        js_content: The JavaScript source code.
        js_url: The URL of the JS file (for resolving relative source map URLs).

    Returns:
        The source map URL (resolved to absolute if js_url is provided), or None.
    """
    match = SOURCE_MAP_COMMENT_PATTERN.search(js_content)
    if not match:
        return None
    sm_url = match.group(1).strip()
    if js_url and not sm_url.startswith(("http://", "https://", "data:")):
        return urljoin(js_url, sm_url)
    return sm_url


def fetch_source_map(source_map_url: str, timeout: int = 30) -> Optional[dict]:
    """Fetch a source map from a URL.

    Returns the parsed JSON dict, or None on failure.
    """
    if source_map_url.startswith("data:"):
        # data:application/json;base64,...
        try:
            _, data = source_map_url.split(",", 1)
            decoded = base64.b64decode(data)
            return json.loads(decoded)
        except (ValueError, json.JSONDecodeError):
            return None

    try:
        with urllib.request.urlopen(source_map_url, timeout=timeout) as resp:
            data = resp.read()
        return json.loads(data)
    except (urllib.error.URLError, json.JSONDecodeError, OSError):
        return None


def reconstruct_sources(
    source_map: dict,
    output_dir: Union[str, Path],
    fetch_external: bool = True,
    timeout: int = 30,
) -> tuple[list[str], list[Optional[str]]]:
    """Reconstruct original sources from a source map.

    If sourcesContent is present in the map, use it directly.
    Otherwise, fetch each source URL from the map (best effort).

    Args:
        source_map: Parsed source map dict.
        output_dir: Directory to write reconstructed source files.
        fetch_external: If True, fetch source URLs that aren't inline.
        timeout: HTTP fetch timeout in seconds.

    Returns:
        (list of written file paths, list of content per source).
        Content may be None if the source couldn't be reconstructed.
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    sources = source_map.get("sources", [])
    sources_content = source_map.get("sourcesContent", [])

    written_paths: list[str] = []
    contents: list[Optional[str]] = []

    for i, src in enumerate(sources):
        # Determine the source's content
        content: Optional[str] = None
        if i < len(sources_content) and sources_content[i]:
            content = sources_content[i]

        if content is None and fetch_external:
            # Try to fetch the source URL
            try:
                with urllib.request.urlopen(src, timeout=timeout) as resp:
                    content = resp.read().decode("utf-8", errors="replace")
            except (urllib.error.URLError, OSError, ValueError):
                content = None

        # Write to output_dir
        # Sanitize the source path: strip ALL ../ components
        # (not just leading) to prevent path traversal
        safe_name = re.sub(r"[^\w\-./]", "_", src)
        # Replace ../ with _/ to prevent traversal while preserving uniqueness
        safe_name = re.sub(r"\.\./", "_/", safe_name)
        safe_name = re.sub(r"/\.\.", "/_", safe_name)
        # Strip leading ../ and slashes
        safe_name = safe_name.lstrip("/.")
        if not safe_name.endswith(".js") and not safe_name.endswith(".ts") and not safe_name.endswith(".tsx"):
            safe_name = safe_name + ".js"
        out_path = out_dir / safe_name
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if content is not None:
            out_path.write_text(content, encoding="utf-8")
            contents.append(content)
        else:
            # Write a placeholder so the file exists
            out_path.write_text(
                f"/* Source {src} not available in source map */\n",
                encoding="utf-8",
            )
            contents.append(None)
        written_paths.append(str(out_path))

    return written_paths, contents


def deobfuscate_via_source_map(
    js_path: Union[str, Path],
    output_dir: Union[str, Path],
    source_map_url: Optional[str] = None,
    js_url: str = "",
    fetch_external: bool = True,
) -> DeobfuscationResult:
    """Deobfuscate a JS file using its source map.

    Args:
        js_path: Path to the bundled/minified JS file.
        output_dir: Where to write reconstructed sources.
        source_map_url: Explicit source map URL. If None, looks for
                       `//# sourceMappingURL=` in the JS file.
        js_url: URL of the JS file (for resolving relative source map URLs).
        fetch_external: If True, fetch sources that aren't inline in the map.
        js_content: Override the JS file content (for testing).

    Returns:
        DeobfuscationResult with paths to reconstructed sources.
    """
    result = DeobfuscationResult()

    js_p = Path(js_path)
    if not js_p.exists():
        result.error = f"JS file not found: {js_path}"
        return result

    try:
        js_content = js_p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        result.error = f"Failed to read JS file: {e}"
        return result

    # Find source map URL
    if source_map_url is None:
        source_map_url = find_source_map_url(js_content, js_url)

    if not source_map_url:
        result.error = "No sourceMappingURL found in JS file"
        return result

    result.source_map_url = source_map_url

    # Fetch source map
    sm = fetch_source_map(source_map_url)
    if sm is None:
        result.error = f"Failed to fetch source map: {source_map_url}"
        return result

    # Reconstruct sources
    written_paths, contents = reconstruct_sources(
        sm, output_dir, fetch_external=fetch_external
    )

    result.original_js_path = str(Path(output_dir) / "_reconstructed.js")
    result.sources = sm.get("sources", [])
    result.sources_content = contents
    result.sources_fetched = sum(1 for c in contents if c is not None)
    result.sources_missing_content = sum(1 for c in contents if c is None)

    # Create a single bundled file that Joern can analyze
    if written_paths:
        bundled = []
        for p, c in zip(written_paths, contents):
            if c is not None:
                bundled.append(f"// Source: {p}\n{c}\n")
        if bundled:
            Path(result.original_js_path).write_text("\n".join(bundled), encoding="utf-8")

    return result
