"""
jsa Skill - Dispatch Engine (LEGACY — Phase B 2026-06)

DEPRECATED: This module is no longer used in production. The pipeline now
uses the `investigate_handler` in `fsm.py` which directly generates
per-lane work items from FlowCards (no separate dispatch step).

This file is kept for backward compatibility and testing. New code should
use `fsm.investigate_handler()` instead.

The new architecture is documented in `agent-augmented-security-annalysis.md`
and implemented in:
  - fsm.py: structure_handler, slice_handler, investigate_handler
  - structure_analysis.py: typed analysis store
  - flow_card.py, module_card.py, page_card.py: card data structures

Architecture: plans/jsa-implementation/02-parallelism-and-comms.md §14
              plans/jsa-implementation/04-generalized-pipeline.md §3.2
"""

import math
from pathlib import Path
from typing import Any

# Prompts directory relative to the skill
_PROMPTS_DIR = Path(__file__).parent.parent / "assets" / "prompts"


# ---------------------------------------------------------------------------
# Scope section formatter
# ---------------------------------------------------------------------------

def _format_scope_section(out_of_scope: list[str] | None) -> str:
    """Render the hard-scope section that gets prepended to every worker prompt.

    The orchestrator enforces scope via substring match in ACQUIRE; this block
    is the worker-level enforcement that prevents agents from crafting PoCs
    or probes against out-of-scope URLs.
    """
    if not out_of_scope:
        return (
            "No explicit out_of_scope patterns were configured. "
            "All reachable URLs on the target host are in scope. "
            "Do not probe or interact with URLs on hosts other than the declared target."
        )
    bullets = "\n".join(f"- `{p}`" for p in out_of_scope)
    return (
        f"The following URL substrings are **OUT OF SCOPE** for this engagement. "
        f"You must NOT craft PoC payloads, browser automation, or HTTP probes that fetch, navigate to, "
        f"or otherwise interact with these URLs. Substring match is used for enforcement.\n\n"
        f"{bullets}\n\n"
        f"**Rules:**\n"
        f"- If a finding's exploitation would require out-of-scope interaction, mark the finding "
        f"with `out_of_scope: true` in the finding payload and skip verification.\n"
        f"- Do not include out-of-scope URLs in screenshots, payloads, or referenced links.\n"
        f"- If uncertain whether a URL is in scope, prefer to skip and note the uncertainty."
    )


# ---------------------------------------------------------------------------
# 1.4.1 Build worker prompt
# ---------------------------------------------------------------------------

