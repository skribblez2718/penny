# Phase F0: Python Engine Foundation

**Status:** Design (2026-06-10)
**Goal:** Build 22 deterministic Python analyzer engines that produce structured `Finding` objects from `FlowCard` records.

## Architecture Overview

```
analyzers/
├── __init__.py                  # Public API
├── base.py                      # BaseEngine abstract class
├── registry.py                  # Engine registry + lane mapping
├── runner.py                    # Parallel execution engine
├── confidence.py                # Confidence scoring
├── finding.py                   # Finding extensions (extends dedup.Finding)
│
├── code_static/                 # Lane 1: 13 engines
│   ├── __init__.py
│   ├── dom_xss.py               # ← Proof of concept
│   ├── prototype_pollution.py
│   ├── csti.py
│   ├── postmessage.py
│   ├── open_redirect.py
│   ├── secret_disclosure.py
│   ├── request_override.py
│   ├── link_manipulation.py
│   ├── dom_data_manipulation.py
│   ├── ssrf.py
│   ├── sqli.py
│   ├── insecure_deserialization.py
│   └── http_header_injection.py
│
├── page_dom/                    # Lane 2: 4 engines
│   ├── __init__.py
│   ├── dom_clobbering.py
│   ├── reflected_xss.py
│   └── stored_xss.py
│
└── network_behavior/            # Lane 3: 5 engines
    ├── __init__.py
    ├── cors.py
    ├── clickjacking.py
    ├── idor.py
    ├── cache_poisoning.py
    ├── http_smuggling.py
    └── csrf.py
```

## Base Engine Interface

```python
class BaseEngine:
    """Abstract base for all vuln-class analyzers."""

    # Class attributes (override in subclass)
    vuln_class: str = ""            # e.g., "dom_xss"
    lane: str = ""                  # e.g., "code_static"
    cwe_id: str = ""                # e.g., "CWE-79"
    description: str = ""

    @abstractmethod
    def analyze(self, flow_card: FlowCard, **context) -> list[Finding]:
        """
        Analyze a FlowCard and return 0+ Finding objects.

        Args:
            flow_card: The data flow to analyze
            **context: Additional context (page_card, module_card, etc.)

        Returns:
            List of Finding objects (empty if no vulnerability)
        """
        pass

    def can_handle(self, flow_card: FlowCard) -> bool:
        """Return True if this engine can analyze the given FlowCard."""
        return flow_card.vulnerability_class == self.vuln_class
```

## Finding Schema (extends dedup.Finding)

```python
@dataclass
class Finding(dedup.Finding):
    """Extended Finding with confidence and verification hints."""

    # Engine provenance
    engine: str = ""                # e.g., "dom_xss_v1"
    engine_version: str = "1.0.0"

    # Confidence scoring
    confidence: str = "candidate"   # candidate | low | medium | high | confirmed
    confidence_score: float = 0.0   # 0.0-1.0 raw score

    # LLM verification hints
    needs_llm_verify: bool = False
    needs_llm_deep: bool = False    # Multi-step chain or context-dependent
    llm_packet_path: Optional[str] = None  # Pre-built packet file

    # Evidence quality
    has_sast_match: bool = False
    has_joern_flow: bool = False
    has_runtime_evidence: bool = False

    # Context for verification
    sanitizer_count: int = 0
    taint_hops: int = 1
    in_user_facing_function: bool = False
```

## Confidence Scoring

```python
def score_confidence(finding: Finding) -> float:
    """
    Calculate confidence score (0.0-1.0).

    High score = strong evidence, simple pattern, no sanitizers.
    Low score = weak evidence, complex chain, many sanitizers.
    """
    score = 0.5  # baseline

    # +0.3 if SAST tool also flagged it
    if finding.has_sast_match:
        score += 0.15

    # +0.2 if Joern data flow confirms taint path
    if finding.has_joern_flow:
        score += 0.2

    # +0.1 if runtime evidence (Playwright/Caido captured it)
    if finding.has_runtime_evidence:
        score += 0.1

    # -0.1 per sanitizer in chain (min 0)
    score -= 0.1 * finding.sanitizer_count

    # -0.05 per taint hop beyond first (multi-step = harder to verify)
    if finding.taint_hops > 1:
        score -= 0.05 * (finding.taint_hops - 1)

    # +0.1 if in a user-facing function (more likely to be reachable)
    if finding.in_user_facing_function:
        score += 0.1

    return max(0.0, min(1.0, score))
```

