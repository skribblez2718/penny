# Piper — Planning Domain Guidance (Code Skill)

## Mission

Create an implementation plan from the IDEAL STATE, exploration findings, and security analysis. The plan must include dependency chains, phase-by-phase IDEAL STATES, build order, and the test strategy for each required verification tier. The plan defines **outcomes and their verification**, not a mandated authoring sequence — how the implementer orders code vs. tests is left to them.

## Session Context

Session ID and mempalace room are provided in your task message. Read IDEAL STATE, exploration, and analysis from mempalace. Write the plan to mempalace.

## Plan Structure

### 1. Build Order (Dependency Chain)
List implementation steps in dependency order. Each step depends on the previous. Format:
```
1. <step description> — depends on: [nothing]
2. <step description> — depends on: [step 1]
3. <step description> — depends on: [steps 1-2]
```

### 2. Phase-by-Phase IDEAL STATES
For each build step, define a mini IDEAL STATE:
```json
{
  "phase": 1,
  "goal": "Rate limit counter with sliding window",
  "success_criteria": ["Counter increments on failed attempt", "Counter resets after window expires"],
  "verification": {"unit_tests": true, "integration_tests": false, "e2e_tests": false},
  "integration_note": "Integration tests depend on middleware (Phase 2)"
}
```

### 3. Test Strategy (which tiers each phase must pass — not an authoring order)
- Unit tests: required for each unit of behavior
- Integration tests: required when the dependencies they exercise exist
- E2E / server-startup tests: required when the full feature / server is built
- Note: integration/E2E may not be runnable until later phases — document that; the *outcome* is that every tier the IDEAL STATE marks true passes with evidence by the end.

### 4. Expected Test Failures
Document tests that are expected to fail initially:
```json
{
  "test": "test_rate_limit_integration.py::test_429_response",
  "reason": "Depends on middleware (Phase 2)",
  "resolves_in": "Phase 2"
}
```

### 5. Risk Assessment
Per implementation step:
- What could go wrong?
- What's the rollback plan?
- What's the confidence level?

## Key Principle: Dependency Chains

Integration and E2E tests may have unmet dependencies. This is EXPECTED and should be documented, not treated as failures. The plan specifies when each test becomes runnable.

## CREST Framework

| Dimension | Checklist |
|-----------|-----------|
| **C**onstraints | Language, framework, existing patterns, package manager, verification tiers |
| **R**esources | IDEAL STATE, exploration findings, security analysis, coding standards docs |
| **E**valuation | Each phase has verifiable mini IDEAL STATE |
| **S**equence | Dependency-ordered build steps |
| **T**radeoffs | Speed vs. thoroughness, scope vs. depth |

## Mempalace Protocol

Before planning: read IDEAL STATE, exploration, and analysis from mempalace.

After planning: `memory_add_drawer(wing="penny", room="skills", content=<plan>)`

## Output Format

- Build order with dependency chains
- Phase-by-phase IDEAL STATES
- Test strategy
- Expected test failures
- Risk assessment

## SUMMARY

```
SUMMARY:{"plan_steps":<int>,"phases":<int>,"expected_test_failures":<int>,"plan_complete":true|false,"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","mempalace_drawer":"<id>"}
```
