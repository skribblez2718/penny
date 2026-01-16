# Phase 2: Integration Test Orchestration

**Objective:** Execute integration tests and validate against quality gate G3a.

## Agent Invocation

You will invoke the **generation** agent to orchestrate integration test execution.

## Context to Provide

Load from Phase 0 and Phase 1 memory:
- Platform ID
- Test paths
- Quality gate threshold (integration_pass_rate)
- Unit test results (for pyramid compliance)

## Agent Prompt Template

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** task-perform-qa-analysis-integration
- **Skill:** perform-qa-analysis
- **Phase:** 2
- **Domain:** technical
- **Agent:** generation

## Role Extension

Focus on:
- Discovering integration test files
- Executing integration test suite
- Capturing test results (pass/fail)
- Documenting failed tests with details
- Verifying pyramid ratio compliance

## Prior Context

From Phase 0:
- Platform: {platform_id}
- Test Paths: {test_paths}
- Integration Pass Rate Threshold: {integration_pass_rate}

From Phase 1:
- Unit test count: {count}
- Expected integration ratio: ~20% of total tests

## Task Instructions

### 1. Discover Integration Tests

Identify integration test files using platform conventions:
- **Web:** `*.integration.test.js`, `*.integration.spec.ts`, files in `integration/` dir
- **Python:** `test_integration_*.py`, files in `tests/integration/`
- **Java:** `*IntegrationTest.java`, files in `src/integration-test/`
- **Go:** `*_integration_test.go` with build tag `// +build integration`

**Actions:**
- List all discovered integration test files
- Count total integration tests
- Verify pyramid ratio compliance (should be ~20% of all tests)

### 2. Execute Integration Tests

Run platform-appropriate integration test command:

**Web:**
```bash
npm run test:integration
# or
npx jest --testPathPattern=integration
```

**Python:**
```bash
pytest tests/integration/
# or
pytest -m integration
```

**Java:**
```bash
./gradlew integrationTest
# or
mvn verify -Pintegration-tests
```

**Go:**
```bash
go test -tags=integration ./...
```

**Actions:**
- Execute test command
- Capture stdout/stderr
- Parse test results
- Handle environment setup/teardown

### 3. Environment Considerations

Integration tests may require:
- Database connections
- External service mocks
- Environment variables
- Docker containers

**Actions:**
- Check for docker-compose.yml (test dependencies)
- Verify required services are running
- Document environment setup
- Clean up after execution

### 4. Validate Results

Calculate:
- Total tests: {count}
- Passed tests: {count}
- Failed tests: {count}
- Pass rate: {passed / total}

For each failed test, document:
- Test name
- Error message
- Stack trace
- File location
- Environment state (if relevant)

### 5. Quality Gate G3a Validation

**Criteria:**
- Pass rate = 100%

**Validation:**
- [ ] All tests passing
- [ ] No test execution errors
- [ ] Environment properly configured

**If G3a fails:**
- Document failure reason
- List failed tests
- Identify environment issues
- Provide recommendations

## Related Research Terms
- integration testing
- service integration
- API testing
- database testing
- test environment
- docker-compose
- test isolation
- integration test patterns
- service mocking
- test fixtures

## Output Requirements

**Memory File:** `.claude/memory/task-perform-qa-analysis-integration-memory.md`

**Structure:**
```markdown
## Integration Test Results

**Discovery:**
- Total integration tests: {count}
- Test files: {list}
- Pyramid compliance: {percentage}% of total tests

**Environment:**
- Services required: {list}
- Docker containers: {list}
- Environment variables: {list}
- Setup duration: {seconds}s

**Execution:**
- Command: {command}
- Duration: {seconds}s
- Exit code: {code}

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
  Environment: {state}

**Quality Gate G3a:**
- Status: PASS | FAIL
- Pass rate threshold: 100% (actual: {actual}%)
- Blocking: {true if failed}

**Recommendations:**
{if G3a failed}
- Fix failing tests: {list}
- Verify environment: {services}
- Check service health: {endpoints}
```
```

## Quality Gate G3a

**Criteria:**
- Pass rate = 100%

**Actions:**
- If G3a passes: Proceed to Phase 3
- If G3a fails: HALT with recommendations

## Next Phase

Upon successful integration test execution and G3a validation, advance to **Phase 3: E2E Orchestration**.
