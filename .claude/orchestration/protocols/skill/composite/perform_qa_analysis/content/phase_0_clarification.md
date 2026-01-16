# Phase 0: Requirements Clarification

**Objective:** Clarify QA scope, platform, quality thresholds, and execution mode before test orchestration.

## Agent Invocation

You will invoke the **clarification** agent to resolve ambiguities in the QA request.

## Context to Provide

When invoking the clarification agent, include:

1. **Platform Identification**
   - Is this web, mobile, desktop, or API?
   - If unclear, infer from project structure (package.json → web, build.gradle → mobile, etc.)
   - Default: Analyze current directory for platform indicators

2. **Execution Mode**
   - `testing`: Run existing tests only
   - `standalone`: Run tests + generate report
   - `full`: Run tests + validate gates + generate report + recommendations
   - Default: `full`

3. **Pyramid Ratio Configuration**
   - Should default 70/20/10 (unit/integration/e2e) be used?
   - Are there project-specific requirements?
   - Validate ratios sum to 1.0

4. **Quality Gate Thresholds**
   - Use defaults (80% coverage, 100% pass rates, 0.75 quality score)?
   - Are there custom thresholds defined in project config?

5. **Platform-Specific Requirements**
   - **If web:** Verify Playwright MCP connection available
   - **If mobile:** Identify test framework (Detox, Appium, etc.)
   - **If desktop:** Identify test framework (Spectron, etc.)
   - **If API:** Identify test framework (Jest, pytest, etc.)

## Clarification Questions Template

```markdown
# Agent Invocation: clarification

## Task Context
- **Task ID:** task-perform-qa-analysis-clarification
- **Skill:** perform-qa-analysis
- **Phase:** 0
- **Domain:** technical
- **Agent:** clarification

## Role Extension

Focus on resolving:
- Platform identification and validation
- Execution mode selection
- Quality threshold configuration
- MCP availability for web platform
- Test suite discovery paths

## Task Instructions

### Questions to Resolve

**P0 (Blocking):**
1. What platform is this application? (web|mobile|desktop|api)
   - Options: web, mobile, desktop, api
   - Context: Determines test execution strategy and tooling
   - Default: Infer from project structure

2. Is Playwright MCP connected? (if platform=web)
   - Options: yes, no, unknown
   - Context: Required for E2E tests in Phase 3
   - Action if no: BLOCK with setup instructions

**P1 (Important):**
3. What execution mode should be used?
   - Options: testing, standalone, full
   - Context: Determines workflow scope
   - Default: full

4. Should default pyramid ratios be used (70/20/10)?
   - Options: yes, custom
   - Context: Affects test allocation strategy
   - Default: yes

5. Should default quality gates be used?
   - Options: yes, custom
   - Context: G1-G4 thresholds
   - Default: yes

**P2 (Clarifying):**
6. Where are test files located?
   - Context: Test discovery paths
   - Default: Standard paths (test/, __tests__, spec/)

### Validation

Once answers received:
- [ ] Platform validated and documented
- [ ] Mode set
- [ ] Pyramid ratios configured (sum = 1.0)
- [ ] Quality gates defined
- [ ] MCP availability confirmed (if web)
- [ ] Test paths identified

### Output

Document in memory file:
```yaml
platform_id: {platform}
mode: {mode}
pyramid_ratios:
  unit: {ratio}
  integration: {ratio}
  e2e: {ratio}
quality_gates:
  unit_coverage: {threshold}
  unit_pass_rate: {threshold}
  integration_pass_rate: {threshold}
  e2e_pass_rate: {threshold}
  overall_quality: {threshold}
mcp_available: {true|false}  # if web
test_paths: {list}
```

## Related Research Terms
- QA orchestration
- testing pyramid
- quality gates
- platform-agnostic testing
- Playwright MCP
- test discovery
- code coverage thresholds
- pass rate metrics
- E2E testing
- integration testing

## Output Requirements

**Memory File:** `.claude/memory/task-perform-qa-analysis-clarification-memory.md`

**Must Include:**
- Platform identification result
- Mode selection
- Configured pyramid ratios
- Quality gate thresholds
- MCP availability status (if web)
- Test suite discovery results
```

## Quality Gate G1

**Criteria:**
- Platform identified and validated
- Mode set
- Pyramid ratios configured (sum = 1.0)
- Quality gates defined
- MCP available if platform=web
- Test paths discovered

**Validation:**
- If G1 fails, HALT with clear error
- If G1 passes, proceed to Phase 1

## Next Phase

Upon successful clarification and G1 validation, advance to **Phase 1: Unit Orchestration**.
