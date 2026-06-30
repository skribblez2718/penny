# jsa — JavaScript Security Analysis

Production-grade multi-agent JavaScript security analysis skill for Pi/Penny.  
See `SKILL.md` for the full specification.

## Architecture

```
INTAKE → ACQUIRE → CVE_RESEARCH → SAST_SCAN → NORMALIZE → DEDUP_WITHIN_SOURCE
→ CORRELATE_EVIDENCE → AGENT_REVIEW → SAST_VALIDATE → CHUNK → DISPATCH
→ COLLECT → MERGE → VERIFY → REPORT → REFLECT → COMPLETED
```

- **Deterministic correlation layer**: Components, vulnerabilities, and SAST findings are deduplicated independently then linked via explicit typed edges. Agents only review ambiguous edges (score 0.45-0.85) via bounded evidence packets.
- **Concatenation model**: All JS files → one stream → uniform chunks → per-chunk parallel agents
- **Specialized agents**: One agent per vuln class per chunk, all running concurrently
- **MemPalace-native**: All inter-agent communication via `wing_jsa` rooms

> A temporary interactive checkpoint (STOP) may be inserted between
> SAST VALIDATE and CHUNK in interactive mode. It is **not a permanent
> pipeline phase**.

## Directory Structure

```
jsa/
├── SKILL.md                    # Skill specification
├── README.md                   # This file
├── scripts/
│   ├── fsm.py                  # Generalized pipeline FSM
│   ├── splitter.py             # split_js_multi() — concatenate + chunk + resolve
│   ├── dedup.py                # Merge/dedup engine
│   ├── dispatch.py             # Wave-based parallel dispatch
│   └── analyzers/              # Per-vuln-class VulnerabilityAnalyzer implementations
│       ├── base.py             # Abstract interface
│       ├── dom_xss.py
│       ├── prototype_pollution.py
│       └── ... (21 total)
├── assets/
│   ├── prompts/
│   │   ├── worker-base.md      # Shared worker protocol
│   │   ├── analyze-dom_xss.md  # Expert-level DOM XSS analysis guide
│   │   └── ...                 # One analyze guide per vuln class
│   └── payloads/
│       ├── xss.json
│       └── ...
└── tests/
```

## Implementation Status

| Phase | Status |
|-------|--------|
| Architecture & Design | ✅ Complete (see `plans/jsa-implementation/`) |
| Subagent extension changes | 📋 Planned (`MAX_PARALLEL_TASKS` → 25, `maxConcurrency` param) |
| Vulnerability research (21 classes) | 🔄 Starting — DOM XSS first |
| FSM implementation | 📋 Pending |
| Splitter implementation | 📋 Pending |
| Dedup engine implementation | 📋 Pending |
| Analyzer implementations | 📋 Pending (post-research) |
| Convenience skill wrappers | 📋 Pending |
| Testing | 📋 Pending |

## Development

```bash
# Run tests
cd .pi/skills/jsa
python -m pytest tests/ -v

# Run a single analyzer manually
python scripts/analyzers/dom_xss.py --file test/fixtures/vulnerable.js
```