def build_worker_prompt(
    chunk: Any,          # ResolvedChunk
    analyzer_name: str,
    session_id: str,
    base_protocol_path: str | None = None,
    analyzer_prompt_path: str | None = None,
    validated_findings: list[dict] | None = None,
    cve_findings: list[dict] | None = None,
    out_of_scope: list[str] | None = None,
) -> str:
    """
    Assemble a worker prompt from base protocol + analyzer-specific guide + chunk data.

    Args:
        chunk: ResolvedChunk with body, overlap_context, file_spans
        analyzer_name: Vuln class (e.g., "dom_xss")
        session_id: Session ID for mesh rooms
        base_protocol_path: Path to annie-base.md (auto-detected if None)
        analyzer_prompt_path: Path to annie-{vuln_class}.md (auto-detected if None)
        validated_findings: SAST-validated findings to inject as context

    Returns:
        Full worker prompt string ready for subagent task parameter.
    """
    # Load base protocol
    if base_protocol_path:
        base_path = Path(base_protocol_path)
    else:
        base_path = _PROMPTS_DIR / "annie-base.md"

    base_protocol = ""
    if base_path.exists():
        base_protocol = base_path.read_text()

    # Load analyzer-specific guide
    if analyzer_prompt_path:
        analyzer_path = Path(analyzer_prompt_path)
    else:
        analyzer_path = _PROMPTS_DIR / f"annie-{analyzer_name}.md"

    analyzer_guide = ""
    if analyzer_path.exists():
        analyzer_guide = analyzer_path.read_text()
    else:
        analyzer_guide = f"# {analyzer_name} Analysis\n\nAnalyze the code for {analyzer_name} vulnerabilities.\n"

    # Build file spans summary
    spans_text = ""
    if hasattr(chunk, 'file_spans') and chunk.file_spans:
        spans_parts = []
        for span in chunk.file_spans:
            spans_parts.append(f"- {span.file_path}:{span.start_line}-{span.end_line}")
        spans_text = "\n".join(spans_parts)

    # Build the prompt
    prompt = f"""# JS Analysis Worker - {analyzer_name}

{base_protocol}

---

## Analyzer: {analyzer_name}

{analyzer_guide}

---

## Your Chunk: {chunk.chunk_id}

**Files covered:**
{spans_text or "  (see body for file markers)"}

**Method:** {chunk.metadata.get('method', 'unknown')}
**Chunk:** {chunk.metadata.get('chunk_index', 0) + 1} of {chunk.metadata.get('total_chunks', '?')}

### Chunk Body
```javascript
{chunk.body}
```

### Context (surrounding code - for reference only)
```javascript
{chunk.overlap_context or "  (no surrounding context available)"}
```

---

## Scope (HARD CONSTRAINT)

{_format_scope_section(out_of_scope)}

## Coordination

**Mesh room:** `{session_id}-mesh`
**Feed room:** `{session_id}-feed`
**Findings room:** `{session_id}-findings`

On completion, store findings to `{session_id}-findings`.
Post cross-chunk hints to `{session_id}-feed`.
"""

    # Inject validated SAST findings context
    if validated_findings:
        confirmed = [f for f in validated_findings if f.get("validation") == "confirmed"]
        false_pos = [f for f in validated_findings if f.get("validation") == "false_positive"]
        deeper = [f for f in validated_findings if f.get("validation") == "needs_deeper"]

        if confirmed or false_pos or deeper:
            prompt += "\n## SAST Pre-Scan Results (already validated)\n\n"
            prompt += "These findings were found by automated scanners and validated. "
            prompt += "Use this to avoid re-discovering what's already known.\n\n"

            if confirmed:
                prompt += f"### Confirmed ({len(confirmed)} findings - SKIP these)\n"
                for f in confirmed[:10]:
                    prompt += f"- [{f.get('vuln_class','?')}] {f.get('file','?')}:{f.get('line','?')} - {f.get('message','')[:100]}\n"
                if len(confirmed) > 10:
                    prompt += f"  ... and {len(confirmed) - 10} more\n"
                prompt += "\n"

            if false_pos:
                prompt += f"### False Positives ({len(false_pos)} findings - IGNORE these)\n"
                for f in false_pos[:5]:
                    prompt += f"- [{f.get('vuln_class','?')}] {f.get('file','?')}:{f.get('line','?')} - {f.get('reason','')[:100]}\n"
                prompt += "\n"

            if deeper:
                prompt += f"### Needs Deeper Analysis ({len(deeper)} findings - YOU verify these)\n"
                for f in deeper[:5]:
                    prompt += f"- [{f.get('vuln_class','?')}] {f.get('file','?')}:{f.get('line','?')} - {f.get('message','')[:100]}\n"
                prompt += "\n"

    # Inject CVE research context
    if cve_findings:
        relevant = [c for c in cve_findings if analyzer_name in c.get("vuln_classes", []) or not c.get("vuln_classes")]
        if relevant:
            prompt += "\n## CVE Research (relevant to tech stack)\n\n"
            prompt += "These CVEs were found for the target's detected tech stack. "
            prompt += "Prioritize patterns, bypasses, and gadgets matching these CVEs.\n\n"
            for cve in relevant[:10]:
                prompt += f"- **{cve.get('id','?')}** ({cve.get('severity','?')}): {cve.get('summary','')[:150]}\n"
            if len(relevant) > 10:
                prompt += f"  ... and {len(relevant) - 10} more\n"
            prompt += "\n"

    return prompt


# ---------------------------------------------------------------------------
# 1.4.2 Compute optimal concurrency
# ---------------------------------------------------------------------------

