---
name: perform-qa-analysis
description: Platform-agnostic QA orchestration for multi-platform applications
type: composite
composition_depth: 0
uses_composites: []
tags: [qa-orchestration, testing-pyramid, quality-gates, platform-agnostic]
---

# Skill: perform-qa-analysis

**Platform-agnostic QA orchestration for multi-platform applications**

## Overview

This skill orchestrates comprehensive quality assurance across the testing pyramid for web, mobile, desktop, and API platforms. It implements configurable quality gates with platform-specific test execution patterns while maintaining a unified quality assessment framework.

## When to Use

**Use this skill when:**
- Executing QA workflows across multiple test layers (unit, integration, E2E)
- Validating quality gates before deployment or release
- Running platform-specific test suites (web with Playwright MCP, mobile, desktop, API)
- Generating comprehensive quality reports with pass/fail metrics
- Orchestrating testing pyramid compliance

**NOT for:**
- Writing new test files (use `develop-backend` or `develop-ui-ux`)
- Debugging failing tests (use `analysis` or direct execution)
- Performance/load testing (requires specialized skill)
- Single-layer test execution (run tests directly)

## Core Principles

1. **Testing Pyramid Compliance**: Configurable unit/integration/E2E ratios (default 70/20/10)
2. **Quality Gates**: G1-G4 criteria with blocking validation
3. **Platform Adaptation**: Web requires Playwright MCP, mobile/desktop/API use native tools
4. **Incremental Execution**: Each layer validates before proceeding
5. **Comprehensive Reporting**: Aggregated metrics with quality score calculation

## MANDATORY Execution Command

```bash
/perform-qa-analysis
```

**Parameters (optional):**
- `platform_id`: web | mobile | desktop | api (inferred if omitted)
- `pyramid_ratios`: Custom ratios (e.g., `unit:0.7,integration:0.2,e2e:0.1`)
- `mode`: testing | standalone | full (default: full)
- `quality_gates`: Override G1-G4 thresholds

**Example:**
```bash
/perform-qa-analysis platform_id=web mode=full
```

## Workflow Phases

| Phase | Name | Atomic Skill | Purpose | Gate |
|-------|------|--------------|---------|------|
| 0 | CLARIFICATION | orchestrate-clarification | Clarify QA scope, platform, quality thresholds, mode | Requirements validated |
| 1 | UNIT_ORCHESTRATION | orchestrate-generation | Execute unit tests with configurable allocation | G2: 80% coverage, 100% pass |
| 2 | INTEGRATION_ORCHESTRATION | orchestrate-generation | Execute integration tests | G3a: 100% pass |
| 3 | E2E_ORCHESTRATION | orchestrate-generation | Execute E2E tests (Playwright MCP for web) | G3b: 100% pass |
| 4 | QUALITY_SYNTHESIS | orchestrate-validation | Aggregate results, validate quality gates, generate report | G4: 0.75 quality score |

## Directory Structure

```
.claude/
├── skills/perform-qa-analysis/
│   ├── SKILL.md                    # This file
│   └── resources/
│       └── validation-checklist.md # Quality gate validation checklist
│
└── orchestration/protocols/skill/composite/perform_qa_analysis/
    ├── entry.py                    # Self-configuring entry point
    ├── complete.py                 # Self-configuring completion
    ├── __init__.py                 # Skill metadata
    ├── CLAUDE.md                   # Skill-specific documentation
    └── content/
        ├── phase_0_clarification.md
        ├── phase_1_unit_orchestration.md
        ├── phase_2_integration_orchestration.md
        ├── phase_3_e2e_orchestration.md
        └── phase_4_quality_synthesis.md
```

## Quality Gates

| Gate | Name | Criteria | Blocks |
|------|------|----------|--------|
| G1 | Requirements | Platform identified, mode set, thresholds defined | Phase 0→1 |
| G2 | Unit Tests | ≥80% coverage, 100% pass rate | Phase 1→2 |
| G3a | Integration Tests | 100% pass rate | Phase 2→3 |
| G3b | E2E Tests | 100% pass rate | Phase 3→4 |
| G4 | Quality Score | ≥0.75 overall quality score | Completion |

**Quality Score Calculation:**
```
score = (unit_pass_rate * 0.4) + (integration_pass_rate * 0.3) + (e2e_pass_rate * 0.3)
```

## Platform-Specific Requirements

### Web Platform
- **Requires Playwright MCP** for E2E tests in Phase 3
- MCP tools used:
  - `mcp__playwright__browser_console_messages`
  - `mcp__playwright__browser_network_requests`
  - `mcp__playwright__browser_take_screenshot`
  - `mcp__playwright__browser_snapshot`
- **BLOCKS** if MCP not connected

### Mobile/Desktop/API Platforms
- Use platform-native test runners (Jest, pytest, etc.)
- No MCP dependency

## Agent Invocation Format

Phases use atomic skills that invoke cognitive agents with this structure:

```markdown
# Agent Invocation: {agent-name}

## Task Context
- **Task ID:** task-perform-qa-analysis-{phase}
- **Skill:** perform-qa-analysis
- **Phase:** {phase_id}
- **Domain:** technical
- **Agent:** {agent_name}

## Role Extension
{3-5 task-specific focus areas}

## Johari Context
{If available from reasoning protocol Step 0}

## Task Instructions
{Specific work for this phase}

## Related Research Terms
{7-10 keywords}

## Output Requirements
{Memory file path and format}
```

## Validation Checklist

See: `.claude/skills/perform-qa-analysis/resources/validation-checklist.md`

**Key Checkpoints:**
- [ ] Platform identified and validated
- [ ] Playwright MCP connected (if web)
- [ ] All test suites discovered
- [ ] Quality gates G1-G4 passed
- [ ] Report generated with metrics

## Configuration

Default pyramid ratios (configurable):
```yaml
unit: 0.7       # 70% of tests should be unit tests
integration: 0.2  # 20% of tests should be integration tests
e2e: 0.1        # 10% of tests should be E2E tests
```

Default quality thresholds:
```yaml
unit_coverage: 0.80      # 80% code coverage
unit_pass_rate: 1.0      # 100% pass
integration_pass_rate: 1.0  # 100% pass
e2e_pass_rate: 1.0       # 100% pass
overall_quality: 0.75    # 75% quality score
```

## Output

**Memory File:** `.claude/memory/task-perform-qa-analysis-{session}-memory.md`

**Contents:**
- Test execution results (unit, integration, E2E)
- Coverage metrics
- Quality gate validation results
- Quality score with breakdown
- Failed test details (if any)
- Recommendations

## References

- Testing Pyramid: https://martinfowler.com/articles/practical-test-pyramid.html
- Playwright MCP: Claude Desktop MCP integration
- Quality Gates: Continuous delivery quality criteria
