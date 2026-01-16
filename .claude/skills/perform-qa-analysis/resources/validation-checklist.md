# Validation Checklist: perform-qa-analysis

Use this checklist to validate successful execution of the perform-qa-analysis skill.

## Phase 0: Clarification

- [ ] Platform identified (web|mobile|desktop|api)
- [ ] Mode set (testing|standalone|full)
- [ ] Pyramid ratios configured or defaults accepted
- [ ] Quality gate thresholds defined
- [ ] Playwright MCP connection verified (if web platform)
- [ ] Test discovery paths identified

## Phase 1: Unit Orchestration

- [ ] Unit test suite discovered
- [ ] Unit tests executed successfully
- [ ] Code coverage measured
- [ ] Coverage ≥80% (G2 criterion)
- [ ] Pass rate = 100% (G2 criterion)
- [ ] Coverage report generated
- [ ] Failed tests documented (if any)

## Phase 2: Integration Orchestration

- [ ] Integration test suite discovered
- [ ] Integration tests executed successfully
- [ ] Pass rate = 100% (G3a criterion)
- [ ] Test execution logs captured
- [ ] Failed tests documented (if any)

## Phase 3: E2E Orchestration

- [ ] E2E test suite discovered
- [ ] Playwright MCP tools available (if web)
- [ ] E2E tests executed successfully
- [ ] Pass rate = 100% (G3b criterion)
- [ ] Screenshots captured for failures (if any)
- [ ] Console/network logs captured (if web)
- [ ] Failed tests documented (if any)

## Phase 4: Quality Synthesis

- [ ] All test results aggregated
- [ ] Quality score calculated
- [ ] Quality score ≥0.75 (G4 criterion)
- [ ] Pyramid ratio compliance checked
- [ ] Quality report generated
- [ ] Recommendations provided (if quality gates failed)

## Overall Validation

- [ ] All quality gates (G1-G4) passed
- [ ] Memory file created at `.claude/memory/task-perform-qa-analysis-{session}-memory.md`
- [ ] Test metrics documented
- [ ] Failed tests have actionable details
- [ ] Report ready for stakeholder review

## Quality Gate Summary

| Gate | Criterion | Status | Notes |
|------|-----------|--------|-------|
| G1 | Requirements validated | ☐ Pass ☐ Fail | |
| G2 | Unit tests: ≥80% coverage, 100% pass | ☐ Pass ☐ Fail | |
| G3a | Integration tests: 100% pass | ☐ Pass ☐ Fail | |
| G3b | E2E tests: 100% pass | ☐ Pass ☐ Fail | |
| G4 | Quality score ≥0.75 | ☐ Pass ☐ Fail | |

## Troubleshooting

**If G2 fails:**
- Review unit test coverage report
- Identify uncovered code paths
- Run: `npm test -- --coverage` or `pytest --cov`

**If G3a/G3b fails:**
- Review test execution logs
- Check environment configuration
- Verify test data availability

**If G4 fails:**
- Review quality score breakdown
- Identify weakest test layer
- Prioritize improvements by impact

**If Playwright MCP unavailable (web):**
- Verify Claude Desktop MCP configuration
- Restart Claude Desktop
- Use fallback: `npx playwright test` with manual log capture
