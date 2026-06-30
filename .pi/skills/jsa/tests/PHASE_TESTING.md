# Per-Phase Functionality Tests

Test each JSA pipeline phase in isolation — no need to run the entire
18-phase pipeline to find or fix a bug.

Tests are aligned with the design documented in `~/Downloads/jsa-sast.md`.

## Quick Start

```bash
# Test all 87 per-phase tests
pytest .pi/skills/jsa/tests/test_phase_functionality.py -v

# Test just one phase
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestCveResearchPhase -v
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestSastScanPhase -v
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestSastValidatePhase -v
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestIntakePhase -v
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestAgentReviewPhase -v

# Test one specific test
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestCveResearchPhase::test_purl_generated_for_detected_component -v
```

## How It Works

The test file uses a `PhaseTestHelper` class that:

1. **Creates a fresh state** in a temp directory
2. **Pre-populates** `state.metadata` with realistic inputs for the
   target phase (so you don't need to run all previous phases)
3. **Runs only the target phase handler** in isolation
4. **Returns the state** for assertions

This means you can test any phase in **under 1 second** without running
the full pipeline.

## Phases Covered

Tests are aligned with `~/Downloads/jsa-sast.md` design document.

| Phase | Test Class | # Tests |
|-------|------------|---------|
| INTAKE | `TestIntakePhase` | 7 |
| ACQUIRE | `TestAcquirePhase` | 5 |
| CVE_RESEARCH | `TestCveResearchPhase` | 16 |
| SAST_SCAN | `TestSastScanPhase` | 14 |
| NORMALIZE | `TestNormalizePhase` | 7 |
| DEDUP_WITHIN_SOURCE | `TestDedupWithinSourcePhase` | 4 |
| CORRELATE_EVIDENCE | `TestCorrelateEvidencePhase` | 7 |
| AGENT_REVIEW | `TestAgentReviewPhase` | 7 |
| SAST_VALIDATE | `TestSastValidatePhase` | 17 |
| **Cross-phase** | `TestPhaseIsolation` | 3 |
| **Total** | | **87** |

## Usage Patterns

### Pattern 1: Test a phase with no prior state
```python
def test_happy_path(self, helper):
    state = helper.fresh_state(target_url="https://example.com",
                               analyzers=["dom_xss"])
    result = helper.run(JSAPhase.INTAKE, state)
    assert result.metadata["intake_completed"] is True
```

### Pattern 2: Test a phase with realistic pre-populated state
```python
def test_correlates_evidence(self, helper):
    state = helper.state_after(JSAPhase.CORRELATE_EVIDENCE)
    # state.metadata["dedup"] is now pre-populated with realistic edges
    result = helper.run(JSAPhase.CORRELATE_EVIDENCE, state)
    assert len(result.metadata["dedup"]["edges"]) > 0
```

### Pattern 3: Test edge cases
```python
def test_handles_empty_findings(self, helper):
    state = helper.state_after(JSAPhase.SAST_VALIDATE)
    state.sast_findings = []
    result = helper.run(JSAPhase.SAST_VALIDATE, state)
    assert result.metadata["sast_validate"]["total"] == 0
```

### Pattern 4: Test error handling
```python
def test_handles_malformed_js(self, helper):
    state = helper.state_after(JSAPhase.CVE_RESEARCH)
    bad_file = state.js_dir / "malformed.js"
    bad_file.write_text("\x00\x01\x02\x03")  # Binary garbage
    result = cve_research_handler(state)  # Should not crash
    assert "cve_research" in result.metadata
```

## Debugging a Specific Phase Bug

When `run_pipeline()` fails deep in the pipeline, you can:

1. **Find the failing phase** from the error message
2. **Test just that phase** using the helper
3. **Fix the bug** in `scripts/fsm.py` (or related modules)
4. **Re-run that phase's tests** to verify the fix
5. **Re-run the full pipeline** to confirm no regressions

### Example: Debug CVE_RESEARCH failure

```bash
# Pipeline failed in CVE_RESEARCH. Test it directly:
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestCveResearchPhase -v

# Find the specific test that fails, fix the bug in fsm.py, then:
pytest .pi/skills/jsa/tests/test_phase_functionality.py::TestCveResearchPhase::test_specific -v

# Once fixed, re-run full pipeline to confirm no regression:
pytest .pi/skills/jsa/tests/ -v
```

## CLI Helper

Run a single phase for manual testing from the command line:

```bash
# Show what happens when CVE_RESEARCH runs on a fresh state
python -m tests.test_phase_functionality CVE_RESEARCH
```

Output:
```
Phase: CVE_RESEARCH
State metadata keys: ['cve_research', 'intake_completed', ...]
Updated at: 2026-06-08T...
```

## What Each Test Class Verifies

For each phase, tests cover:

- **Happy path**: Typical input → expected output
- **Empty input**: No findings, no tech stack, etc.
- **Edge cases**: Inline scripts, malformed JS, empty CVEs
- **State mutations**: What changes in `state.metadata`
- **Output validation**: Phase produces correct shape and content
- **Isolation**: No hidden dependencies on other phases

## Extending

To add a new test for any phase:

```python
class TestNewPhaseScenario:
    def test_my_scenario(self, helper):
        state = helper.state_after(JSAPhase.YOUR_PHASE)
        # Set up specific state
        state.some_field = "specific value"
        # Run the phase
        result = helper.run(JSAPhase.YOUR_PHASE, state)
        # Assert
        assert result.metadata["your_key"] == "expected"
```

## Why This Matters

**Before per-phase tests:**
- Bug in phase 7 → run all 18 phases (~2 minutes)
- Hard to isolate which phase is causing the failure
- Hard to test edge cases without manual setup

**After per-phase tests:**
- Bug in phase 7 → run only phase 7 tests (<1 second)
- Clear which phase is failing
- Easy to test any edge case with one-liner helpers

## Structure-and-Slice Migration (Phase B–E, 2026-06)

The pipeline was refactored from the old "concatenate + chunk + dispatch" anti-pattern
to the structure-and-slice architecture per `agent-augmented-security-annalysis.md`.

### Test Counts (as of 2026-06-10)

| Phase | Test File | Tests | Description |
|-------|-----------|-------|-------------|
| ACQUIRE | `test_fsm.py` (TestAcquireHandler, TestRunPipeline) | 4 | ACQUIRE + _do_acquire + run_pipeline |
| STRUCTURE | `test_structure_analysis.py`, `test_phase_c_handlers.py` | 74 | ModuleCard/PageCard builders, dangerous pattern extraction |
| SLICE | `test_phase_c_handlers.py` | 38 | Full SLICE handler with vuln class inference |
| INVESTIGATE | `test_investigate_handler.py` | 14 | Per-lane work item generation, packet types |
| Full pipeline | `test_e2e_pipeline.py` | 18 | E2E pipeline integration tests |
| Other phases | (other test files) | 781 | Per-phase + per-module tests |
| **Total** | — | **929** | — |

### Key Architectural Changes

- **CHUNK phase removed.** The old `chunk_handler` is a no-op stub.
- **DISPATCH renamed to INVESTIGATE.** Consumes `FlowCard` records, not raw chunks.
- **Typed analysis store.** `state.typed_store` holds manifest + AST indexes.
- **PageCard / ModuleCard / FlowCard records.** Replaces chunks as the primary work units.
- **Three-lane dispatch.** `code_static` / `page_dom` / `network_behavior` with different packet types.
- **Per-vuln-class lane assignments.** 22 annie prompts declare their lane.

### Verification Commands

```bash
# Run all tests
.venv/bin/python -m pytest .pi/skills/jsa/tests/ -q

# Run end-to-end pipeline tests
.venv/bin/python -m pytest .pi/skills/jsa/tests/test_e2e_pipeline.py -v

# Run investigate handler tests
.venv/bin/python -m pytest .pi/skills/jsa/tests/test_investigate_handler.py -v
```

