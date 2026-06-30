"""jsa Skill — Joern CPG Integration (Docker Wrapper)

Subprocess wrapper around Docker-based Joern (`joern-parse` + `joern --script`)
for JavaScript data flow analysis.

Mode: Joern --script mode (not server mode). Each container:
  1. Mounts /tmp so it can read JS files and write CPG output
  2. Runs joern-parse to build a CPG from JS files
  3. Runs joern --script with Scala queries to find data flows
  4. Exits — no server lifecycle to manage

Why Joern:
- F1=0.79 vs Semgrep 0.08 on securibench-micro.js (10x more true positives)
- 2x faster than Semgrep on JS benchmarks
- CPG-native proper data flow analysis (not pattern matching)

Graceful degradation:
- If Docker or the Joern image is unavailable, all functions return empty results
- A warning is logged to state.metadata for later surfacing
- Pipeline continues with SAST + correlation based flow cards

Output: DataFlowSlice JSON consumed by SLICE phase.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union


DOCKER_IMAGE = "jsa-joern"
JOERN_VERSION = "4.0+"
JOERN_HEAP_DEFAULT = "4G"
DOCKER_TIMEOUT = 600  # 10 min max for Joern operations


@dataclass
class DataFlowSlice:
    """A data flow slice from Joern.

    Schema per Joern docs:
    {
      "nodes": [{"id": 1000110, "label": "call", "name": "req.param",
                 "code": "req.param('input')", "lineNumber": 10, ...}],
      "edges": [{"src": 1000110, "dst": 1000112, "label": "REACHING_DEF"}]
    }
    """
    nodes: list[dict] = field(default_factory=list)
    edges: list[dict] = field(default_factory=list)
    file: str = ""  # File this slice came from
    vuln_class: str = ""  # Which query produced this slice


@dataclass
class JoernQuery:
    """A Joern data flow query."""
    name: str  # e.g., "dom_xss"
    scala_script: str  # The Scala code to execute
    # Categories of source/sink patterns
    sources: list[str] = field(default_factory=list)
    sinks: list[str] = field(default_factory=list)


@dataclass
class JoernResult:
    """Result of a Joern run."""
    available: bool = False
    slices: list[DataFlowSlice] = field(default_factory=list)
    error: Optional[str] = None
    cpg_path: Optional[str] = None
    duration_seconds: float = 0.0
    queries_run: int = 0


# ---------------------------------------------------------------------------
# Docker availability detection
# ---------------------------------------------------------------------------

_cached_availability: Optional[bool] = None


def _has_joern_image() -> bool:
    """Check if the Joern Docker image is available locally."""
    try:
        result = subprocess.run(
            ["docker", "images", "-q", DOCKER_IMAGE],
            capture_output=True, text=True, timeout=10,
        )
        return bool(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def _can_run_docker() -> bool:
    """Check if Docker is installed and responsive."""
    try:
        result = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def is_joern_available() -> bool:
    """Check if Joern is available via Docker.

    Checks: Docker is installed AND the jsa-joern image exists.
    Cached to avoid repeated subprocess calls.
    """
    global _cached_availability
    if _cached_availability is not None:
        return _cached_availability

    if not _can_run_docker():
        _cached_availability = False
        return False

    if not _has_joern_image():
        _cached_availability = False
        return False

    # Verify the image responds
    try:
        result = subprocess.run(
            ["docker", "run", "--rm", DOCKER_IMAGE, "--help"],
            capture_output=True, text=True, timeout=60,
        )
        _cached_availability = result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        _cached_availability = False

    return _cached_availability


def reset_availability_cache() -> None:
    """Reset the availability cache (for testing)."""
    global _cached_availability
    _cached_availability = None


def warn_joern_unavailable() -> str:
    """Return a warning message about Joern being unavailable.

    Caller is responsible for logging this and writing to state.metadata.
    """
    if not _can_run_docker():
        return (
            "Docker is not available. SLICE phase will operate in degraded mode: "
            "flow cards built from correlation + SAST only (no data flow analysis). "
            "Install Docker, then build the Joern image: "
            "`docker pull ghcr.io/joernio/joern`"
        )
    if not _has_joern_image():
        return (
            f"Joern Docker image '{DOCKER_IMAGE}' not found. "
            "SLICE phase will operate in degraded mode. To build: "
            "`docker build -t jsa-joern -f /path/to/Dockerfile.joern /tmp/`"
        )
    return (
        f"Joern v{JOERN_VERSION} is not available. "
        "SLICE phase will operate in degraded mode."
    )


# ---------------------------------------------------------------------------
# Docker subprocess helpers
# ---------------------------------------------------------------------------


def _docker_run(cmd_suffix: list[str], timeout: int = DOCKER_TIMEOUT,
                entrypoint: Optional[str] = None) -> subprocess.CompletedProcess:
    """Run a command inside the Joern Docker container.

    Mounts /tmp as /tmp (rw) so the container can access JS files and
    write CPG output. The container shares the host filesystem under /tmp.

    The image entrypoint is 'joern' (interactive shell). For subcommands
    like joern-parse, use entrypoint=... to override.

    Args:
        cmd_suffix: List of arguments to pass after the image name.
        timeout: Timeout in seconds.
        entrypoint: Override entrypoint (e.g., '/opt/joern/joern-parse').

    Returns:
        subprocess.CompletedProcess with stdout/stderr.
    """
    cmd = ["docker", "run", "--rm"]
    if entrypoint:
        cmd.extend(["--entrypoint", entrypoint])
    cmd.extend(["-v", "/tmp:/tmp", DOCKER_IMAGE])
    cmd.extend(cmd_suffix)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


# ---------------------------------------------------------------------------
# CPG building
# ---------------------------------------------------------------------------


def parse_cpg(
    js_dir: Union[str, Path],
    output_cpg: Optional[Union[str, Path]] = None,
    jvm_heap: str = JOERN_HEAP_DEFAULT,
    timeout: int = 300,
) -> bool:
    """Run joern-parse on a directory of JS files via Docker to build a CPG.

    Args:
        js_dir: Directory containing JS files to parse.
        output_cpg: Where to write the CPG. If None, uses a temp file.
        jvm_heap: JVM heap size (e.g., "4G", "8G"). NOTE: Docker env
                  doesn't use -J-Xmx directly; Joern's Docker image
                  defaults are used instead.
        timeout: Timeout in seconds.

    Returns:
        True if CPG was built successfully, False otherwise.
    """
    if not is_joern_available():
        return False

    js_dir = Path(js_dir).resolve()
    if output_cpg is None:
        output_cpg = tempfile.NamedTemporaryFile(suffix=".cpg.bin.zip", delete=False).name
    output_cpg = Path(output_cpg).resolve()

    # Ensure output directory exists
    output_cpg.parent.mkdir(parents=True, exist_ok=True)

    # Build command: all paths must be under /tmp for Docker volume mount
    cmd = [
        str(js_dir),
        "--language", "JAVASCRIPT",
        "-o", str(output_cpg),
    ]

    try:
        result = _docker_run(cmd, timeout=timeout, entrypoint="/opt/joern/joern-parse")
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------------------
# Data flow queries
# ---------------------------------------------------------------------------


def run_dataflow_queries(
    cpg_path: Union[str, Path],
    queries: list[JoernQuery],
    jvm_heap: str = JOERN_HEAP_DEFAULT,
    timeout: int = 300,
) -> list[DataFlowSlice]:
    """Execute Scala data flow queries via Docker against a CPG.

    Args:
        cpg_path: Path to a CPG built by parse_cpg().
        queries: List of JoernQuery objects.
        jvm_heap: JVM heap size (doesn't apply in Docker).
        timeout: Per-query timeout in seconds.

    Returns:
        List of DataFlowSlice (empty if Joern unavailable or all queries fail).
    """
    if not is_joern_available():
        return []

    cpg_path = Path(cpg_path).resolve()
    slices: list[DataFlowSlice] = []
    for query in queries:
        slice_data = _run_single_query(cpg_path, query, timeout)
        if slice_data is not None:
            slices.append(slice_data)
    return slices


def _run_single_query(
    cpg_path: Path,
    query: JoernQuery,
    timeout: int,
) -> Optional[DataFlowSlice]:
    """Run a single Joern query via Docker and parse its output."""
    # Write script to a temp file under /tmp so Docker can mount it
    script_file = tempfile.NamedTemporaryFile(
        mode="w", suffix=".sc", delete=False, encoding="utf-8"
    )
    try:
        # Replace $CPG_PATH placeholder with actual CPG path
        script_content = query.scala_script.replace("$CPG_PATH", str(cpg_path))
        script_file.write(script_content)
        script_file.close()
        script_path = Path(script_file.name).resolve()

        cmd = [
            "--script", str(script_path),
            "--nocolors",
            str(cpg_path),
        ]

        result = _docker_run(cmd, timeout=timeout)

        if result.returncode != 0:
            return None

        # Parse JSON from output (skip Joern banner)
        return _parse_joern_output(result.stdout, query.name)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    finally:
        try:
            os.unlink(script_file.name)
        except OSError:
            pass


def _parse_joern_output(stdout: str, query_name: str) -> Optional[DataFlowSlice]:
    """Parse DataFlowSlice JSON from Joern stdout.

    Joern outputs the query result as JSON, possibly preceded by banner text.
    We look for the first '{' and try to parse from there.
    """
    # Find the start of JSON
    start = stdout.find("{")
    if start == -1:
        return None

    json_text = stdout[start:]
    try:
        data = json.loads(json_text)
    except json.JSONDecodeError:
        # Try to find a JSON object in the output
        for line in stdout.split("\n"):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    data = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
        else:
            return None

    return DataFlowSlice(
        nodes=data.get("nodes", []),
        edges=data.get("edges", []),
        vuln_class=query_name,
    )


# ---------------------------------------------------------------------------
# Query templates
# ---------------------------------------------------------------------------


def joern_query(vuln_class: str) -> Optional[JoernQuery]:
    """Return a built-in query template for a vuln class.

    Each template defines source/sink patterns specific to JS bug bounty
    targets. Joern's CPGQL is used to find data flows.

    Returns None if no template exists for the given vuln class.
    """
    templates = _get_builtin_templates()
    return templates.get(vuln_class)


def _get_builtin_templates() -> dict[str, JoernQuery]:
    """Built-in query templates for common JS vuln classes."""
    dom_xss_sources = (
        r"(location\.search|location\.hash|document\.URL|document\.location|"
        r"document\.referrer|window\.name|document\.cookie|"
        r"postMessage|window\.opener)"
    )
    dom_xss_sinks = (
        r"(\.innerHTML|\.outerHTML|\.insertAdjacentHTML|"
        r"document\.write|\.html\(|\$\(.+\.html\()|"
        r"eval|new Function)"
    )

    return {
        "dom_xss": JoernQuery(
            name="dom_xss",
            scala_script="""
importCpg("$CPG_PATH")
def source = cpg.call.name("$SOURCES")
def sink = cpg.call.name("$SINKS")
sink.reachableByFlows(source).toJson
""".replace("$SOURCES", dom_xss_sources).replace("$SINKS", dom_xss_sinks),
            sources=[dom_xss_sources],
            sinks=[dom_xss_sinks],
        ),
        "prototype_pollution": JoernQuery(
            name="prototype_pollution",
            scala_script="""
importCpg("$CPG_PATH")
def source = cpg.call.name("(\\\\.parse|req\\\\.(body|query|params)|location\\\\.search)")
def sink = cpg.call.name("(Object\\\\.assign|\\\\.\\\\.\\\\.obj|\\\\.extend|merge)")
sink.reachableByFlows(source).toJson
""",
            sources=["req.body", "req.query", "location.search"],
            sinks=["Object.assign", "...obj", ".extend", "merge"],
        ),
        "command_injection": JoernQuery(
            name="command_injection",
            scala_script="""
importCpg("$CPG_PATH")
def source = cpg.call.name("(req\\\\.(body|query|params)|location\\\\.search|postMessage)")
def sink = cpg.call.name("(eval|exec|execSync|spawn|new Function|setTimeout|setInterval)")
sink.reachableByFlows(source).toJson
""",
            sources=["req.body", "req.query", "location.search"],
            sinks=["eval", "exec", "new Function", "setTimeout"],
        ),
        "ssrf": JoernQuery(
            name="ssrf",
            scala_script="""
importCpg("$CPG_PATH")
def source = cpg.call.name("(req\\\\.(body|query|params)|location\\\\.search|postMessage)")
def sink = cpg.call.name("(fetch|axios|\\\\.get|\\\\.post|\\\\.request|http\\\\.get|https\\\\.get|request\\\\(url)")
sink.reachableByFlows(source).toJson
""",
            sources=["req.body", "req.query", "location.search"],
            sinks=["fetch", "axios", ".get", ".request"],
        ),
        "sqli": JoernQuery(
            name="sqli",
            scala_script="""
importCpg("$CPG_PATH")
def source = cpg.call.name("(req\\\\.(body|query|params)|location\\\\.search)")
def sink = cpg.call.name("(\\\\.query|\\.execute|\\.raw|knex\\\\.|sequelize\\\\.)")
sink.reachableByFlows(source).toJson
""",
            sources=["req.body", "req.query", "location.search"],
            sinks=[".query", ".execute", "knex", "sequelize"],
        ),
    }


# ---------------------------------------------------------------------------
# Joern suitability check
# ---------------------------------------------------------------------------


def is_joern_suitable(
    file_path: str,
    classification: Optional[object] = None,
    source_map_url: Optional[str] = None,
) -> bool:
    """Decide if a file is worth running through Joern.

    Skip:
    - CDN bundles (well-known libraries, no novel vuln)
    - Multi-component bundles without source maps (CPG quality degrades)
    - Inline scripts (too small, no AST value)
    - Non-JS files (HTML, CSS, etc.)

    Run:
    - First-party files (highest signal)
    - Single-component libraries (uncommon for custom code)
    - Bundled files with source maps (deobfuscate first)

    Args:
        file_path: The file path.
        classification: Optional ClassificationResult from asset_classify.
        source_map_url: Optional source map URL.

    Returns:
        True if Joern should be run on this file.
    """
    # Skip non-JS
    if not file_path.endswith((".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx")):
        return False

    # Skip obvious library files
    if "node_modules" in file_path:
        return False

    if classification is not None:
        cls = getattr(classification, "classification", "")
        # Skip CDN bundles — well-known libraries
        if cls == "cdn_bundle":
            return False
        # Skip multi-component bundles without source maps
        if cls == "multi_component_bundle" and not source_map_url:
            return False
        # Skip inline scripts
        if cls == "inline":
            return False

    return True


# ---------------------------------------------------------------------------
# High-level convenience
# ---------------------------------------------------------------------------


def run_joern_for_files(
    js_files: list[Union[str, Path]],
    vuln_classes: Optional[list[str]] = None,
    jvm_heap: str = JOERN_HEAP_DEFAULT,
    deob_dir: Optional[Path] = None,
) -> JoernResult:
    """High-level: parse files, run queries, return slices.

    Runs entirely within Docker containers. The /tmp volume mount ensures
    all paths are accessible inside the container.

    Args:
        js_files: List of JS file paths to analyze.
        vuln_classes: Which vuln class queries to run (default: all 5 built-ins).
        jvm_heap: JVM heap size (Docker default used instead).
        deob_dir: If provided, deobfuscated files are here (used as parse dir).

    Returns:
        JoernResult with slices and metadata.
    """
    result = JoernResult(available=is_joern_available())
    if not result.available:
        result.error = "Joern Docker image not available"
        return result

    if vuln_classes is None:
        vuln_classes = list(_get_builtin_templates().keys())

    # Build the dir to parse
    if deob_dir is not None and deob_dir.exists():
        parse_dir = deob_dir
    else:
        # Use a temp dir under /tmp (accessible from Docker)
        parse_dir = Path(tempfile.mkdtemp(prefix="jsa-joern-"))
        for f in js_files:
            try:
                target = parse_dir / Path(f).name
                if not target.exists():
                    target.symlink_to(Path(f).absolute())
            except OSError:
                pass

    start = time.time()

    # Build CPG
    cpg_path = parse_dir / "cpg.bin.zip"
    if not parse_cpg(parse_dir, output_cpg=cpg_path, timeout=300):
        result.error = f"Failed to build CPG from {parse_dir}"
        result.duration_seconds = time.time() - start
        return result

    result.cpg_path = str(cpg_path)

    # Run queries
    queries = []
    for vc in vuln_classes:
        q = joern_query(vc)
        if q is not None:
            queries.append(q)

    if not queries:
        result.duration_seconds = time.time() - start
        return result

    slices = run_dataflow_queries(cpg_path, queries, timeout=300)
    result.slices = slices
    result.queries_run = len(queries)
    result.duration_seconds = time.time() - start

    return result