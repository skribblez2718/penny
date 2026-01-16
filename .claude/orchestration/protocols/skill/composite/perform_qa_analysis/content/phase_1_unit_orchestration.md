# Phase 1: Unit Test Orchestration

**Objective:** Execute unit tests with coverage measurement and validate against quality gate G2.

## Agent Invocation

You will invoke the **generation** agent to orchestrate unit test execution.

## Context to Provide

Load from Phase 0 memory:
- Platform ID
- Test paths
- Quality gate thresholds (unit_coverage, unit_pass_rate)
- Pyramid ratios (for compliance check)

## Agent Prompt Template

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** task-perform-qa-analysis-unit
- **Skill:** perform-qa-analysis
- **Phase:** 1
- **Domain:** technical
- **Agent:** generation

## Role Extension

Focus on:
- Discovering unit test files
- Executing unit test suite with coverage
- Measuring code coverage percentage
- Capturing test results (pass/fail)
- Documenting failed tests with details

## Prior Context

From Phase 0:
- Platform: {platform_id}
- Test Paths: {test_paths}
- Unit Coverage Threshold: {unit_coverage}
- Unit Pass Rate Threshold: {unit_pass_rate}

## Task Instructions

### 1. Discover Unit Tests

Identify unit test files using platform conventions:
- **Web (JS/TS):** `*.test.js`, `*.spec.js`, `*.test.ts`, `*.spec.ts`
- **Python:** `test_*.py`, `*_test.py`
- **Java:** `*Test.java`
- **Go:** `*_test.go`

**Actions:**
- List all discovered unit test files
- Count total unit tests
- Verify pyramid ratio compliance (should be ~70% of all tests)

### 2. Execute Unit Tests

Run platform-appropriate test command with coverage:

**Web:**
```bash
npm test -- --coverage --watchAll=false
# or
npx jest --coverage
```

**Python:**
```bash
pytest --cov --cov-report=term-missing
```

**Java:**
```bash
./gradlew test jacocoTestReport
# or
mvn test jacoco:report
```

**Go:**
```bash
go test -cover ./...
```

**Actions:**
- Execute test command
- Capture stdout/stderr
- Parse test results
- Extract coverage metrics

### 3. Measure Coverage

Extract coverage percentage from test output or coverage report.

**Metrics to capture:**
- Overall coverage percentage
- Statement coverage
- Branch coverage
- Function coverage
- Uncovered files/lines (if coverage < threshold)

### 4. Validate Results

Calculate:
- Total tests: {count}
- Passed tests: {count}
- Failed tests: {count}
- Pass rate: {passed / total}
- Coverage: {percentage}%

For each failed test, document:
- Test name
- Error message
- Stack trace
- File location

### 5. Quality Gate G2 Validation

**Criteria:**
- Coverage ≥ {unit_coverage} (default: 80%)
- Pass rate = 100%

**Validation:**
- [ ] Coverage meets threshold
- [ ] All tests passing
- [ ] No test execution errors

**If G2 fails:**
- Document failure reason
- List failed tests
- Identify uncovered code
- Provide recommendations

## Related Research Terms
- unit testing
- code coverage
- Jest coverage
- pytest-cov
- JaCoCo
- test execution
- test discovery
- coverage threshold
- pass rate metrics
- TDD

## Output Requirements

**Memory File:** `.claude/memory/task-perform-qa-analysis-unit-memory.md`

**Structure:**
```markdown
## Unit Test Results

**Discovery:**
- Total unit tests: {count}
- Test files: {list}
- Pyramid compliance: {percentage}% of total tests

**Execution:**
- Command: {command}
- Duration: {seconds}s
- Exit code: {code}

**Coverage:**
- Overall: {percentage}%
- Statements: {percentage}%
- Branches: {percentage}%
- Functions: {percentage}%
- Uncovered: {list of files/lines}

**Results:**
- Total: {count}
- Passed: {count}
- Failed: {count}
- Pass rate: {percentage}%

**Failed Tests:**
{if any}
- Name: {test_name}
  Error: {error_message}
  Location: {file}:{line}

**Quality Gate G2:**
- Status: PASS | FAIL
- Coverage threshold: {threshold}% (actual: {actual}%)
- Pass rate threshold: 100% (actual: {actual}%)
- Blocking: {true if failed}

**Recommendations:**
{if G2 failed}
- Increase coverage in: {files}
- Fix failing tests: {list}
```
```

## Quality Gate G2

**Criteria:**
- Coverage ≥ 80% (or custom threshold)
- Pass rate = 100%

**Actions:**
- If G2 passes: Proceed to Phase 2
- If G2 fails: HALT with recommendations

## Next Phase

Upon successful unit test execution and G2 validation, advance to **Phase 2: Integration Orchestration**.