def compute_concurrency(
    work_items: list[Any],
    analyzer_count: int = 1,
) -> int:
    """
    Compute optimal concurrent workers based on workload characteristics.

    Logic:
    - Few items (≤8): run them all
    - Many small items (I/O-bound): higher concurrency
    - Few large items (CPU-bound): moderate concurrency

    Returns value between 1 and 25 (MAX_PARALLEL_TASKS).
    """
    n = len(work_items)
    total_agents = n * analyzer_count

    if total_agents <= 4:
        return max(1, total_agents)

    # Estimate average token size
    avg_tokens = 0
    count_with_tokens = 0
    for item in work_items:
        try:
            body = getattr(item, 'body', '')
            if isinstance(body, str) and body:
                from splitter import estimate_tokens
                avg_tokens += estimate_tokens(body)
                count_with_tokens += 1
        except Exception:
            pass

    if count_with_tokens > 0:
        avg_tokens //= count_with_tokens

    # Small files, many of them → I/O bound → high concurrency
    if avg_tokens < 3000 and n > 20:
        return min(12, total_agents // 2)

    # Medium files, moderate count → balanced
    if avg_tokens < 8000:
        return min(8, max(4, total_agents // 4))

    # Large files → CPU/memory bound → moderate
    return min(6, max(2, total_agents // 5))


# ---------------------------------------------------------------------------
# 1.4.3 Wave dispatch loop
# ---------------------------------------------------------------------------

def build_dispatch_plan(
    chunks: list[Any],
    analyzers: list[str],
    session_id: str,
    chunks_per_wave: int = 4,
    max_concurrency: int | None = None,
    validated_findings: list[dict] | None = None,
    cve_findings: list[dict] | None = None,
    out_of_scope: list[str] | None = None,
) -> dict:
    """
    Build a dispatch plan: wave definitions, agent tasks, and mesh protocol events.

    Does NOT actually dispatch agents (that requires subagent tool calls from the FSM).
    Returns a plan that the FSM's dispatch_handler can execute.

    Args:
        chunks: List of ResolvedChunk objects
        analyzers: List of vuln class names
        session_id: Session ID for mesh rooms
        chunks_per_wave: How many chunks to process per wave
        max_concurrency: Override computed concurrency (None = auto)

    Returns:
        Dispatch plan dict with waves, tasks, and mesh events.
    """
    if not chunks or not analyzers:
        return {"waves": [], "total_agents": 0, "total_waves": 0}

    optimal_concurrency = max_concurrency or compute_concurrency(chunks, len(analyzers))

    # Build flat task list: chunk × analyzer
    all_tasks = []
    for chunk in chunks:
        for analyzer in analyzers:
            prompt = build_worker_prompt(
                chunk, analyzer, session_id,
                validated_findings=validated_findings,
                cve_findings=cve_findings,
                out_of_scope=out_of_scope,
            )
            all_tasks.append({
                "agent": "annie",
                "task": prompt,
                "skillContext": str(_PROMPTS_DIR / f"annie-{analyzer}.md"),
                "chunk_id": chunk.chunk_id,
                "vuln_class": analyzer,
            })

    # Partition into waves
    tasks_per_wave = chunks_per_wave * len(analyzers)
    total_waves = math.ceil(len(all_tasks) / tasks_per_wave)

    waves = []
    for wave_idx in range(total_waves):
        start = wave_idx * tasks_per_wave
        end = min(start + tasks_per_wave, len(all_tasks))
        wave_tasks = all_tasks[start:end]

        # Mesh announcement
        mesh_event = {
            "event": "wave_dispatch",
            "wave": wave_idx + 1,
            "total_waves": total_waves,
            "agents": len(wave_tasks),
            "chunks": list(set(t["chunk_id"] for t in wave_tasks)),
            "analyzers": list(set(t["vuln_class"] for t in wave_tasks)),
            "concurrency": min(optimal_concurrency, len(wave_tasks)),
        }

        waves.append({
            "wave_index": wave_idx,
            "tasks": wave_tasks,
            "mesh_event": mesh_event,
        })

    return {
        "waves": waves,
        "total_agents": len(all_tasks),
        "total_waves": total_waves,
        "concurrency": optimal_concurrency,
        "chunks_per_wave": chunks_per_wave,
    }


# ---------------------------------------------------------------------------
# 1.4.4 Mesh protocol helpers
# ---------------------------------------------------------------------------

def build_mesh_join_event(agent_name: str, chunk_id: str, vuln_class: str) -> dict:
    """Build a mesh join event for a worker agent."""
    return {
        "agent": agent_name,
        "chunk_id": chunk_id,
        "vuln_class": vuln_class,
        "status": "starting",
    }


def build_mesh_complete_event(agent_name: str, findings_count: int) -> dict:
    """Build a mesh complete event."""
    return {
        "agent": agent_name,
        "status": "completed",
        "findings_count": findings_count,
    }


def build_feed_cross_chunk_hint(
    from_chunk: str,
    from_file: str,
    from_line: int,
    pattern: str,
    direction: str = "forward",
) -> dict:
    """Build a cross-chunk hint for the feed room."""
    return {
        "type": "cross_chunk_hint",
        "from_chunk": from_chunk,
        "from_file": from_file,
        "from_line": from_line,
        "pattern": pattern,
        "direction": direction,
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from unittest.mock import Mock

    # Create mock chunks
    chunk = Mock()
    chunk.chunk_id = "chunk-0"
    chunk.body = "const user = location.hash.slice(1);\ndocument.body.innerHTML = user;"
    chunk.overlap_context = ""
    chunk.metadata = {"method": "single_chunk", "chunk_index": 0, "total_chunks": 1}
    chunk.file_spans = [Mock(file_path="app.js", start_line=1, end_line=2)]

    # Test prompt building
    prompt = build_worker_prompt(chunk, "dom_xss", "test-session-001")
    assert "dom_xss" in prompt.lower()
    assert "chunk-0" in prompt
    assert "test-session-001" in prompt
    print("Prompt build: OK")

    # Test concurrency
    assert compute_concurrency([chunk, chunk], 1) == 2  # 2 agents total
    assert compute_concurrency([chunk] * 50, 3) > 4    # Many items → higher
    print("Concurrency compute: OK")

    # Test dispatch plan
    chunks = [Mock(chunk_id="c0", body="", overlap_context="", metadata={"method": "ast", "chunk_index": 0, "total_chunks": 3}, file_spans=[]) for _ in range(3)]
    plan = build_dispatch_plan(chunks, ["dom_xss", "sqli"], "sess-001", chunks_per_wave=2)
    assert plan["total_agents"] == 6  # 3 chunks × 2 analyzers
    assert plan["total_waves"] >= 1
    assert len(plan["waves"]) == plan["total_waves"]
    print(f"Dispatch plan: {plan['total_agents']} agents, {plan['total_waves']} waves, concurrency={plan['concurrency']}")

    # Test mesh events
    join = build_mesh_join_event("annie-1", "chunk-0", "dom_xss")
    assert join["agent"] == "annie-1"
    assert join["status"] == "starting"
    print("Mesh events: OK")

    print("\nAll dispatch tests passed.")
