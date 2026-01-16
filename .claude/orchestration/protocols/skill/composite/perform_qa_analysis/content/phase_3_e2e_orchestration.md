# Phase 3: E2E Test Orchestration

**Objective:** Execute end-to-end tests with platform-specific tooling and validate against quality gate G3b.

## Agent Invocation

You will invoke the **generation** agent to orchestrate E2E test execution.

## Critical Platform Requirement

**If platform = web:**
- **Playwright MCP REQUIRED**
- Must verify MCP connection before proceeding
- If MCP unavailable → BLOCK with error and setup instructions

## Context to Provide

Load from Phase 0, Phase 1, and Phase 2 memory:
- Platform ID
- Test paths
- Quality gate threshold (e2e_pass_rate)
- MCP availability status (if web)
- Unit and integration test counts (for pyramid compliance)

## Agent Prompt Template

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** task-perform-qa-analysis-e2e
- **Skill:** perform-qa-analysis
- **Phase:** 3
- **Domain:** technical
- **Agent:** generation

## Role Extension

Focus on:
- Verifying Playwright MCP availability (if web)
- Discovering E2E test files
- Executing E2E test suite
- Capturing screenshots for failures
- Capturing console/network logs (if web)
- Documenting failed tests with rich diagnostics

## Prior Context

From Phase 0:
- Platform: {platform_id}
- Test Paths: {test_paths}
- E2E Pass Rate Threshold: {e2e_pass_rate}
- MCP Available: {mcp_available}

From Phase 1 & 2:
- Unit test count: {count}
- Integration test count: {count}
- Expected E2E ratio: ~10% of total tests

## Task Instructions

### 1. Platform-Specific Setup

**If platform = web:**
- Verify Playwright MCP connection
- Check MCP tools available:
  - `mcp__playwright__browser_console_messages`
  - `mcp__playwright__browser_network_requests`
  - `mcp__playwright__browser_take_screenshot`
  - `mcp__playwright__browser_snapshot`
- If MCP unavailable → HALT with error:
  ```
  ERROR: Playwright MCP required for web E2E tests

  Setup Instructions:
  1. Open Claude Desktop settings
  2. Configure Playwright MCP server
  3. Restart Claude Desktop
  4. Re-run /perform-qa-analysis

  Alternatively, run tests manually:
  npx playwright test
  ```

**If platform = mobile:**
- Verify mobile test framework (Detox, Appium, etc.)
- Check emulator/simulator availability

**If platform = desktop:**
- Verify desktop test framework (Spectron, etc.)

**If platform = api:**
- E2E tests are comprehensive API flows
- No special MCP requirements

### 2. Discover E2E Tests

Identify E2E test files using platform conventions:
- **Web:** `*.e2e.test.js`, `*.e2e.spec.ts`, files in `e2e/` or `tests/e2e/`
- **Mobile:** Files in `e2e/` with `.spec.js` or `.test.js`
- **Desktop:** Files in `e2e/` or `tests/e2e/`
- **API:** `*.e2e.test.js`, comprehensive API workflow tests

**Actions:**
- List all discovered E2E test files
- Count total E2E tests
- Verify pyramid ratio compliance (should be ~10% of all tests)

### 3. Execute E2E Tests

Run platform-appropriate E2E test command:

**Web (Playwright MCP):**
```bash
npx playwright test
# or
npm run test:e2e
```

**Mobile (Detox example):**
```bash
detox test --configuration ios.sim.debug
```

**Desktop (Spectron example):**
```bash
npm run test:e2e
```

**API:**
```bash
npm run test:api:e2e
# or
pytest tests/api/e2e/
```

**Actions:**
- Execute test command
- Capture stdout/stderr
- Parse test results
- Handle browser/app startup

### 4. Capture Diagnostics (Web with MCP)

For each failed test (if platform = web):

**Use Playwright MCP tools:**
```
mcp__playwright__browser_take_screenshot
  → Save to: ./test-results/screenshots/{test_name}.png

mcp__playwright__browser_console_messages
  → Capture console errors/warnings

mcp__playwright__browser_network_requests
  → Capture failed network requests

mcp__playwright__browser_snapshot
  → Capture DOM snapshot for debugging
```

**For other platforms:**
- Use platform-native screenshot capture
- Capture logs from test output
- Save artifacts to test-results/

### 5. Validate Results

Calculate:
- Total tests: {count}
- Passed tests: {count}
- Failed tests: {count}
- Pass rate: {passed / total}

For each failed test, document:
- Test name
- Error message
- Stack trace
- Screenshot path (if available)
- Console errors (if web)
- Failed network requests (if web)
- File location

### 6. Quality Gate G3b Validation

**Criteria:**
- Pass rate = 100%

**Validation:**
- [ ] All tests passing
- [ ] No test execution errors
- [ ] Diagnostics captured for any failures

**If G3b fails:**
- Document failure reason
- List failed tests with screenshots
- Identify common failure patterns
- Provide recommendations

## Related Research Terms
- end-to-end testing
- Playwright MCP
- E2E test orchestration
- browser automation
- mobile E2E testing
- screenshot capture
- console logging
- network inspection
- test diagnostics
- visual regression

## Output Requirements

**Memory File:** `.claude/memory/task-perform-qa-analysis-e2e-memory.md`

**Structure:**
```markdown
## E2E Test Results

**Platform:** {platform_id}

**MCP Status:** {if web}
- Playwright MCP: {connected|disconnected}
- Tools available: {list}

**Discovery:**
- Total E2E tests: {count}
- Test files: {list}
- Pyramid compliance: {percentage}% of total tests

**Execution:**
- Command: {command}
- Duration: {seconds}s
- Exit code: {code}
- Browser/App: {name and version}

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
  Screenshot: {path}
  Console Errors: {list}  # if web
  Failed Requests: {list}  # if web

**Diagnostics Captured:**
- Screenshots: {count} files in ./test-results/screenshots/
- Console logs: {count} errors, {count} warnings
- Network logs: {count} failed requests
- DOM snapshots: {count} files

**Quality Gate G3b:**
- Status: PASS | FAIL
- Pass rate threshold: 100% (actual: {actual}%)
- Blocking: {true if failed}

**Recommendations:**
{if G3b failed}
- Fix failing tests: {list}
- Investigate console errors: {patterns}
- Fix network issues: {endpoints}
- Review screenshots: {paths}
```
```

## Quality Gate G3b

**Criteria:**
- Pass rate = 100%

**Actions:**
- If G3b passes: Proceed to Phase 4
- If G3b fails: HALT with recommendations

## Error Handling

**If MCP unavailable (web platform):**
```
HALT with error:

ERROR: Playwright MCP connection required for web E2E tests

Current Status: Not connected

Setup Instructions:
1. Open Claude Desktop
2. Go to Settings → Developer → Model Context Protocol
3. Add Playwright MCP server configuration
4. Restart Claude Desktop
5. Verify connection: Tools should show mcp__playwright__* entries
6. Re-run /perform-qa-analysis

Fallback Option:
Run tests manually and provide results:
  npx playwright test
  npx playwright show-report
```

## Next Phase

Upon successful E2E test execution and G3b validation, advance to **Phase 4: Quality Synthesis**.
