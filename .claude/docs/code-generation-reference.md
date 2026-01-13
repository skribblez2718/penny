# Code Generation Reference Guide

**Purpose:** Reference documentation for code generation using cognitive agents (GENERATION and VALIDATION)

---

## Overview

This extended protocol applies when:
- The GENERATION agent is creating code artifacts
- The VALIDATION agent is verifying code quality
- Task context indicates programming/scripting/configuration needs
- Quality standards include "testable", "secure", or "production-ready"

---

## Code Context Classification by Domain

### Technical Domain

- **Types:** API, library, system, tool, framework
- **Standards:** TDD, SOLID, DRY, KISS, YAGNI
- **Security:** OWASP, input validation, auth/authz
- **Language Stack:** Python, Go, Rust, TypeScript

### Personal Domain

- **Types:** automation, tracker, assistant, organizer
- **Standards:** simplicity, reliability, maintainability
- **Security:** data privacy, local storage, credential safety
- **Language Stack:** Python, JavaScript, Bash, PowerShell

### Creative Domain

- **Types:** generative, visualization, interactive, artistic
- **Standards:** expressiveness, performance, user experience
- **Security:** content filtering, rate limiting
- **Language Stack:** Processing, p5.js, Python, JavaScript

### Professional Domain

- **Types:** enterprise, reporting, integration, analytics
- **Standards:** compliance, audit trails, documentation
- **Security:** SOC2, GDPR, encryption, access control
- **Language Stack:** Java, C#, Python, SQL

### Recreational Domain

- **Types:** game, simulator, bot, utility
- **Standards:** fun, engagement, accessibility
- **Security:** fair play, anti-cheat, safe multiplayer
- **Language Stack:** Python, JavaScript, Lua, GDScript

---

## Test Coverage Targets

| Domain | Target Coverage |
|--------|-----------------|
| Technical | 85% |
| Personal | 70% |
| Creative | 60% |
| Professional | 90% |
| Recreational | 65% |

---

## Domain-Specific Test Patterns

### Technical

- Unit tests for algorithms
- Integration tests for systems
- Performance benchmarks
- Load tests
- Security penetration tests

### Personal

- Validation of personal data handling
- Privacy preservation tests
- Automation reliability tests
- Data persistence tests

### Creative

- Output quality validation
- User experience tests
- Performance under creative load
- Aesthetic consistency checks

### Professional

- Business logic validation
- Compliance verification
- Data integrity tests
- Audit trail completeness

### Recreational

- Gameplay mechanics validation
- Fun factor metrics
- Fairness tests
- Player safety checks

---

## GENERATION Agent Workflow

### Process Steps

1. **Determine code context** - Identify domain and requirements
2. **Select technology stack** - Match domain stack
3. **Python initialization** - If Python: run uv setup sequence
4. **Apply TDD cycle** - Generate tests first
5. **Implement to pass tests** - Minimal code
6. **Refactor for quality** - Clean up
7. **Apply security patterns** - OWASP checklist
8. **Structure appropriately** - Domain architecture
9. **Document thoroughly** - API docs, README

### Progressive Enhancement

1. **MVP:** Minimal working implementation
2. **TESTS:** Add comprehensive test coverage
3. **SECURITY:** Apply security controls
4. **PERFORMANCE:** Optimize for efficiency
5. **USABILITY:** Enhance user experience
6. **MAINTENANCE:** Improve maintainability

---

## VALIDATION Agent Workflow

### Validation Areas

| Area | Checks |
|------|--------|
| Functional | Run all tests |
| Coverage | Verify meets domain target |
| Security | Run security scan |
| Quality | Analyze code quality metrics |
| Documentation | Check completeness |
| Standards | Verify compliance |

### Quality Metrics

| Metric | Target |
|--------|--------|
| Cyclomatic complexity (max) | 10 |
| Cognitive complexity (max) | 15 |
| Maintainability index (min) | 70 |
| Code duplication (max) | 5% |
| Security vulnerabilities | 0 |
| Security warnings (max) | 5 |
| Public API documentation | 100% |

---

## Quick Reference Checklists

### Before Starting Code Generation

- [ ] Requirements clear and testable
- [ ] Domain context understood
- [ ] Technology stack appropriate
- [ ] Security requirements identified
- [ ] Test framework selected

### During Code Generation

- [ ] Write tests first (RED)
- [ ] Implement minimally (GREEN)
- [ ] Refactor for quality (REFACTOR)
- [ ] Apply security controls
- [ ] Document thoroughly

### After Code Generation

- [ ] All tests passing
- [ ] Coverage meets target
- [ ] Security scan clean
- [ ] Documentation complete
- [ ] Code structure logical

### For Python Projects

- [ ] Virtual environment created with `uv venv`
- [ ] `pyproject.toml` exists with dependencies
- [ ] All commands use `uv run` prefix
- [ ] No pip install anywhere
- [ ] All imports are absolute (no relative imports)

---

## Related Documentation

- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/code-generation/` - Execution step files
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/code-generation/python-project-setup.md` - Python/uv requirements
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/code-generation/tdd-protocol.md` - TDD cycle
- `${CAII_DIRECTORY}/.claude/orchestration/shared-content/code-generation/security-patterns.md` - Security patterns