## Confidence Levels

| Score Range | Level | LLM Action |
|---|---|---|
| 0.85-1.0 | `confirmed` | None (ship as-is) |
| 0.65-0.85 | `high` | Spot-check 20% with LLM |
| 0.45-0.65 | `medium` | LLM verify all |
| 0.25-0.45 | `low` | LLM verify + deep analysis |
| 0.0-0.25 | `candidate` | LLM deep analysis required |

## Execution Model

```python
class AnalyzerRunner:
    """Run engines in parallel across all FlowCards."""

    def __init__(self, max_workers: int = 8):
        self.max_workers = max_workers
        self.registry = EngineRegistry()

    def analyze_flow_cards(
        self,
        flow_cards: list[FlowCard],
        page_cards: list[PageCard] = None,
        module_cards: list[ModuleCard] = None,
    ) -> list[Finding]:
        """
        Analyze all flow cards in parallel.

        Returns:
            List of Finding objects (deduplicated, with confidence scores)
        """
        # Group flow cards by vuln class
        cards_by_class = defaultdict(list)
        for fc in flow_cards:
            cards_by_class[fc.vulnerability_class].append(fc)

        # Run each engine in parallel
        with ProcessPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []
            for vuln_class, cards in cards_by_class.items():
                engine = self.registry.get_engine(vuln_class)
                if engine:
                    future = executor.submit(
                        engine.bulk_analyze, cards, page_cards, module_cards
                    )
                    futures.append(future)

            # Collect results
            all_findings = []
            for future in as_completed(futures):
                all_findings.extend(future.result())

        return all_findings
```

## Test Strategy

Each engine has:
- Unit tests (synthetic vulnerable code)
- Integration tests (real FlowCards)
- False positive tests (safe code that looks vulnerable)
- Performance tests (large file handling)

## Implementation Order

1. **F0.1: Base infrastructure** (Day 1)
   - `base.py`, `registry.py`, `confidence.py`, `finding.py`
   - Test harness

2. **F0.2: dom_xss engine** (Day 1) ← **Proof of concept**
   - Most important vuln class (highest finding rate)
   - Tests pattern matching, sanitizers, taint analysis

3. **F0.3: code_static lane** (Days 2-4)
   - 12 more engines (prototype_pollution, sqli, ssrf, etc.)
   - All follow dom_xss template

4. **F0.4: page_dom lane** (Day 5)
   - 4 engines
   - Requires PageCard integration

5. **F0.5: network_behavior lane** (Days 6-7)
   - 5 engines
   - Requires Caido integration

6. **F0.6: Runner + integration** (Day 7)
   - Parallel execution
   - Wire into `investigate_handler`
   - Update tests

## Integration with INVESTIGATE

```python
def investigate_handler(state: JSAState) -> JSAState:
    """INVESTIGATE phase: per-lane work item generation + analysis."""

    # ... existing work item generation ...

    # NEW: Run Python engines in parallel
    from analyzers import AnalyzerRunner
    runner = AnalyzerRunner(max_workers=8)
    findings = runner.analyze_flow_cards(
        flow_cards=state.flow_cards,
        page_cards=state.page_cards,
        module_cards=state.module_cards,
    )

    # Store findings for LLM verification (Phase F2)
    state.raw_findings.extend(findings)

    # ... rest of handler ...
```

## Out of Scope for F0

- LLM verification (F2)
- Deep analysis pass (F3)
- Cross-finding correlation (F4)
- Auto-PoC generation (F5)
- Confidence promotion (handled by existing dedup)

## Success Criteria

- [ ] All 22 engines implemented
- [ ] 95%+ pattern match accuracy on synthetic tests
- [ ] Runs in <5 minutes for 200-file target
- [ ] Outputs structured Finding objects with confidence
- [ ] Integration test: 200-file target → 500+ findings, 70%+ high-confidence
- [ ] Zero false positives on false-positive test suite
