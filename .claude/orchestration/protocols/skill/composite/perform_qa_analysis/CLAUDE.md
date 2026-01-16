# Perform QA Analysis Skill

**Type:** Composite
**Composition Depth:** 0
**Uses Composites:** None

## Overview

Platform-agnostic quality assurance orchestration across the testing pyramid (unit, integration, E2E) with quality gate validation and comprehensive reporting.

## Phases

| Phase | Name | Type | Atomic Skill | Next |
|-------|------|------|--------------|------|
| 0 | CLARIFICATION | LINEAR | orchestrate-clarification | 1 |
| 1 | UNIT_ORCHESTRATION | LINEAR | orchestrate-generation | 2 |
| 2 | INTEGRATION_ORCHESTRATION | LINEAR | orchestrate-generation | 3 |
| 3 | E2E_ORCHESTRATION | LINEAR | orchestrate-generation | 4 |
| 4 | QUALITY_SYNTHESIS | LINEAR | orchestrate-validation | None |

## Quality Gates

| Gate | Phase | Criteria | Blocks |
|------|-------|----------|--------|
| G1 | 0→1 | Requirements validated (platform, mode, thresholds) | YES |
| G2 | 1→2 | Unit: ≥80% coverage, 100% pass | YES |
| G3a | 2→3 | Integration: 100% pass | YES |
| G3b | 3→4 | E2E: 100% pass | YES |
| G4 | Completion | Quality score ≥0.75 | YES |

## Platform-Specific Behavior

### Web Platform
- **Phase 3 (E2E):** Requires Playwright MCP
- **MCP Tools Used:**
  - `mcp__playwright__browser_console_messages`
  - `mcp__playwright__browser_network_requests`
  - `mcp__playwright__browser_take_screenshot`
  - `mcp__playwright__browser_snapshot`
- **Blocking:** If MCP unavailable, Phase 3 fails with error

### Mobile/Desktop/API Platforms
- Use platform-native test runners
- No MCP dependency

## Configuration Parameters

```yaml
platform_id: web|mobile|desktop|api  # Required (inferred or explicit)
mode: testing|standalone|full        # Default: full
pyramid_ratios:
  unit: 0.7        # 70% unit tests
  integration: 0.2  # 20% integration tests
  e2e: 0.1         # 10% E2E tests
quality_gates:
  unit_coverage: 0.80
  unit_pass_rate: 1.0
  integration_pass_rate: 1.0
  e2e_pass_rate: 1.0
  overall_quality: 0.75
```

## State Transitions

```
INITIALIZED
    ↓
CLARIFICATION (Phase 0)
    ↓ [G1 pass]
UNIT_ORCHESTRATION (Phase 1)
    ↓ [G2 pass]
INTEGRATION_ORCHESTRATION (Phase 2)
    ↓ [G3a pass]
E2E_ORCHESTRATION (Phase 3)
    ↓ [G3b pass]
QUALITY_SYNTHESIS (Phase 4)
    ↓ [G4 pass]
COMPLETED
```

## Memory File Output

**Path:** `.claude/memory/task-perform-qa-analysis-{session}-memory.md`

**Structure:**
```markdown
# QA Analysis Report: {platform}

## Section 0: Configuration
- Platform: {platform_id}
- Mode: {mode}
- Pyramid Ratios: {ratios}

## Section 1: Unit Test Results
- Coverage: {percentage}%
- Pass Rate: {percentage}%
- Failed Tests: {count}

## Section 2: Integration Test Results
- Pass Rate: {percentage}%
- Failed Tests: {count}

## Section 3: E2E Test Results
- Pass Rate: {percentage}%
- Failed Tests: {count}
- Screenshots: {paths}

## Section 4: Quality Assessment
- Quality Score: {score}
- Gate Status: G1-G4
- Recommendations: {list}
```

## Error Handling

| Error | Phase | Action |
|-------|-------|--------|
| MCP unavailable | 3 | HALT with error, provide fallback instructions |
| Test runner missing | 1-3 | HALT with error, provide installation instructions |
| Quality gate fail | 1-4 | Document failure, provide recommendations, HALT |
| Platform unknown | 0 | Request clarification |

## Integration Points

### Upstream Skills
- `develop-backend` - Creates tests this skill executes
- `develop-ui-ux` - Creates E2E tests for web platform
- `develop-requirements` - Defines quality requirements

### Downstream Skills
- `orchestrate-validation` - Validates quality reports
- `develop-learnings` - Captures testing insights

## Usage Examples

### Example 1: Web Application QA
```bash
/perform-qa-analysis platform_id=web mode=full
```

### Example 2: API Testing Only
```bash
/perform-qa-analysis platform_id=api mode=testing
```

### Example 3: Custom Pyramid Ratios
```bash
/perform-qa-analysis pyramid_ratios="unit:0.6,integration:0.3,e2e:0.1"
```

## Learnings Integration

After completion, skill may invoke `develop-learnings` to capture:
- Platform-specific test patterns
- Quality gate calibration insights
- Common test failure modes
- Performance optimization opportunities
